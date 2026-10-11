/** Public Sentinel-2 COG acquisition with bounded reads and complete cloud-screened output. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fromCustomClient, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import type { Bounds } from '../types.js';
import type { ColorImage, ColorImageMetadata } from './types.js';
import type { SentinelColorImage, SentinelImageOptions, SentinelSceneSource, SurfaceImageSource } from './online-types.js';
import { DownloadBudget, imageFail, readBoundedBody, safeSentinelAsset, SentinelImageError, SentinelRangeClient } from './online-remote.js';
import { projectUtm } from './online-utm.js';
import { validateCacheDirectory } from './online-range-cache.js';
export { SentinelImageError } from './online-remote.js';

const COLLECTION='sentinel-2-c1-l2a',SEARCH='https://earth-search.aws.element84.com/v1/search';
const MAX_WINDOW_PIXELS=4_000_000,MAX_BLOCK_PIXELS=1_048_576,MAX_OUTPUT_PIXELS=1_048_576;
const MAX_CANDIDATES=72,MAX_SCENES=24,TIMEOUT_MS=150_000;
const METERS_PER_DEGREE=111320;
interface Candidate extends SentinelSceneSource {visual:string;scl:string;tile:string}
interface Mapping {epsg:number;width:number;height:number;dx:number;dy:number;x:number;y:number}
interface Crop extends Mapping {window:[number,number,number,number];values:Uint8Array;channels:number}
interface CacheHeader {schema:1;collection:typeof COLLECTION;bounds:Bounds;width:number;height:number;scenes:SentinelSceneSource[];retrievedAt:string;attribution:string}
interface Manifest extends CacheHeader {dataFile:string;dataSha256:string;integrity:string}

function validBounds(value:Bounds):Bounds {
  if(!value||!Object.values(value).every(Number.isFinite)||value.west < -180||value.east>180||value.south < -80||value.north>84
    ||value.west>=value.east||value.south>=value.north||value.east-value.west>2||value.north-value.south>2)
    imageFail('IMAGE_BOUNDS_INVALID','自动影像取景范围无效或过大，请缩小范围后重试');
  return {west:value.west,south:value.south,east:value.east,north:value.north};
}
function dimensions(bounds:Bounds):{width:number;height:number} {
  const metersWide=(bounds.east-bounds.west)*METERS_PER_DEGREE*Math.cos((bounds.south+bounds.north)/2*Math.PI/180);
  const metersHigh=(bounds.north-bounds.south)*METERS_PER_DEGREE;
  const resolution=Math.max(10,metersWide/1024,metersHigh/1024);
  const width=Math.max(1,Math.ceil(metersWide/resolution)),height=Math.max(1,Math.ceil(metersHigh/resolution));
  if(width*height>MAX_OUTPUT_PIXELS) imageFail('IMAGE_PIXEL_LIMIT','自动影像输出超出像素限制，请缩小取景范围');
  return {width,height};
}
const sha=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex');
const cacheKey=(bounds:Bounds):string=>sha(JSON.stringify({schema:1,collection:COLLECTION,bounds}));
const payloadName=(key:string,digest:string):string=>`sentinel-${key.slice(0,16)}-${digest.slice(0,32)}.rgb`;
function attribution(scenes:SentinelSceneSource[]):string {
  return `Contains modified Copernicus Sentinel data ${Array.from(new Set(scenes.map(scene=>scene.datetime.slice(0,4)))).sort().join(', ')}`;
}
function headerOf(manifest:CacheHeader):CacheHeader {
  return {schema:1,collection:COLLECTION,bounds:manifest.bounds,width:manifest.width,height:manifest.height,
    scenes:manifest.scenes,retrievedAt:manifest.retrievedAt,attribution:manifest.attribution};
}
function integrity(header:CacheHeader,bytes:Uint8Array):string {
  return createHash('sha256').update(JSON.stringify(header)).update(bytes).digest('hex');
}
function result(header:CacheHeader,bytes:Uint8Array,cacheHit:boolean):SentinelColorImage {
  const {bounds,width,height,scenes,retrievedAt}=header;
  // Operational cache state and retrieval time are excluded from appearance identity.
  const identity={collection:COLLECTION,bounds,width,height,scenes};
  const metadata:ColorImageMetadata={sha256:createHash('sha256').update(JSON.stringify(identity)).update(bytes).digest('hex'),
    byteLength:bytes.length,width,height,bounds:{...bounds},crs:'EPSG:4326',pixelIsArea:true};
  const image:ColorImage={metadata,sample(lat,lon) {
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lon<bounds.west||lon>bounds.east||lat<bounds.south||lat>bounds.north)return null;
    const column=Math.min(width-1,Math.floor((lon-bounds.west)/(bounds.east-bounds.west)*width));
    const row=Math.min(height-1,Math.floor((bounds.north-lat)/(bounds.north-bounds.south)*height));
    const index=(row*width+column)*3;return {r:bytes[index],g:bytes[index+1],b:bytes[index+2]};
  }};
  const source:SurfaceImageSource={provider:'Sentinel-2',collection:COLLECTION,scenes:scenes.map(scene=>({...scene})),
    cacheHit,retrievedAt,bounds:{...bounds},attribution:header.attribution};
  return {image,source};
}
async function readSmallFile(path:string,limit:number):Promise<Uint8Array> {
  const original=await lstat(path);
  if(!original.isFile()||original.isSymbolicLink())throw new Error('invalid cache entry');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.dev!==original.dev||before.ino!==original.ino||before.size<1||before.size>limit) throw new Error('invalid cache file size');
    const bytes=new Uint8Array(before.size);let offset=0;
    while(offset<bytes.length) {
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if(!bytesRead)throw new Error('incomplete cache');offset+=bytesRead;
    }
    const after=await handle.stat(),pathAfter=await lstat(path);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||pathAfter.isSymbolicLink()||pathAfter.ino!==before.ino)throw new Error('cache changed during read');
    return bytes;
  } finally {await handle.close();}
}
function validScene(value:unknown):value is SentinelSceneSource {
  if(!value||typeof value!=='object')return false;
  const scene=value as SentinelSceneSource;
  return typeof scene.id==='string'&&scene.id.length>0&&scene.id.length<=200&&typeof scene.datetime==='string'
    &&Number.isFinite(Date.parse(scene.datetime))&&scene.datetime===new Date(scene.datetime).toISOString()
    &&Number.isFinite(scene.cloudCover)&&scene.cloudCover>=0&&scene.cloudCover<=100;
}
function earliestSceneDate(now:Date,lookbackMonths:12|24):number {
  const start=new Date(now);start.setUTCMonth(start.getUTCMonth()-lookbackMonths);return start.getTime();
}
async function readCache(directory:string,bounds:Bounds,now:Date,lookbackMonths:12|24):Promise<SentinelColorImage|null> {
  try {
    await validateCacheDirectory(directory);
    const key=cacheKey(bounds),manifest=JSON.parse(new TextDecoder().decode(await readSmallFile(join(directory,`sentinel-${key}.json`),256*1024))) as Manifest;
    const size=dimensions(bounds);
    if(manifest.schema!==1||manifest.collection!==COLLECTION||JSON.stringify(manifest.bounds)!==JSON.stringify(bounds)
      ||manifest.width!==size.width||manifest.height!==size.height||!Array.isArray(manifest.scenes)||manifest.scenes.length<1
      ||manifest.scenes.length>MAX_SCENES||!manifest.scenes.every(validScene)||typeof manifest.retrievedAt!=='string'
      ||!Number.isFinite(Date.parse(manifest.retrievedAt))||Date.parse(manifest.retrievedAt)>now.getTime()
      ||manifest.scenes.some(scene=>Date.parse(scene.datetime)<earliestSceneDate(now,lookbackMonths)||Date.parse(scene.datetime)>now.getTime())
      ||manifest.attribution!==attribution(manifest.scenes)
      ||!/^[a-f0-9]{64}$/u.test(manifest.dataSha256)||manifest.dataFile!==payloadName(key,manifest.dataSha256))return null;
    const bytes=await readSmallFile(join(directory,manifest.dataFile),MAX_OUTPUT_PIXELS*3),header=headerOf(manifest);
    if(bytes.length!==manifest.width*manifest.height*3||sha(bytes)!==manifest.dataSha256||integrity(header,bytes)!==manifest.integrity)return null;
    await validateCacheDirectory(directory);return result(header,bytes,true);
  } catch {return null;}
}
async function writeCache(directory:string,header:CacheHeader,bytes:Uint8Array,signal:AbortSignal):Promise<void> {
  const key=cacheKey(header.bounds),dataSha256=sha(bytes),dataFile=payloadName(key,dataSha256);
  const manifest:Manifest={...header,dataFile,dataSha256,integrity:integrity(header,bytes)};
  const suffix=`.${randomUUID()}.tmp`,temporaryData=join(directory,dataFile+suffix),temporaryManifest=join(directory,`sentinel-${key}.json${suffix}`);
  try {
    signal.throwIfAborted();await mkdir(directory,{recursive:true});await validateCacheDirectory(directory);
    await writeFile(temporaryData,bytes,{flag:'wx'});signal.throwIfAborted();
    await validateCacheDirectory(directory);await rename(temporaryData,join(directory,dataFile));
    await writeFile(temporaryManifest,JSON.stringify(manifest),{flag:'wx'});signal.throwIfAborted();
    await validateCacheDirectory(directory);await rename(temporaryManifest,join(directory,`sentinel-${key}.json`));
  } finally {
    await rm(temporaryData,{force:true}).catch(()=>{});await rm(temporaryManifest,{force:true}).catch(()=>{});
  }
}
async function catalog(bounds:Bounds,fetch:typeof globalThis.fetch,now:Date,signal:AbortSignal,lookbackMonths:12|24):Promise<Candidate[]> {
  const start=new Date(earliestSceneDate(now,lookbackMonths));
  const response=await fetch(SEARCH,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal,
    body:JSON.stringify({collections:[COLLECTION],bbox:[bounds.west,bounds.south,bounds.east,bounds.north],
      datetime:`${start.toISOString()}/${now.toISOString()}`,limit:MAX_CANDIDATES,
      sortby:[{field:'properties.eo:cloud_cover',direction:'asc'},{field:'properties.datetime',direction:'desc'}]})});
  if(!response.ok) {await response.body?.cancel();imageFail('IMAGE_NETWORK_FAILED','卫星影像目录暂时无法访问，请重试或本地导入');}
  const bytes=await readBoundedBody(response,2*1024*1024,signal);
  let document:{features?:unknown[]};try {document=JSON.parse(new TextDecoder().decode(bytes));} catch {return imageFail('IMAGE_CATALOG_INVALID','卫星影像目录响应无效，请重试');}
  if(!Array.isArray(document.features)||document.features.length>MAX_CANDIDATES)imageFail('IMAGE_CATALOG_INVALID','卫星影像目录响应超出允许范围');
  const candidates:Candidate[]=[];
  for(const feature of document.features) {
    if(!feature||typeof feature!=='object')continue;
    const item=feature as {id?:unknown;collection?:unknown;properties?:Record<string,unknown>;bbox?:unknown;assets?:Record<string,{href?:unknown}>};
    const datetime=item.properties?.datetime,cloud=item.properties?.['eo:cloud_cover'];
    if(item.collection!==COLLECTION||typeof item.id!=='string'||item.id.length<1||item.id.length>200
      ||typeof datetime!=='string'||!Number.isFinite(Date.parse(datetime))||Date.parse(datetime)<start.getTime()||Date.parse(datetime)>now.getTime()
      ||typeof cloud!=='number'||!Number.isFinite(cloud)||cloud<0||cloud>100||!item.assets?.visual||!item.assets?.scl)continue;
    const bbox=item.bbox;
    if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite)||bbox[0]>=bounds.east||bbox[2]<=bounds.west||bbox[1]>=bounds.north||bbox[3]<=bounds.south)continue;
    candidates.push({id:item.id,datetime:new Date(datetime).toISOString(),cloudCover:cloud,
      visual:safeSentinelAsset(item.assets.visual.href),scl:safeSentinelAsset(item.assets.scl.href),
      tile:/_T(\d{2}[A-Z]{3})_/u.exec(item.id)?.[1]??JSON.stringify(bbox)});
  }
  // Tile cloud scores describe the whole ~110km tile, not this small AOI. Within
  // similarly clear five-percent buckets prefer fresh imagery, then verify actual SCL pixels.
  candidates.sort((a,b)=>Math.floor(a.cloudCover/5)-Math.floor(b.cloudCover/5)
    ||Date.parse(b.datetime)-Date.parse(a.datetime)||a.cloudCover-b.cloudCover||a.id.localeCompare(b.id));
  // Round-robin tiles so a very clear tile cannot starve another tile of candidates.
  const groups=new Map<string,Candidate[]>();for(const candidate of candidates) {
    const group=groups.get(candidate.tile)??[];group.push(candidate);groups.set(candidate.tile,group);
  }
  const ordered:Candidate[]=[];
  while(ordered.length<MAX_SCENES) {
    let added=false;for(const group of groups.values()) {
      const candidate=group.shift();if(candidate){ordered.push(candidate);added=true;}
      if(ordered.length===MAX_SCENES)break;
    }
    if(!added)break;
  }
  if(!ordered.length)imageFail('IMAGE_SCENE_UNAVAILABLE',`过去 ${lookbackMonths} 个月内没有可用的 Sentinel-2 地表影像，请重试或本地导入`);
  return ordered;
}
function numbers(value:unknown):number[] {
  if(!Array.isArray(value)&&!ArrayBuffer.isView(value))imageFail('IMAGE_TRANSFORM_UNSUPPORTED','卫星影像缺少有效的北向坐标映射');
  const values=Array.from(value as ArrayLike<number>);if(!values.every(Number.isFinite))imageFail('IMAGE_TRANSFORM_UNSUPPORTED','卫星影像坐标映射无效');
  return values;
}
async function mapping(image:GeoTIFFImage):Promise<Mapping> {
  const keys=image.getGeoKeys(),epsg=Number(keys?.ProjectedCSTypeGeoKey),directory=image.getFileDirectory();
  if(!((epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760))||!Number.isInteger(epsg)
    ||(keys?.GTModelTypeGeoKey!==undefined&&keys.GTModelTypeGeoKey!==1)
    ||(keys?.GTRasterTypeGeoKey!==undefined&&keys.GTRasterTypeGeoKey!==1)
    ||(keys?.ProjLinearUnitsGeoKey!==undefined&&keys.ProjLinearUnitsGeoKey!==9001))
    imageFail('IMAGE_CRS_UNSUPPORTED','卫星影像必须明确使用 WGS84 UTM 米制坐标');
  if(directory.hasTag('ModelTransformation')||![undefined,1].includes(await directory.loadValue('Orientation') as number|undefined))
    imageFail('IMAGE_TRANSFORM_UNSUPPORTED','卫星影像不是支持的北向栅格');
  const scale=numbers(await directory.loadValue('ModelPixelScale')),ties=numbers(await directory.loadValue('ModelTiepoint'));
  if(scale.length!==3||scale[0]<=0||scale[1]<=0||ties.length<6||ties.length%6!==0)imageFail('IMAGE_TRANSFORM_UNSUPPORTED','卫星影像北向坐标映射无效');
  const [dx,dy]=scale,x=ties[3]-ties[0]*dx,y=ties[4]+ties[1]*dy;
  for(let index=0;index<ties.length;index+=6) {
    if(ties[index+2]!==0||ties[index+5]!==0||Math.abs(ties[index+3]-ties[index]*dx-x)>1e-5||Math.abs(ties[index+4]+ties[index+1]*dy-y)>1e-5)
      imageFail('IMAGE_TRANSFORM_UNSUPPORTED','卫星影像北向控制点不一致');
  }
  const width=image.getWidth(),height=image.getHeight();
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>30000||height>30000
    ||!Number.isFinite(x)||!Number.isFinite(y)||x < -1000000||x+dx*width>2000000||y < -1000000||y-dy*height < -1000000||y>11000000)
    imageFail('IMAGE_PIXEL_LIMIT','卫星影像尺寸或坐标超出允许范围');
  return {epsg,width,height,dx,dy,x,y};
}
function windowFor(mapping:Mapping,bounds:Bounds):[number,number,number,number]|null {
  const points:Array<{x:number;y:number}>=[];
  for(let i=0;i<=16;i++) {
    const lat=bounds.south+(bounds.north-bounds.south)*i/16,lon=bounds.west+(bounds.east-bounds.west)*i/16;
    points.push(projectUtm(lat,bounds.west,mapping.epsg),projectUtm(lat,bounds.east,mapping.epsg),
      projectUtm(bounds.south,lon,mapping.epsg),projectUtm(bounds.north,lon,mapping.epsg));
  }
  const columns=points.map(point=>(point.x-mapping.x)/mapping.dx),rows=points.map(point=>(mapping.y-point.y)/mapping.dy);
  const west=Math.max(0,Math.floor(Math.min(...columns))-1),east=Math.min(mapping.width,Math.ceil(Math.max(...columns))+1);
  const north=Math.max(0,Math.floor(Math.min(...rows))-1),south=Math.min(mapping.height,Math.ceil(Math.max(...rows))+1);
  return west>=east||north>=south?null:[west,north,east,south];
}
async function validatePixels(image:GeoTIFFImage,channels:number):Promise<void> {
  const directory=image.getFileDirectory();
  if(image.getSamplesPerPixel()!==channels||(channels===3&&await directory.loadValue('PhotometricInterpretation')!==2))
    imageFail('IMAGE_RGB_UNSUPPORTED','卫星真彩色影像或场景分类通道无效');
  const bits=numbers(await directory.loadValue('BitsPerSample'));
  const sampleFormat=await directory.loadValue('SampleFormat'),formats=sampleFormat===undefined?Array(channels).fill(1):numbers(sampleFormat);
  if(bits.length!==channels||bits.some(value=>value!==8)||formats.length!==channels||formats.some(value=>value!==1))
    imageFail('IMAGE_RGB_UNSUPPORTED','卫星影像须为无符号 8 位真彩色或场景分类像元');
  const blockWidth=image.getTileWidth(),blockHeight=image.getTileHeight();
  if(!Number.isSafeInteger(blockWidth)||!Number.isSafeInteger(blockHeight)||blockWidth<1||blockHeight<1||blockWidth*blockHeight>MAX_BLOCK_PIXELS)
    imageFail('IMAGE_PIXEL_LIMIT','卫星影像解码块超出像素限制');
}
async function crop(url:string,channels:number,bounds:Bounds,fetch:typeof globalThis.fetch,signal:AbortSignal,budget:DownloadBudget,cacheDir:string):Promise<Crop|null> {
  let tiff:GeoTIFF|undefined;
  try {
    tiff=await fromCustomClient(new SentinelRangeClient(url,fetch,signal,budget,cacheDir),{allowFullFile:false,maxRanges:0},signal);
    const root=await tiff.getImage(),base=await mapping(root);let image=root,geometry=base,window=windowFor(base,bounds);
    if(!window)return null;
    await validatePixels(root,channels);
    if((window[2]-window[0])*(window[3]-window[1])>MAX_WINDOW_PIXELS) {
      const count=await tiff.getImageCount();
      if(count>12)imageFail('IMAGE_PIXEL_LIMIT','卫星影像包含过多概览');
      for(let index=1;index<count;index++) {
        image=await tiff.getImage(index);await validatePixels(image,channels);
        const width=image.getWidth(),height=image.getHeight();
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>base.width||height>base.height)
          imageFail('IMAGE_PIXEL_LIMIT','卫星影像概览尺寸无效');
        geometry={...base,width,height,dx:base.dx*base.width/width,dy:base.dy*base.height/height};
        window=windowFor(geometry,bounds);
        if(window&&(window[2]-window[0])*(window[3]-window[1])<=MAX_WINDOW_PIXELS)break;
      }
    }
    if(!window)return null;
    const pixels=(window[2]-window[0])*(window[3]-window[1]);
    // readRasters allocates the source window before optional resampling: bound that window itself.
    if(pixels>MAX_WINDOW_PIXELS)imageFail('IMAGE_PIXEL_LIMIT','卫星影像裁剪范围超出像素限制，请缩小取景范围');
    const values=await image.readRasters({window,samples:Array.from({length:channels},(_,index)=>index),interleave:true,signal});
    if(!(values instanceof Uint8Array)||values.length!==pixels*channels)imageFail('IMAGE_INVALID_RASTER','卫星影像裁剪像元无效');
    return {...geometry,window,values,channels};
  } finally {await tiff?.close();}
}
function pixel(crop:Crop,lat:number,lon:number):number|null {
  const point=projectUtm(lat,lon,crop.epsg),tolerance=.001;
  if(point.x<crop.x-tolerance||point.x>crop.x+crop.width*crop.dx+tolerance
    ||point.y>crop.y+tolerance||point.y<crop.y-crop.height*crop.dy-tolerance)return null;
  const column=Math.max(0,Math.min(crop.width-1,Math.floor((point.x-crop.x)/crop.dx)));
  const row=Math.max(0,Math.min(crop.height-1,Math.floor((crop.y-point.y)/crop.dy)));
  const [west,north,east,south]=crop.window;
  if(column<west||column>=east||row<north||row>=south)return null;
  return ((row-north)*(east-west)+column-west)*crop.channels;
}
function validColor(rgb:Crop,scl:Crop,lat:number,lon:number):{r:number;g:number;b:number}|null {
  const colorIndex=pixel(rgb,lat,lon),sclIndex=pixel(scl,lat,lon);
  if(colorIndex===null||sclIndex===null)return null;
  // SCL 2,4,5,6,7,11 are usable; 0,1,3,8,9,10 and unknown classes are missing coverage.
  if(![2,4,5,6,7,11].includes(scl.values[sclIndex]))return null;
  const r=rgb.values[colorIndex],g=rgb.values[colorIndex+1],b=rgb.values[colorIndex+2];
  return r===0&&g===0&&b===0?null:{r,g,b};
}
function boundaryPoints(bounds:Bounds,width:number,height:number):Array<{lat:number;lon:number;covered:boolean}> {
  const points:Array<{lat:number;lon:number;covered:boolean}>=[];
  for(let column=0;column<=width;column++) {
    const lon=bounds.west+column/width*(bounds.east-bounds.west);
    points.push({lat:bounds.north,lon,covered:false},{lat:bounds.south,lon,covered:false});
  }
  for(let row=1;row<height;row++) {
    const lat=bounds.north-row/height*(bounds.north-bounds.south);
    points.push({lat,lon:bounds.west,covered:false},{lat,lon:bounds.east,covered:false});
  }
  return points;
}

export async function loadSentinelColorImage(requested:Bounds,options:SentinelImageOptions):Promise<SentinelColorImage> {
  const bounds=validBounds(requested);
  if(!options||typeof options.cacheDir!=='string'||!options.cacheDir.trim())imageFail('IMAGE_CACHE_REQUIRED','自动影像需要有效的本地缓存目录');
  if(options.lookbackMonths!==undefined&&options.lookbackMonths!==12&&options.lookbackMonths!==24)
    imageFail('IMAGE_REQUEST_INVALID','地表影像时间范围无效，请选择 12 个月或 24 个月后重试');
  const lookbackMonths=options.lookbackMonths??24;
  const directory=resolve(options.cacheDir),timeout=AbortSignal.timeout(Math.min(TIMEOUT_MS,Math.max(1,options.timeoutMs??TIMEOUT_MS)));
  const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  let progress=.02,coverage=0,downloadMessage='正在下载公开 Sentinel-2 影像';
  const budget=new DownloadBudget(()=>report('download',downloadMessage));
  function report(stage:'query'|'download'|'cloud'|'complete',message:string):void {
    options.onProgress?.({progress,message,stage,downloadedBytes:budget.downloadedBytes,cacheBytes:budget.cacheBytes,
      requestCount:budget.requestCount,coverage});
  }
  try {
    signal.throwIfAborted();
    const now=(options.now??(()=>new Date()))();
    if(!Number.isFinite(now.getTime()))imageFail('IMAGE_METADATA_INVALID','卫星影像获取时间无效');
    const cached=await readCache(directory,bounds,now,lookbackMonths);signal.throwIfAborted();
    if(cached) {progress=1;coverage=1;budget.cacheBytes=cached.image.metadata.byteLength;
      report('complete','已读取经过完整性校验的卫星影像缓存');return cached;}
    if(options.offlineOnly)imageFail('IMAGE_CACHE_MISS','此取景范围没有完整有效的卫星影像缓存，请联网重试或本地导入');
    const fetch=options.fetch??globalThis.fetch;
    report('query',`正在查询过去 ${lookbackMonths} 个月的公开 Sentinel-2 影像`);
    const candidates=await catalog(bounds,fetch,now,signal,lookbackMonths),{width,height}=dimensions(bounds);
    const bytes=new Uint8Array(width*height*3),covered=new Uint8Array(width*height),scenes:SentinelSceneSource[]=[];
    // Pixel centers alone could hide missing strips at the requested rectangle's edges.
    const boundary=boundaryPoints(bounds,width,height),coverageCount=covered.length+boundary.length;
    let remaining=coverageCount;
    for(let index=0;index<candidates.length&&remaining;index++) {
      signal.throwIfAborted();const candidate=candidates[index];
      progress=.05+.85*index/candidates.length;
      downloadMessage=`正在读取 ${candidate.datetime.slice(0,10)} 影像并筛除云层（${index+1}/${candidates.length}）`;
      report('download',downloadMessage);
      const siblings=new AbortController(),sceneSignal=AbortSignal.any([signal,siblings.signal]);
      const reads=[crop(candidate.visual,3,bounds,fetch,sceneSignal,budget,directory),crop(candidate.scl,1,bounds,fetch,sceneSignal,budget,directory)];
      let rgb:Crop|null,scl:Crop|null;
      try {[rgb,scl]=await Promise.all(reads);} catch(error) {
        siblings.abort(error);await Promise.allSettled(reads);throw error;
      }
      if(!rgb||!scl)continue;
      if(rgb.epsg!==scl.epsg)imageFail('IMAGE_CRS_UNSUPPORTED','卫星真彩色与云层分类坐标不一致');
      let added=0;
      for(let row=0;row<height;row++) {
        signal.throwIfAborted();const lat=bounds.north-(row+.5)/height*(bounds.north-bounds.south);
        for(let column=0;column<width;column++) {
          const offset=row*width+column;if(covered[offset])continue;
          const lon=bounds.west+(column+.5)/width*(bounds.east-bounds.west),color=validColor(rgb,scl,lat,lon);
          if(!color)continue;
          bytes.set([color.r,color.g,color.b],offset*3);covered[offset]=1;remaining--;added++;
        }
      }
      for(const point of boundary) {
        if(!point.covered&&validColor(rgb,scl,point.lat,point.lon)){point.covered=true;remaining--;added++;}
      }
      if(added)scenes.push({id:candidate.id,datetime:candidate.datetime,cloudCover:candidate.cloudCover});
      coverage=1-remaining/coverageCount;progress=.05+.85*(index+1)/candidates.length;
      report('cloud',`已筛选云层，取景覆盖 ${(coverage*100).toFixed(1)}%`);
    }
    if(remaining)imageFail('IMAGE_COVERAGE_INSUFFICIENT',`卫星影像仍有 ${(remaining/coverageCount*100).toFixed(1)}% 采样点存在云层或缺失覆盖，请重试、缩小取景范围或本地导入`);
    const header:CacheHeader={schema:1,collection:COLLECTION,bounds,width,height,scenes,retrievedAt:now.toISOString(),attribution:attribution(scenes)};
    try {await writeCache(directory,header,bytes,signal);} catch(error) {
      if(signal.aborted)throw error;throw new SentinelImageError('IMAGE_CACHE_WRITE_FAILED','卫星影像缓存无法保存，请检查可用空间后重试',error);
    }
    signal.throwIfAborted();progress=1;coverage=1;report('complete','卫星影像已完整覆盖取景范围并通过云层筛选');
    return result(header,bytes,false);
  } catch(error) {
    if(options.signal?.aborted)throw new SentinelImageError('IMAGE_ABORTED','卫星影像获取已取消，可以重试',error);
    if(timeout.aborted)throw new SentinelImageError('IMAGE_TIMEOUT','卫星影像获取超时，请重试或本地导入',error);
    if(budget.failure)throw budget.failure;
    if(error instanceof SentinelImageError)throw error;
    throw new SentinelImageError('IMAGE_NETWORK_FAILED','卫星影像无法获取或解析，请检查网络后重试，或本地导入 RGB GeoTIFF',error);
  }
}
