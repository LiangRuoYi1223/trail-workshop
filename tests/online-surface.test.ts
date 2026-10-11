import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { writeArrayBuffer, type GeotiffWriterMetadata } from 'geotiff';
import { loadSentinelColorImage } from '../src/appearance/online.js';

const bounds={west:3,south:0,east:3.00035,north:.00035};
const bucket='https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/';
const now=()=>new Date('2026-10-10T12:00:00Z');
const loader=async()=>loadSentinelColorImage;
function tiff(rgb=true, values?:number[], overrides:GeotiffWriterMetadata={}):Uint8Array {
  const width=rgb?4:2,height=width;
  const data=values??(rgb?Array.from({length:16},()=>[30,140,40]).flat():[4,4,4,4]);
  return new Uint8Array(writeArrayBuffer(new Uint8Array(data),{width,height,
    BitsPerSample:rgb?[8,8,8]:[8],SampleFormat:rgb?[1,1,1]:[1],PhotometricInterpretation:rgb?2:1,
    GTModelTypeGeoKey:1,ProjectedCSTypeGeoKey:32631,GTRasterTypeGeoKey:1,
    ModelPixelScale:rgb?[10,10,0]:[20,20,0],ModelTiepoint:[0,0,0,500000,40,0],...overrides}));
}
function scene(id:string,cloud=0,visual=bucket+id+'/TCI.tif',scl=bucket+id+'/SCL.tif') {
  return {type:'Feature',id,collection:'sentinel-2-c1-l2a',bbox:[2.99,-.01,3.01,.01],
    geometry:{type:'Polygon',coordinates:[[[2.99,-.01],[3.01,-.01],[3.01,.01],[2.99,.01],[2.99,-.01]]]},
    properties:{datetime:'2026-10-01T10:00:00Z','eo:cloud_cover':cloud,'proj:epsg':32631},
    assets:{visual:{href:visual,type:'image/tiff; application=geotiff; profile=cloud-optimized'},scl:{href:scl,type:'image/tiff; application=geotiff; profile=cloud-optimized'}}};
}
function remote(features:ReturnType<typeof scene>[],assets:Record<string,Uint8Array>,mode:'normal'|'full'|'wrong-range'='normal',queryBounds=bounds) {
  let requests=0,rangedBytes=0,queryDatetime='';
  const fetch=async (input:string|URL|Request,init?:RequestInit):Promise<Response>=>{
    requests++;
    const url=String(input);
    if(url==='https://earth-search.aws.element84.com/v1/search') {
      const query=JSON.parse(String(init?.body));
      queryDatetime=query.datetime;
      assert.deepEqual(query.collections,['sentinel-2-c1-l2a']);
      assert.deepEqual(query.bbox,[queryBounds.west,queryBounds.south,queryBounds.east,queryBounds.north]);
      assert.deepEqual(query.sortby,[{field:'properties.eo:cloud_cover',direction:'asc'},{field:'properties.datetime',direction:'desc'}]);
      return Response.json({type:'FeatureCollection',features,links:[]});
    }
    const bytes=assets[url];assert.ok(bytes,`unexpected asset ${url}`);
    const range=new Headers(init?.headers).get('range');assert.match(range??'',/^bytes=\d+-\d+$/u);
    const [start,wantedEnd]=range!.slice(6).split('-').map(Number),end=Math.min(wantedEnd,bytes.length-1);
    assert.ok(wantedEnd-start+1<=4*1024*1024,'remote range must stay bounded');
    rangedBytes+=end-start+1;
    if(mode==='full') return new Response(bytes as unknown as BodyInit,{status:200});
    return new Response(bytes.slice(start,end+1) as unknown as BodyInit,{status:206,headers:{
      'content-range':`bytes ${mode==='wrong-range'?start+1:start}-${end}/${bytes.length}`,
      'content-length':String(end-start+1)}});
  };
  return {fetch,get requests(){return requests;},get rangedBytes(){return rangedBytes;},get queryDatetime(){return queryDatetime;}};
}
async function withCache(run:(cacheDir:string)=>Promise<void>) {
  const base=resolve('artifacts/auto-core-test-cache');await mkdir(base,{recursive:true});
  const directory=await mkdtemp(join(base,'trail-online-'));
  try {await run(directory);} finally {
    assert.equal(dirname(resolve(directory)),base);assert.ok(basename(directory).startsWith('trail-online-'));
    await rm(directory,{recursive:true,force:true});
  }
}
function hugeStrip(rowsPerStrip=10000,northing=40):Uint8Array {
  const bytes=tiff(true,undefined,{ModelTiepoint:[0,0,0,500000,northing,0]}),view=new DataView(bytes.buffer),little=view.getUint16(0,false)===0x4949,ifd=view.getUint32(4,little);
  for(let index=0;index<view.getUint16(ifd,little);index++) {
    const entry=ifd+2+index*12,tag=view.getUint16(entry,little);
    if([256,257,278].includes(tag)) {view.setUint16(entry+2,4,little);view.setUint32(entry+4,1,little);view.setUint32(entry+8,tag===278?rowsPerStrip:10000,little);}
  }
  return bytes;
}
function goodRemote() {return remote([scene('clear')],{[bucket+'clear/TCI.tif']:tiff(),[bucket+'clear/SCL.tif']:tiff(false)});}
const code=(expected:string)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code===expected);

test('automatic UTM RGB crop aligns with projected SCL and returns geographic content identity',async()=>{
  const load=await loader();const server=goodRemote();
  await withCache(async cacheDir=>{
    const result=await load(bounds,{cacheDir,fetch:server.fetch,now});
    assert.deepEqual(result.image.sample(.000315,3.000045),{r:30,g:140,b:40});
    assert.equal(result.image.sample(.001,3),null);
    assert.deepEqual(result.image.metadata.bounds,bounds);
    assert.equal(result.image.metadata.crs,'EPSG:4326');
    assert.match(result.image.metadata.sha256,/^[a-f0-9]{64}$/u);
    assert.deepEqual(result.source.scenes.map(s=>s.id),['clear']);
    assert.equal(result.source.cacheHit,false);
    assert.deepEqual(result.source.bounds,bounds);
    assert.equal(result.source.provider,'Sentinel-2');assert.equal(result.source.collection,'sentinel-2-c1-l2a');
    assert.equal(result.source.attribution,'Contains modified Copernicus Sentinel data 2026');
  });
});

test('12-month acquisition emits the requested catalog interval',async()=>{
  await withCache(async cacheDir=>{
    const server=goodRemote();
    await loadSentinelColorImage(bounds,{cacheDir,fetch:server.fetch,now,...{lookbackMonths:12 as const}});
    assert.equal(server.queryDatetime,'2025-10-10T12:00:00.000Z/2026-10-10T12:00:00.000Z');
  });
});

test('omitted and explicit 24-month horizons retain the wider catalog interval',async()=>{
  for(const options of [{},{lookbackMonths:24 as const}])await withCache(async cacheDir=>{
    const server=goodRemote();
    await loadSentinelColorImage(bounds,{cacheDir,fetch:server.fetch,now,...options});
    assert.equal(server.queryDatetime,'2024-10-10T12:00:00.000Z/2026-10-10T12:00:00.000Z');
  });
});

test('12-month acquisition excludes older scenes even if the catalog returns them',async()=>{
  const old={...scene('old',0),properties:{...scene('old').properties,datetime:'2025-05-01T10:00:00Z'}};
  const recent=scene('recent',6);
  await withCache(async cacheDir=>{
    const server=remote([old,recent],{
      [bucket+'old/TCI.tif']:tiff(),[bucket+'old/SCL.tif']:tiff(false),
      [bucket+'recent/TCI.tif']:tiff(true,Array.from({length:16},()=>[120,80,60]).flat()),[bucket+'recent/SCL.tif']:tiff(false)});
    const result=await loadSentinelColorImage(bounds,{cacheDir,fetch:server.fetch,now,...{lookbackMonths:12 as const}});
    assert.deepEqual(result.source.scenes.map(item=>item.id),['recent']);
    assert.deepEqual(result.image.sample(.000315,3.000045),{r:120,g:80,b:60});
  });
});

test('12-month cache lookup rejects older 24-month imagery without a network request',async()=>{
  const old={...scene('old'),properties:{...scene('old').properties,datetime:'2025-05-01T10:00:00Z'}};
  await withCache(async cacheDir=>{
    const server=remote([old],{[bucket+'old/TCI.tif']:tiff(),[bucket+'old/SCL.tif']:tiff(false)});
    await loadSentinelColorImage(bounds,{cacheDir,fetch:server.fetch,now});
    const offlineFetch=async()=>{throw new Error('offline must not fetch');};
    await assert.rejects(loadSentinelColorImage(bounds,{cacheDir,offlineOnly:true,fetch:offlineFetch,now,...{lookbackMonths:12 as const}}),code('IMAGE_CACHE_MISS'));
    const wider=await loadSentinelColorImage(bounds,{cacheDir,offlineOnly:true,fetch:offlineFetch,now,...{lookbackMonths:24 as const}});
    assert.equal(wider.source.cacheHit,true);
    assert.deepEqual(wider.source.scenes.map(item=>item.id),['old']);
  });
});

for(const value of [0,18,'12',null])test(`invalid acquisition horizon ${JSON.stringify(value)} rejects before cache or network access`,async()=>{
  await withCache(async root=>{
    const cacheDir=join(root,'unused-cache'),server=goodRemote();
    await assert.rejects(loadSentinelColorImage(bounds,{cacheDir,fetch:server.fetch,now,lookbackMonths:value as 12|24}),code('IMAGE_REQUEST_INVALID'));
    assert.equal(server.requests,0);
    await assert.rejects(readdir(cacheDir),{code:'ENOENT'});
  });
});

test('clouds and missing pixels cause explicit failure instead of invented rock coverage',async()=>{
  const load=await loader();
  for(const invalid of [0,1,3,8,9,10,12]) await withCache(async cacheDir=>{
    const server=remote([scene('cloud')],{[bucket+'cloud/TCI.tif']:tiff(),[bucket+'cloud/SCL.tif']:tiff(false,[invalid,4,4,4])});
    await assert.rejects(load(bounds,{cacheDir,fetch:server.fetch,now}),code('IMAGE_COVERAGE_INSUFFICIENT'));
    assert.equal((await readdir(cacheDir)).filter(name=>name.endsWith('.json')).length,0);
  });
  await withCache(async cacheDir=>{
    const server=remote([scene('zero')],{[bucket+'zero/TCI.tif']:tiff(true,Array(48).fill(0)),[bucket+'zero/SCL.tif']:tiff(false)});
    await assert.rejects(load(bounds,{cacheDir,fetch:server.fetch,now}),code('IMAGE_COVERAGE_INSUFFICIENT'));
  });
});

test('partially cloudy scenes form a fully covered mosaic with all contributing dates',async()=>{
  const load=await loader();
  const server=remote([scene('first'),scene('second',1)],{
    [bucket+'first/TCI.tif']:tiff(),[bucket+'first/SCL.tif']:tiff(false,[8,4,8,4]),
    [bucket+'second/TCI.tif']:tiff(true,Array.from({length:16},()=>[120,80,60]).flat()),
    [bucket+'second/SCL.tif']:tiff(false,[4,8,4,8])});
  await withCache(async cacheDir=>{
    const result=await load(bounds,{cacheDir,fetch:server.fetch,now});
    assert.deepEqual(result.image.sample(.000315,3.000045),{r:120,g:80,b:60});
    assert.deepEqual(result.image.sample(.000315,3.000315),{r:30,g:140,b:40});
    assert.deepEqual(result.source.scenes.map(s=>s.id),['first','second']);
  });
});

test('adjacent UTM tiles cover the complete AOI without stretching one tile into the missing half',async()=>{
  const load=await loader();
  const left={...scene('S2A_T31NAA_left'),bbox:[2.99,-.01,3.00018,.01]},right={...scene('S2A_T31NAB_right'),bbox:[3.00017,-.01,3.01,.01]};
  const leftRgb=tiff(true,Array.from({length:8},()=>[30,140,40]).flat(),{width:2,height:4});
  const rightRgb=tiff(true,Array.from({length:8},()=>[120,80,60]).flat(),{width:2,height:4,ModelTiepoint:[0,0,0,500020,40,0]});
  const server=remote([left,right],{
    [bucket+left.id+'/TCI.tif']:leftRgb,[bucket+left.id+'/SCL.tif']:tiff(false,[4,4],{width:1,height:2}),
    [bucket+right.id+'/TCI.tif']:rightRgb,[bucket+right.id+'/SCL.tif']:tiff(false,[4,4],{width:1,height:2,ModelTiepoint:[0,0,0,500020,40,0]})});
  await withCache(async cacheDir=>{
    const result=await load(bounds,{cacheDir,fetch:server.fetch,now});
    assert.deepEqual(result.image.sample(.000315,3.000045),{r:30,g:140,b:40});
    assert.deepEqual(result.image.sample(.000315,3.000315),{r:120,g:80,b:60});
    assert.equal(result.source.scenes.length,2);
  });
});

test('recent low-cloud scenes take priority over much older scenes with a slightly lower tile cloud score',async()=>{
  const load=await loader();
  const old={...scene('old',0),properties:{...scene('old').properties,datetime:'2024-10-30T10:00:00Z'}};
  const recent={...scene('recent',2),properties:{...scene('recent',2).properties,datetime:'2026-10-09T10:00:00Z'}};
  const server=remote([old,recent],{
    [bucket+'old/TCI.tif']:tiff(),[bucket+'old/SCL.tif']:tiff(false),
    [bucket+'recent/TCI.tif']:tiff(true,Array.from({length:16},()=>[120,80,60]).flat()),[bucket+'recent/SCL.tif']:tiff(false)});
  await withCache(async cacheDir=>{
    const result=await load(bounds,{cacheDir,fetch:server.fetch,now});
    assert.deepEqual(result.source.scenes.map(item=>item.id),['recent']);
    assert.deepEqual(result.image.sample(.000315,3.000045),{r:120,g:80,b:60});
  });
});

test('missing coverage along the AOI boundary is rejected even when every output center is covered',async()=>{
  const load=await loader();const area={...bounds,east:3.00039};
  await withCache(async cacheDir=>{
    // The eastern output center lies inside the40m source, but the43.4m requested edge does not.
    const server=remote([scene('border')],{[bucket+'border/TCI.tif']:tiff(),[bucket+'border/SCL.tif']:tiff(false)},'normal',area);
    await assert.rejects(load(area,{cacheDir,fetch:server.fetch,now}),code('IMAGE_COVERAGE_INSUFFICIENT'));
    assert.equal((await readdir(cacheDir)).filter(name=>name.endsWith('.json')).length,0);
  });
});

test('verified offline cache reuses identical appearance bytes and hash without network',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    const first=await load(bounds,{cacheDir,fetch:goodRemote().fetch,now});
    const second=await load(bounds,{cacheDir,offlineOnly:true,fetch:async()=>{throw new Error('offline must not fetch');},now});
    assert.equal(second.source.cacheHit,true);
    assert.deepEqual(second.image.metadata,first.image.metadata);
    assert.deepEqual(second.image.sample(.000315,3.000045),first.image.sample(.000315,3.000045));
    await assert.rejects(load({...bounds,east:3.00037},{cacheDir,offlineOnly:true,now}),code('IMAGE_CACHE_MISS'));
  });
});

test('offline cache cannot bypass the24-month scene horizon or reuse future acquisitions',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    await load(bounds,{cacheDir,fetch:goodRemote().fetch,now});
    for(const date of ['2029-01-01T00:00:00Z','2025-01-01T00:00:00Z']) {
      await assert.rejects(load(bounds,{cacheDir,offlineOnly:true,now:()=>new Date(date)}),code('IMAGE_CACHE_MISS'));
    }
  });
});

test('corrupt or geographically altered cache is rejected offline and refetched online',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    await load(bounds,{cacheDir,fetch:goodRemote().fetch,now});
    const files=await readdir(cacheDir);const data=files.find(name=>name.endsWith('.rgb'));assert.ok(data);
    const payload=await readFile(join(cacheDir,data));payload[0]^=255;await writeFile(join(cacheDir,data),payload);
    await assert.rejects(load(bounds,{cacheDir,offlineOnly:true,now}),code('IMAGE_CACHE_MISS'));
    const repaired=await load(bounds,{cacheDir,fetch:goodRemote().fetch,now});assert.equal(repaired.source.cacheHit,false);
    const manifest=files.find(name=>name.endsWith('.json'));assert.ok(manifest);
    const json=JSON.parse(await readFile(join(cacheDir,manifest),'utf8'));json.bounds.west=2;await writeFile(join(cacheDir,manifest),JSON.stringify(json));
    await assert.rejects(load(bounds,{cacheDir,offlineOnly:true,now}),code('IMAGE_CACHE_MISS'));
  });
});

test('unsafe HTTPS asset destinations are rejected before an asset request',async()=>{
  const load=await loader();
  for(const url of ['http://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/a.tif','https://evil.example/a.tif','https://user@e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/a.tif','https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com:444/a.tif']) {
    await withCache(async cacheDir=>{
      const server=remote([scene('unsafe',0,url)],{});
      await assert.rejects(load(bounds,{cacheDir,fetch:server.fetch,now}),code('IMAGE_SOURCE_UNSAFE'));
      assert.equal(server.requests,1);
    });
  }
});

test('ignored or mismatched HTTP ranges fail without accepting a full satellite tile',async()=>{
  const load=await loader();
  for(const mode of ['full','wrong-range'] as const) await withCache(async cacheDir=>{
    const server=remote([scene('range')],{[bucket+'range/TCI.tif']:tiff(),[bucket+'range/SCL.tif']:tiff(false)},mode);
    await assert.rejects(load(bounds,{cacheDir,fetch:server.fetch,now}),code('IMAGE_RANGE_UNSUPPORTED'));
  });
});

test('oversized decoded TIFF strips are rejected before pixel allocation',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    const server=remote([scene('huge')],{[bucket+'huge/TCI.tif']:hugeStrip(),[bucket+'huge/SCL.tif']:tiff(false)});
    await assert.rejects(load(bounds,{cacheDir,fetch:server.fetch,now}),code('IMAGE_PIXEL_LIMIT'));
  });
});

test('a small requested output does not permit allocating a huge native source crop',async()=>{
  const load=await loader(),area={west:3,south:0,east:3.5,north:.5};
  await withCache(async cacheDir=>{
    const item={...scene('wide'),bbox:[2.99,-.01,4,1]};
    const server=remote([item],{[bucket+'wide/TCI.tif']:hugeStrip(1,100000),[bucket+'wide/SCL.tif']:tiff(false)},'normal',area);
    await assert.rejects(load(area,{cacheDir,fetch:server.fetch,now}),code('IMAGE_PIXEL_LIMIT'));
    assert.equal((await readdir(cacheDir)).filter(name=>name.endsWith('.json')).length,0);
  });
});

test('aborted automatic acquisition returns a retryable image error and leaves no completed cache',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    const controller=new AbortController();controller.abort();const server=goodRemote();
    await assert.rejects(load(bounds,{cacheDir,signal:controller.signal,fetch:server.fetch,now}),code('IMAGE_ABORTED'));
    assert.equal(server.requests,0);assert.equal((await readdir(cacheDir)).length,0);
  });
});

test('empty or stale catalog fails explicitly and does not invent an acquisition date',async()=>{
  const load=await loader();
  for(const features of [[],[{...scene('stale'),properties:{datetime:'2020-01-01T00:00:00Z','eo:cloud_cover':0,'proj:epsg':32631}}]]) {
    await withCache(async cacheDir=>{
      await assert.rejects(load(bounds,{cacheDir,fetch:remote(features,{}).fetch,now}),code('IMAGE_SCENE_UNAVAILABLE'));
    });
  }
});

test('nonuniform UTM rasters retain longitude, northing and scene-mask alignment in both hemispheres',async()=>{
  const load=await loader();
  // Independent WGS84 UTM reference: latitude +/-45 on zone51 central meridian123 has easting500000.
  for(const fixture of [
    {epsg:32651,northing:4982950.400226552,area:{west:123,east:123.00045,south:44.99965,north:45},top:44.999955,bottom:44.99969},
    {epsg:32751,northing:5017089.599773448,area:{west:123,east:123.00045,south:-45,north:-44.99965},top:-44.99969,bottom:-44.999955},
  ]) await withCache(async cacheDir=>{
    const transform={ProjectedCSTypeGeoKey:fixture.epsg,ModelTiepoint:[0,0,0,500000,fixture.northing,0]};
    const rgb=Array.from({length:16},(_,index)=>[20+Math.floor(index/4)*30,100+(index%4)*20,50]).flat();
    const features=[scene('mapped'),scene('fill',1)].map(item=>({...item,
      bbox:[122.99,fixture.area.south-.01,123.01,fixture.area.north+.01]}));
    const server=remote(features,{
      [bucket+'mapped/TCI.tif']:tiff(true,rgb,transform),[bucket+'mapped/SCL.tif']:tiff(false,[4,8,8,4],transform),
      [bucket+'fill/TCI.tif']:tiff(true,Array.from({length:16},()=>[120,80,60]).flat(),transform),
      [bucket+'fill/SCL.tif']:tiff(false,[8,4,4,8],transform)},'normal',fixture.area);
    const result=await load(fixture.area,{cacheDir,fetch:server.fetch,now});
    assert.deepEqual(result.image.sample(fixture.top,123.000045),{r:20,g:100,b:50});
    assert.deepEqual(result.image.sample(fixture.top,123.00041),{r:120,g:80,b:60});
    assert.deepEqual(result.image.sample(fixture.bottom,123.000045),{r:120,g:80,b:60});
    assert.deepEqual(result.image.sample(fixture.bottom,123.00041),{r:110,g:160,b:50});
  });
});

test('catalog streaming is bounded even when the server omits its response length',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    const fetch=async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(256*1024));}}));
    await assert.rejects(load(bounds,{cacheDir,fetch,now}),code('IMAGE_DOWNLOAD_LIMIT'));
    assert.equal((await readdir(cacheDir)).length,0);
  });
});

test('cancellation after catalog acquisition never commits a partial image cache',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    const controller=new AbortController(),server=goodRemote();
    await assert.rejects(load(bounds,{cacheDir,fetch:server.fetch,now,signal:controller.signal,
      onProgress:(event:{message:string})=>{if(event.message.includes('正在读取'))controller.abort();}}),code('IMAGE_ABORTED'));
    assert.equal(server.requests,1);assert.equal((await readdir(cacheDir)).length,0);
  });
});

test('a stalled network request reaches the acquisition timeout and stays retryable',async()=>{
  const load=await loader();
  await withCache(async cacheDir=>{
    const keepAlive=setInterval(()=>{},50);
    try {
      const fetch=async(_input:unknown,init:RequestInit={})=>new Promise<Response>((_resolve,reject)=>{
        init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});
      });
      await assert.rejects(load(bounds,{cacheDir,fetch,now,timeoutMs:10}),code('IMAGE_TIMEOUT'));
    } finally {clearInterval(keepAlive);}
    assert.equal((await readdir(cacheDir)).length,0);
  });
});

test('overlapping acquisitions reuse verified TIFF blocks and report download, cache and full coverage',async()=>{
  await withCache(async cacheDir=>{
    const events:Array<{progress:number;stage?:string;downloadedBytes?:number;cacheBytes?:number;requestCount?:number;coverage?:number}>=[];
    const first=goodRemote(),original=await loadSentinelColorImage(bounds,{cacheDir,fetch:first.fetch,now,onProgress:event=>events.push(event)});
    assert.equal(first.requests,3,'one catalog query and one validated range for each TIFF');
    assert.equal(events[0].stage,'query');assert.ok(events.some(event=>event.stage==='download'&&(event.downloadedBytes??0)>0));
    assert.ok(events.some(event=>event.stage==='cloud'));const completed=events.at(-1)!;
    assert.equal(completed.stage,'complete');assert.equal(completed.coverage,1);assert.equal(completed.requestCount,2);
    assert.equal(completed.downloadedBytes,first.rangedBytes);
    const overlap={...bounds,east:3.00034},second=remote([scene('clear')],{
      [bucket+'clear/TCI.tif']:tiff(),[bucket+'clear/SCL.tif']:tiff(false)},'normal',overlap);
    events.length=0;
    const reused=await loadSentinelColorImage(overlap,{cacheDir,fetch:second.fetch,now,onProgress:event=>events.push(event)});
    assert.equal(second.requests,1,'an overlapping crop only needs a fresh catalog query');
    assert.equal(events.at(-1)!.downloadedBytes,0);assert.equal(events.at(-1)!.requestCount,0);assert.ok(events.at(-1)!.cacheBytes!>0);
    assert.deepEqual(reused.image.sample(.000315,3.000045),original.image.sample(.000315,3.000045));
  });
});

test('a failed RGB request cancels its stalled scene-classification sibling',async()=>{
  await withCache(async cacheDir=>{
    const source=goodRemote(),controller=new AbortController();let siblingCancelled=false;
    let startSibling!:()=>void;const siblingStarted=new Promise<void>(resolve=>{startSibling=resolve;});
    const fetch:typeof globalThis.fetch=async(input,options)=>{
      if(String(input).endsWith('/TCI.tif')){await siblingStarted;return new Response(null,{status:503});}
      if(String(input).endsWith('/SCL.tif'))return new Promise<Response>((_resolve,reject)=>{
        startSibling();
        const abort=()=>{siblingCancelled=true;reject(options?.signal?.reason);};
        if(options?.signal?.aborted)abort();else options?.signal?.addEventListener('abort',abort,{once:true});
      });
      return source.fetch(input,options);
    };
    const keepAlive=setInterval(()=>{},50);
    try {await assert.rejects(loadSentinelColorImage(bounds,{cacheDir,fetch,now,timeoutMs:500,signal:controller.signal}),code('IMAGE_RANGE_UNSUPPORTED'));
      assert.equal(siblingCancelled,true);
    } finally {controller.abort();clearInterval(keepAlive);}
  });
});

test('completed image caches cannot be reused through a linked cache directory',async t=>{
  await withCache(async cacheDir=>{
    await loadSentinelColorImage(bounds,{cacheDir,fetch:goodRemote().fetch,now});
    const actual=join(cacheDir,'actual'),alias=join(cacheDir,'alias');await mkdir(actual);
    for(const file of await readdir(cacheDir))if(file.endsWith('.rgb')||file.endsWith('.json'))await copyFile(join(cacheDir,file),join(actual,file));
    try {await symlink(actual,alias,'junction');} catch(error) {
      if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Session cannot create directory links');return;}throw error;
    }
    await assert.rejects(loadSentinelColorImage(bounds,{cacheDir:alias,offlineOnly:true,now}),code('IMAGE_CACHE_MISS'));
  });
});
