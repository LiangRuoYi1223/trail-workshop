import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const BOUNDS = Object.freeze({west:99.6137151277459,east:99.80627187225409,south:29.71030849636864,north:29.877412742073602});
export const ROUTE_SHA256 = '1b319371fc01897ec579cda6eecb40fbe225cd1714ae331695f3388ef657aaaf';
export const LIMITS = Object.freeze({downloadBytes:512*1024*1024,rangeBytes:4*1024*1024,timeoutMs:600000,retries:2,scenes:24});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const assertBounds = value => {
  for (const key of Object.keys(BOUNDS)) assert.equal(value[key], BOUNDS[key], 'Exact Genyen bounds: '+key);
};
export function inspectImage(loaded, now = new Date()) {
  const {image,source} = loaded, {width,height,bounds} = image.metadata;
  assertBounds(bounds); assertBounds(source.bounds);
  assert.equal(width,1024); assert.equal(height,1024);
  assert.ok(source.scenes.length>0 && source.scenes.length<=LIMITS.scenes);
  const latestYear=now.getUTCFullYear()-(now.getUTCMonth()<5?1:0);
  for(const scene of source.scenes) {
    const date=new Date(scene.datetime);
    assert.ok([latestYear-1,latestYear].includes(date.getUTCFullYear()) && [5,6,7].includes(date.getUTCMonth()), 'Selected scene must be in latest two summers');
  }
  const bytes=new Uint8Array(width*height*3);
  for(let row=0;row<height;row++)for(let column=0;column<width;column++) {
    const rgb=image.sample(bounds.north-(row+.5)/height*(bounds.north-bounds.south),bounds.west+(column+.5)/width*(bounds.east-bounds.west));
    assert.ok(rgb && [rgb.r,rgb.g,rgb.b].every(v=>Number.isInteger(v)&&v>=0&&v<=255), 'Complete finite RGB output');
    bytes.set([rgb.r,rgb.g,rgb.b],(row*width+column)*3);
  }
  const boundary=[];
  for(let step=0;step<=1024;step++) {
    const lat=bounds.south+(bounds.north-bounds.south)*step/1024,lon=bounds.west+(bounds.east-bounds.west)*step/1024;
    for(const [a,b] of [[lat,bounds.west],[lat,bounds.east],[bounds.south,lon],[bounds.north,lon]]) {
      const value=image.sample(a,b); assert.ok(value,'Image supports every sampled rectangle edge');
      boundary.push(value.r,value.g,value.b);
    }
  }
  return {metadata:image.metadata,source,pixelSha256:sha256(bytes),boundarySha256:sha256(new Uint8Array(boundary)),
    sourceIdentitySha256:sha256(JSON.stringify({collection:source.collection,bounds:source.bounds,scenes:source.scenes})),pixelCount:width*height};
}

/** Observes actual streamed bytes. It never retries or changes request URLs. */
export function createObserver({transport,faultLimit=0,onRecord=()=>{},clock=()=>performance.now()}) {
  const started=clock(),requests=[],events=[],assets=new Map(),scenes=new Map();
  const stats={assetBytes:0,catalogBytes:0,completedAssetRequests:0,injectedFaults:0,networkCalls:0};
  let faultKey,activeScene,previousCoverage=0,previousDownloaded=0,ledgerMonotonic=true;
  const emit=record=>onRecord(record);
  const sceneFor = entry => {
    if(!entry.sceneId)return undefined;
    let scene=scenes.get(entry.sceneId);
    if(!scene)scenes.set(entry.sceneId,scene={id:entry.sceneId,datetime:entry.datetime,firstMs:entry.startMs,lastMs:entry.startMs,downloadedBytes:0,requestCount:0,sclBytes:0,rgbBytes:0,coverageAdded:0});
    return scene;
  };
  const fetch=async(input,init={})=>{
    const url=String(input),headers=new Headers(init.headers),range=headers.get('range'),asset=/\.tif$/i.test(new URL(url).pathname);
    if(asset) {
      const parsed=/^bytes=(\d+)-(\d+)$/.exec(range??''); assert.ok(parsed,'Asset request is bounded');
      assert.ok(Number(parsed[2])-Number(parsed[1])+1<=LIMITS.rangeBytes,'Asset request <=4 MiB');
    }
    const mapped=assets.get(url),entry={type:'request',id:requests.length+1,url,method:init.method??'GET',range,asset,
      ...(mapped??{}),startMs:clock()-started,bytes:0,state:'fetching'};
    requests.push(entry);stats.networkCalls++;emit({...entry});
    const key=url+'|'+range;
    if(asset && !faultKey && stats.completedAssetRequests>=2 && faultLimit>0)faultKey=key;
    // Select one exact real range so recovery must retry that failed data, not another scene.
    const inject=asset && key===faultKey && stats.injectedFaults<faultLimit;
    if(inject) {stats.injectedFaults++;entry.injectedFault=stats.injectedFaults;}
    let response;
    try {response=await transport(input,init);}
    catch(error) {entry.state='failed';entry.error=String(error);entry.endMs=clock()-started;emit({...entry});throw error;}
    entry.status=response.status;
    const reader=response.body?.getReader(),catalogParts=[];
    let delivered=false,finished=false;
    const finish=state=>{
      if(finished)return;finished=true;entry.state=state;entry.endMs=clock()-started;
      const scene=sceneFor(entry);if(scene){scene.lastMs=entry.endMs;scene.requestCount++;}
      if(asset && state==='complete')stats.completedAssetRequests++;
      if(!asset && state==='complete') {
        try {
          const all=Buffer.concat(catalogParts),document=JSON.parse(all.toString('utf8'));
          for(const item of document.features??[])for(const [kind,field] of [['rgb','visual'],['scl','scl']]) {
            const href=item.assets?.[field]?.href;
            if(href)assets.set(href,{sceneId:item.id,datetime:item.properties?.datetime,kind});
          }
        }catch{}
      }
      emit({...entry});
    };
    if(!reader){finish('complete');return response;}
    const body=new ReadableStream({
      async pull(controller) {
        try {
          if(inject&&delivered) {
            const error=new TypeError('net::ERR_CONNECTION_RESET: injected transient streamed-body fault');
            error.code='ECONNRESET';entry.error=error.message;
            await reader.cancel(error).catch(()=>{});finish('injected-fault');controller.error(error);return;
          }
          const chunk=await reader.read();
          if(chunk.done){finish('complete');controller.close();return;}
          entry.bytes+=chunk.value.byteLength;delivered=true;
          if(asset) {
            stats.assetBytes+=chunk.value.byteLength;
            const scene=sceneFor(entry);if(scene){activeScene=scene.id;scene.downloadedBytes+=chunk.value.byteLength;
              scene[entry.kind==='scl'?'sclBytes':'rgbBytes']+=chunk.value.byteLength;}
          } else {stats.catalogBytes+=chunk.value.byteLength;catalogParts.push(Buffer.from(chunk.value));}
          controller.enqueue(chunk.value);
        }catch(error){entry.error=String(error);finish('failed');controller.error(error);}
      },
      async cancel(reason){await reader.cancel(reason).catch(()=>{});finish('cancelled');}
    }, {highWaterMark:0});
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  const progress=value=>{
    const event={type:'progress',atMs:clock()-started,...value};events.push(event);
    if(Number.isSafeInteger(value.downloadedBytes)) {
      if(value.downloadedBytes<previousDownloaded)ledgerMonotonic=false;
      previousDownloaded=value.downloadedBytes;
    }
    if(Number.isFinite(value.coverage)&&value.coverage>previousCoverage) {
      const id=value.sceneId??activeScene,scene=scenes.get(id);
      if(scene)scene.coverageAdded+=value.coverage-previousCoverage;
      previousCoverage=value.coverage;
    }
    emit(event);
  };
  const summary=()=>({elapsedMs:clock()-started,stats:{...stats},faultKey,requests,progress:events,
    scenes:[...scenes.values()].map(scene=>({...scene,spanMs:scene.lastMs-scene.firstMs})),
    ledger:{monotonic:ledgerMonotonic,lastDownloadedBytes:previousDownloaded,
      partialStreamBytesAccounted:previousDownloaded>=stats.assetBytes&&previousDownloaded<=stats.assetBytes+stats.catalogBytes,
      note:'Coverage attribution uses explicit sceneId when supplied; otherwise the last scene asset read. Raw request and progress records retain the evidence.'}});
  return {fetch,progress,summary};
}

