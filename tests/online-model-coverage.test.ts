import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { loadSentinelColorImage } from '../src/appearance/online.js';

const bounds={west:3,south:0,east:3.00035,north:.00035};
const bucket='https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/';
const now=()=>new Date('2026-10-14T12:00:00Z');
const lowerRight=[{lat:.00004,lon:3.00023},{lat:.00004,lon:3.00031},{lat:.00011,lon:3.00031},{lat:.00011,lon:3.00023}];
const upperLeft=[{lat:.00023,lon:3.00004},{lat:.00023,lon:3.00011},{lat:.00031,lon:3.00011},{lat:.00031,lon:3.00004}];
function raster(rgb=true,scl=[8,4,4,4],color=[30,140,40]):Uint8Array {
  const width=rgb?4:2;
  return new Uint8Array(writeArrayBuffer(Uint8Array.from(rgb?Array.from({length:16},()=>color).flat():scl),{
    width,height:width,BitsPerSample:rgb?[8,8,8]:[8],SampleFormat:rgb?[1,1,1]:[1],PhotometricInterpretation:rgb?2:1,
    GTModelTypeGeoKey:1,ProjectedCSTypeGeoKey:32631,GTRasterTypeGeoKey:1,
    ModelPixelScale:rgb?[10,10,0]:[20,20,0],ModelTiepoint:[0,0,0,500000,40,0],
  }));
}
function scene(id:string,year=2026,cloud=0) {
  return {type:'Feature',id,collection:'sentinel-2-c1-l2a',bbox:[2.99,-.01,3.01,.01],
    properties:{datetime:`${year}-07-01T10:00:00Z`,'eo:cloud_cover':cloud},
    assets:{visual:{href:bucket+id+'/TCI.tif'},scl:{href:bucket+id+'/SCL.tif'}}};
}
function server(features:ReturnType<typeof scene>[],sclById:Record<string,number[]>={},colorById:Record<string,number[]>={}) {
  const queried:string[]=[],assets:string[]=[];
  const fetch:typeof globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith('/search')) {
      queried.push(JSON.parse(String(init?.body)).datetime);
      return new Response(JSON.stringify({features}),{headers:{'content-type':'application/json'}});
    }
    const id=features.find(item=>url.includes('/'+item.id+'/'))?.id;
    assert.ok(id,'Only catalog-approved public raster assets may be fetched');assets.push(url);
    const bytes=raster(url.endsWith('/TCI.tif'),sclById[id]??[8,4,4,4],colorById[id]);
    const range=new Headers(init?.headers).get('range');assert.match(range??'',/^bytes=\d+-\d+$/);
    const [start,wantedEnd]=range!.slice(6).split('-').map(Number),end=Math.min(wantedEnd,bytes.length-1);
    return new Response(bytes.slice(start,end+1) as unknown as BodyInit,{status:206,headers:{
      'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':String(end-start+1),
    }});
  };
  return {fetch,queried,assets};
}
async function cache(run:(directory:string)=>Promise<void>) {
  const parent=await realpath(resolve('artifacts'));
  await mkdir(join(parent,'model-coverage-tests'),{recursive:true});
  const directory=await mkdtemp(join(parent,'model-coverage-tests','case-'));
  try {await run(directory);} finally {assert.equal(dirname(directory),join(parent,'model-coverage-tests'));await rm(directory,{recursive:true,force:true});}
}
const errorCode=(wanted:string)=>(value:unknown)=>!!value&&typeof value==='object'&&'code' in value&&value.code===wanted;

test('cloud outside the actual model footprint does not block verified model colors',async()=>cache(async cacheDir=>{
  const transport=server([scene('shape')]);
  const acquired=await loadSentinelColorImage(bounds,{cacheDir,fetch:transport.fetch,now,...{modelFootprint:lowerRight}});
  assert.deepEqual(acquired.image.sample(.00008,3.00027),{r:30,g:140,b:40});
  assert.equal(acquired.source.coverageRepair?.filledPixels??0,0);
  assert.equal(acquired.image.sample(.00031,3.00004),null,'Outside-footprint cloud must never become valid black/rock');
}));

test('a cloud inside the actual model still fails and writes no completed color cache',async()=>cache(async cacheDir=>{
  const transport=server([scene('inside')]);
  await assert.rejects(loadSentinelColorImage(bounds,{cacheDir,fetch:transport.fetch,now,...{modelFootprint:upperLeft}}),errorCode('IMAGE_COVERAGE_INSUFFICIENT'));
  assert.equal((await readdir(cacheDir)).filter(file=>file.endsWith('.rgb')||file.endsWith('.json')).length,0);
}));

test('shape-specific offline cache preserves content and cannot validate a different footprint',async()=>cache(async cacheDir=>{
  const first=await loadSentinelColorImage(bounds,{cacheDir,fetch:server([scene('cache')]).fetch,now,...{modelFootprint:lowerRight,grassSensitivity:50}});
  const offline:typeof globalThis.fetch=async()=>{throw new Error('Offline lookup must not contact transport');};
  const repeated=await loadSentinelColorImage(bounds,{cacheDir,fetch:offline,offlineOnly:true,now,...{modelFootprint:lowerRight,grassSensitivity:50}});
  assert.equal(repeated.source.cacheHit,true);assert.equal(repeated.image.metadata.sha256,first.image.metadata.sha256);
  await assert.rejects(loadSentinelColorImage(bounds,{cacheDir,fetch:offline,offlineOnly:true,now,...{modelFootprint:upperLeft,grassSensitivity:50}}),errorCode('IMAGE_CACHE_MISS'));
}));

for(const invalid of [[],[{lat:0,lon:3}],lowerRight.map(point=>({...point,lon:point.lon+1}))]) {
  test('invalid or out-of-bounds footprint is rejected before transport '+JSON.stringify(invalid),async()=>cache(async cacheDir=>{
    let contacted=false;
    await assert.rejects(loadSentinelColorImage(bounds,{cacheDir,now,fetch:async()=>{contacted=true;throw new Error('unexpected transport');},...{modelFootprint:invalid}}),errorCode('IMAGE_REQUEST_INVALID'));
    assert.equal(contacted,false);
  }));
}

for(const years of [3,4,5])test(`${years} selected summers accept the oldest selected summer and exclude an earlier year`,async()=>cache(async cacheDir=>{
  const oldest=scene('oldest',2027-years),tooOld=scene('too-old',2026-years);
  const transport=server([tooOld,oldest],{oldest:[4,4,4,4],'too-old':[4,4,4,4]},{'too-old':[120,80,60]});
  const acquired=await loadSentinelColorImage(bounds,{cacheDir,fetch:transport.fetch,now,...{lookbackMonths:years*12 as 36|48|60}});
  assert.equal(transport.queried.length,years);
  assert.deepEqual(acquired.source.scenes.map(item=>item.id),['oldest']);
  assert.ok(!transport.assets.some(url=>url.includes('/too-old/')));
}));

test('recent summer is used before a much clearer older summer',async()=>cache(async cacheDir=>{
  const transport=server([scene('old',2025,0),scene('recent',2026,60)],{old:[4,4,4,4],recent:[4,4,4,4]}, {recent:[120,80,60]});
  const acquired=await loadSentinelColorImage(bounds,{cacheDir,fetch:transport.fetch,now});
  assert.deepEqual(acquired.source.scenes.map(item=>item.id),['recent']);
  assert.deepEqual(acquired.image.sample(.00008,3.00027),{r:120,g:80,b:60});
}));

test('expanded summer horizon can reach a useful scene beyond the previous total 24-scene cap',async()=>cache(async cacheDir=>{
  const cloudy=Array.from({length:25},(_,index)=>scene(`cloud-${String(index).padStart(2,'0')}`,2026,index));
  const older=scene('older-clear',2025,80),sclById:Record<string,number[]>={};
  for(const item of cloudy)sclById[item.id]=[8,8,8,8];sclById[older.id]=[4,4,4,4];
  const transport=server([...cloudy,older],sclById);
  const acquired=await loadSentinelColorImage(bounds,{cacheDir,fetch:transport.fetch,now});
  assert.deepEqual(acquired.source.scenes.map(item=>item.id),['older-clear']);
  assert.ok(transport.assets.includes(bucket+'older-clear/SCL.tif'));
}));
