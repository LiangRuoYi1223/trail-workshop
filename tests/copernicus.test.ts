import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import fsPromises,{mkdtemp,rm,readdir,readFile,writeFile,mkdir,utimes,rename} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,join,dirname,basename} from 'node:path';
import {loadCopernicusDem,type CopernicusDependencies,type CopernicusImage} from '../src/dem/copernicus.js';
import type {Bounds,DemSampler} from '../src/types.js';
const box:Bounds={west:104.1,south:30.2,east:104.102,north:30.202};
const meta=(value:DemSampler):Record<string,unknown>=>value.metadata as Record<string,unknown>;
async function sandbox(t:TestContext):Promise<string>{
  const root=resolve(process.cwd()),dir=await mkdtemp(join(root,'terrain-copernicus-test-'));
  t.after(async()=>{assert.equal(dirname(resolve(dir)),root);assert.ok(basename(dir).startsWith('terrain-copernicus-test-'));await rm(dir,{recursive:true,force:true});});
  return dir;
}
function widthFor(south:number):number{const lat=south<0?-south-1:south;return lat<50?3600:lat<60?2400:lat<70?1800:lat<80?1200:lat<85?720:360;}
function fixture(settings:{area?:boolean;nodata?:string;value?:(lat:number,lon:number,south:number,west:number,x:number,y:number)=>number;changeImage?:(image:CopernicusImage)=>CopernicusImage}={}){
  const opened:string[]=[],windows:Array<{west:number;south:number;window:number[]}>=[];
  let closed=0;
  const deps:CopernicusDependencies={open:async(url,options,signal)=>{
    assert.equal(options.allowFullFile,false);assert.equal(options.blockSize,65536);assert.ok(signal instanceof AbortSignal);
    opened.push(url);
    const match=/10_([NS])(\d+)_00_([EW])(\d+)_00_DEM\//u.exec(url)!;
    assert.ok(match);
    const south=Number(match[2])*(match[1]==='S'?-1:1),west=Number(match[4])*(match[3]==='W'?-1:1);
    const width=widthFor(south),dx=1/width,dy=1/3600,offset=settings.area?.5:0;
    const image:CopernicusImage={getWidth:()=>width,getHeight:()=>3600,getSamplesPerPixel:()=>1,
      getGeoKeys:()=>({GeographicTypeGeoKey:4326,GTRasterTypeGeoKey:settings.area?1:2,VerticalUnitsGeoKey:9001}),
      getFileDirectory:()=>({hasTag:()=>false,loadValue:async name=>name==='ModelPixelScale'?[dx,dy,0]:name==='ModelTiepoint'?[0,0,0,west-offset*dx,south+1+offset*dy,0]:name==='GDAL_NODATA'?settings.nodata:undefined}),
      readRasters:async({window})=>{
        windows.push({west,south,window});const[x0,y0,x1,y1]=window,values=new Float64Array((x1-x0)*(y1-y0));
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
          const lat=south+1-y*dy,lon=west+x*dx;
          values[(y-y0)*(x1-x0)+x-x0]=settings.value?.(lat,lon,south,west,x,y)??lat*10+lon*20;
        }
        return values;
      },
    };
    return {getImage:async()=>settings.changeImage?.(image)??image,close:async()=>{closed++;}};
  }};
  return {deps,opened,windows,get closed(){return closed;}};
}
function approximate(actual:number|null,expected:number,tolerance=1e-8):void{assert.ok(actual!==null);assert.ok(Math.abs(actual-expected)<tolerance,`${actual} vs ${expected}`);}
function linkedStat(t:TestContext,path:string,kind:'junction'|'hardlink'):void{
  // The Windows workspace sandbox forbids creating links. Inject only the
  // relevant lstat result, keeping all other reads, writes and directory checks real.
  const original=fsPromises.lstat;
  t.mock.method(fsPromises,'lstat',async(target:Parameters<typeof original>[0])=>{
    const info=await original(target);
    if(resolve(String(target))!==resolve(path))return info;
    return Object.assign(Object.create(info),kind==='junction'?{isSymbolicLink:()=>true}:{nlink:2});
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}
test('COG only reads a bounded window and records verified source metadata',async t=>{
  const cacheDir=await sandbox(t),source=fixture(),events:number[]=[];
  const dem=await loadCopernicusDem(box,{cacheDir,onProgress:event=>events.push(event.progress)},source.deps);
  approximate(dem.sample(30.2011,104.1013),30.2011*10+104.1013*20);
  assert.equal(dem.sample(30.21,104.1),null);assert.equal(dem.sample(NaN,104.1),null);
  assert.equal(source.opened.length,1);assert.equal(source.closed,1);assert.ok(source.windows[0].window[2]-source.windows[0].window[0]<20);
  assert.equal(meta(dem).provider,'copernicus-glo30');assert.equal(meta(dem).cacheHit,false);assert.equal(meta(dem).tileCount,1);
  assert.match(String(meta(dem).sha256),/^[a-f0-9]{64}$/u);assert.deepEqual(meta(dem).requestedBounds,box);
  assert.ok(events.every((v,i)=>v>=0&&v<=1&&(i===0||v>=events[i-1])));assert.equal(events.at(-1),1);
});
test('PixelIsArea half-pixel tiepoint retains the official sample centres',async t=>{
  const source=fixture({area:true}),dem=await loadCopernicusDem(box,{cacheDir:await sandbox(t)},source.deps);
  approximate(dem.sample(30.2011,104.1013),30.2011*10+104.1013*20);
});
test('southern and western hemispheres use S/W tile names and real coordinates',async t=>{
  const source=fixture(),bounds={west:-74.001,south:-33.002,east:-73.999,north:-32.998};
  const dem=await loadCopernicusDem(bounds,{cacheDir:await sandbox(t)},source.deps);
  approximate(dem.sample(-33.0001,-74.0001),-33.0001*10-74.0001*20);
  assert.ok(source.opened.some(url=>url.includes('S34_00_W075_00')));assert.equal(source.closed,4);
});
test('east and south removed edge samples come from neighbouring tiles, never constant clamping',async t=>{
  const source=fixture(),bounds={west:104.9998,south:30.9998,east:105.0002,north:31.0002};
  const dem=await loadCopernicusDem(bounds,{cacheDir:await sandbox(t)},source.deps);
  assert.equal(meta(dem).tileCount,4);
  for(const lat of [30.9999,31,31.0001])for(const lon of[104.9999,105,105.0001])approximate(dem.sample(lat,lon),lat*10+lon*20);
});
test('halo is fetched even if the selected bounds stop just short of the tile boundary',async t=>{
  const source=fixture(),bounds={west:104.9998,south:30.0001,east:104.9999,north:30.0002};
  const dem=await loadCopernicusDem(bounds,{cacheDir:await sandbox(t)},source.deps);
  assert.equal(meta(dem).tileCount,4);approximate(dem.sample(30.00015,104.99985),30.00015*10+104.99985*20);
});
for(const boundary of [50,60,70,80,85,-50,-60,-70,-80,-85])test(`different longitude spacing joins across latitude band ${boundary}`,async t=>{
  const source=fixture(),bounds={west:8.9998,south:boundary-.0002,east:9.0002,north:boundary+.0002};
  const dem=await loadCopernicusDem(bounds,{cacheDir:await sandbox(t)},source.deps);
  assert.equal(meta(dem).tileCount,4);
  const widths=new Set((meta(dem).tiles as Array<{width:number}>).map(tile=>tile.width));assert.equal(widths.size,2);
  for(const lat of [boundary-.00015,boundary,boundary+.00015])approximate(dem.sample(lat,9.0001),lat*10+9.0001*20);
});
test('seam interpolation preserves non-linear row values using each row’s own longitude grid',async t=>{
  const value=(lat:number,lon:number)=>lat*lat+lon*lon*100;
  const source=fixture({value}),bounds={west:8.9998,south:49.9999,east:9.0002,north:50.0002};
  const dem=await loadCopernicusDem(bounds,{cacheDir:await sandbox(t)},source.deps),lat=50.00013,lon=9.00017;
  const y=(90-lat)*3600,n0=Math.floor(y),fy=y-n0;
  function row(index:number):number{const latitude=90-index/3600,south=Math.floor(latitude-1e-9),width=widthFor(south),x=lon*width,x0=Math.floor(x),f=x-x0;return value(latitude,x0/width)*(1-f)+value(latitude,(x0+1)/width)*f;}
  approximate(dem.sample(lat,lon),row(n0)*(1-fy)+row(n0+1)*fy,1e-7);
});
test('nodata corners use remaining bilinear weights without bias at row seams',async t=>{
  const source=fixture({nodata:'-9999',value:(_lat,_lon,_south,_west,x,y)=>x===360&&y===2879?-9999:10*x+100*y});
  const bounds={west:104.1,south:30.2001,east:104.1002,north:30.2002},dem=await loadCopernicusDem(bounds,{cacheDir:await sandbox(t)},source.deps);
  const lat=30.20015,lon=104.1001,x=(lon-104)*3600,y=(31-lat)*3600,x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0;
  let sum=0,weight=0;
  for(const[px,py,w]of[[x0,y0,(1-fx)*(1-fy)],[x0+1,y0,fx*(1-fy)],[x0,y0+1,(1-fx)*fy],[x0+1,y0+1,fx*fy]])if(!(px===360&&py===2879)){sum+=(10*px+100*py)*w;weight+=w;}
  approximate(dem.sample(lat,lon),sum/weight,1e-6);assert.ok(Number(meta(dem).missingPixels)>0);
});
test('entire missing-data window returns null rather than elevation zero',async t=>{
  const source=fixture({nodata:'NaN',value:()=>NaN}),dem=await loadCopernicusDem(box,{cacheDir:await sandbox(t)},source.deps);
  assert.equal(dem.sample(30.201,104.101),null);assert.equal(meta(dem).validPixels,0);
});
test('exact bounds reuse verified cache offline without any network call',async t=>{
  const cacheDir=await sandbox(t),source=fixture(),first=await loadCopernicusDem(box,{cacheDir},source.deps);
  const second=await loadCopernicusDem(box,{cacheDir,offlineOnly:true},{open:async()=>{throw new Error('network forbidden');}});
  assert.equal(meta(second).cacheHit,true);assert.equal(meta(first).sha256,meta(second).sha256);
  assert.equal(second.sample(30.2011,104.1013),first.sample(30.2011,104.1013));
  await assert.rejects(loadCopernicusDem({...box,east:box.east+.0001},{cacheDir,offlineOnly:true}),{code:'DEM_CACHE_MISS'});
});
test('corrupt cache cannot be silently used offline, and online recovery preserves bad data',async t=>{
  const cacheDir=await sandbox(t),source=fixture();await loadCopernicusDem(box,{cacheDir},source.deps);
  const namespace=join(cacheDir,'copernicus-glo30'),entry=(await readdir(namespace)).find(v=>v.startsWith('window-v1-'))!,path=join(namespace,entry,'elevations.bin');
  const bytes=await readFile(path);bytes[0]^=1;await writeFile(path,bytes);
  await assert.rejects(loadCopernicusDem(box,{cacheDir,offlineOnly:true}),{code:'DEM_CACHE_INVALID'});
  const recovered=await loadCopernicusDem(box,{cacheDir},source.deps);assert.equal(meta(recovered).cacheRecovered,true);
  assert.ok((await readdir(namespace)).some(v=>v.startsWith('.invalid-')));
});
test('published cache with a missing file is corruption, not an offline cache miss',async t=>{
  const cacheDir=await sandbox(t),source=fixture();await loadCopernicusDem(box,{cacheDir},source.deps);
  const namespace=join(cacheDir,'copernicus-glo30'),entry=(await readdir(namespace)).find(v=>v.startsWith('window-v1-'))!;
  await rm(join(namespace,entry,'manifest.json'));
  await assert.rejects(loadCopernicusDem(box,{cacheDir,offlineOnly:true}),{code:'DEM_CACHE_INVALID'});
});
test('404 missing public coverage is reported clearly and is never cached as sea level',async t=>{
  const cacheDir=await sandbox(t);
  await assert.rejects(loadCopernicusDem(box,{cacheDir},{open:async()=>{throw Object.assign(new Error('HTTP 404'),{status:404});}}),{code:'DEM_COVERAGE_MISSING'});
  assert.deepEqual(await readdir(join(cacheDir,'copernicus-glo30')),[]);
});
test('mismatched source tiepoints are rejected before any raster is read',async t=>{
  const source=fixture({changeImage:image=>({...image,getFileDirectory:()=>({hasTag:()=>false,loadValue:async name=>name==='ModelPixelScale'?[1/3600,1/3600,0]:name==='ModelTiepoint'?[0,0,0,104.001,31,0]:undefined})})});
  await assert.rejects(loadCopernicusDem(box,{cacheDir:await sandbox(t)},source.deps),{code:'DEM_SOURCE_INVALID'});
  assert.equal(source.windows.length,0);assert.equal(source.closed,1);
});
test('oversized or invalid selections fail before network access',async t=>{
  const source=fixture(),cacheDir=await sandbox(t);
  for(const bounds of [{...box,east:107},{...box,east:104.9,north:30.9},{...box,east:NaN},{west:179.9,east:-179.9,south:30,north:30.1}])await assert.rejects(loadCopernicusDem(bounds,{cacheDir},source.deps));
  assert.equal(source.opened.length,0);
});
test('cancellation of a pending metadata read is prompt and closes its COG',async t=>{
  const cacheDir=await sandbox(t),controller=new AbortController(),source=fixture();
  const original=source.deps.open!;
  const operation=loadCopernicusDem(box,{cacheDir,signal:controller.signal},{open:async(...args)=>{const tiff=await original(...args);return {...tiff,getImage:()=>new Promise(()=>{})};}});
  setTimeout(()=>controller.abort(new Error('user cancelled')),20);
  await assert.rejects(operation,/user cancelled/u);assert.equal(source.closed,1);
  assert.deepEqual(await readdir(join(cacheDir,'copernicus-glo30')),[]);
});
test('deadline covers a pending metadata read as well as raster downloads',async t=>{
  const source=fixture(),original=source.deps.open!;
  // Keep the test alive: AbortSignal.timeout timers are intentionally unreferenced by Node.
  const timer=setInterval(()=>{},10);t.after(()=>clearInterval(timer));
  await assert.rejects(loadCopernicusDem(box,{cacheDir:await sandbox(t)},{timeoutMs:20,open:async(...args)=>{const tiff=await original(...args);return {...tiff,getImage:()=>new Promise(()=>{})};}}),{code:'DEM_FETCH_TIMEOUT'});
  assert.equal(source.closed,1);
});
test('interrupted unpublished folders are ignored and only stale owned temporary folders are removed',async t=>{
  const cacheDir=await sandbox(t),namespace=join(cacheDir,'copernicus-glo30');await mkdir(namespace,{recursive:true});
  const stale=join(namespace,'.partial-12-old'),recent=join(namespace,'.partial-13-new');await mkdir(stale);await mkdir(recent);
  await utimes(stale,new Date(0),new Date(0));
  const source=fixture();await loadCopernicusDem(box,{cacheDir},source.deps);
  const entries=await readdir(namespace);assert.ok(!entries.includes('.partial-12-old'));assert.ok(entries.includes('.partial-13-new'));
});
test('parallel downloads publish one complete cache without interleaving elevation bytes',async t=>{
  const cacheDir=await sandbox(t),source=fixture();
  const models=await Promise.all([loadCopernicusDem(box,{cacheDir},source.deps),loadCopernicusDem(box,{cacheDir},source.deps)]);
  assert.equal(meta(models[0]).sha256,meta(models[1]).sha256);
  const entries=await readdir(join(cacheDir,'copernicus-glo30'));assert.equal(entries.length,1);assert.ok(entries[0].startsWith('window-v1-'));
});
test('junction namespace metadata is rejected before downloading or modifying its destination',async t=>{
  const dir=await sandbox(t),cacheDir=join(dir,'cache'),external=join(dir,'external');await mkdir(cacheDir);await mkdir(external);await writeFile(join(external,'keep.txt'),'unchanged');
  const namespace=join(cacheDir,'copernicus-glo30');await mkdir(namespace);linkedStat(t,namespace,'junction');const source=fixture();
  await assert.rejects(loadCopernicusDem(box,{cacheDir},source.deps),{code:'DEM_CACHE_UNSAFE'});
  assert.equal(source.opened.length,0);assert.deepEqual(await readdir(external),['keep.txt']);
});
test('a nonexistent cache child under a junction is refused before creating folders',async t=>{
  const dir=await sandbox(t),external=join(dir,'external'),redirect=join(dir,'redirect');await mkdir(external);await mkdir(redirect);linkedStat(t,redirect,'junction');const source=fixture();
  await assert.rejects(loadCopernicusDem(box,{cacheDir:join(redirect,'missing','child')},source.deps),{code:'DEM_CACHE_UNSAFE'});
  assert.equal(source.opened.length,0);assert.deepEqual(await readdir(external),[]);assert.deepEqual(await readdir(redirect),[]);
});
test('published cache junction metadata is rejected before reading a manifest',async t=>{
  const dir=await sandbox(t),cacheDir=join(dir,'cache'),source=fixture();await loadCopernicusDem(box,{cacheDir},source.deps);
  const namespace=join(cacheDir,'copernicus-glo30'),entry=(await readdir(namespace)).find(v=>v.startsWith('window-v1-'))!,target=join(dir,'moved-cache'),path=join(namespace,entry);
  await rename(path,target);await mkdir(path);linkedStat(t,path,'junction');
  await assert.rejects(loadCopernicusDem(box,{cacheDir,offlineOnly:true}),{code:'DEM_CACHE_UNSAFE'});
  assert.equal((await readdir(target)).length,2);
});
test('cache data hardlink metadata is rejected without changing the existing bytes',async t=>{
  const dir=await sandbox(t),cacheDir=join(dir,'cache'),source=fixture();await loadCopernicusDem(box,{cacheDir},source.deps);
  const namespace=join(cacheDir,'copernicus-glo30'),entry=(await readdir(namespace)).find(v=>v.startsWith('window-v1-'))!,path=join(namespace,entry,'elevations.bin'),other=join(dir,'linked-elevations.bin');
  const before=await readFile(path);await writeFile(other,before);linkedStat(t,path,'hardlink');
  await assert.rejects(loadCopernicusDem(box,{cacheDir,offlineOnly:true}),{code:'DEM_CACHE_UNSAFE'});
  assert.deepEqual(await readFile(other),before);
});
test('a directory in place of the cache manifest is refused as a non-regular file',async t=>{
  const dir=await sandbox(t),cacheDir=join(dir,'cache'),source=fixture();await loadCopernicusDem(box,{cacheDir},source.deps);
  const namespace=join(cacheDir,'copernicus-glo30'),entry=(await readdir(namespace)).find(v=>v.startsWith('window-v1-'))!,path=join(namespace,entry,'manifest.json');
  await rm(path);await mkdir(path);
  await assert.rejects(loadCopernicusDem(box,{cacheDir,offlineOnly:true}),{code:'DEM_CACHE_UNSAFE'});
});
test('cache directory replacement during a download is refused before publishing any files',async t=>{
  const dir=await sandbox(t),cacheDir=join(dir,'cache'),source=fixture(),original=source.deps.open!;
  await assert.rejects(loadCopernicusDem(box,{cacheDir},{open:async(...args)=>{
    await rename(cacheDir,join(dir,'original-cache'));await mkdir(join(cacheDir,'copernicus-glo30'),{recursive:true});
    return original(...args);
  }}),{code:'DEM_CACHE_UNSAFE'});
  assert.deepEqual(await readdir(join(cacheDir,'copernicus-glo30')),[]);
  assert.equal(source.closed,1);
});
