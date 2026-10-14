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
import { createSurfaceCoverageDomain, repairSurfaceGaps, type SurfaceCoverageDomain } from './surface-coverage.js';
export { SentinelImageError } from './online-remote.js';

const COLLECTION='sentinel-2-c1-l2a',SEARCH='https://earth-search.aws.element84.com/v1/search';
const MAX_WINDOW_PIXELS=4_000_000,MAX_BLOCK_PIXELS=1_048_576,MAX_OUTPUT_PIXELS=1_048_576;
const MAX_CANDIDATES=72,MAX_SCENES_PER_SUMMER=24,MAX_SCENES=120,TIMEOUT_MS=600_000;
const METERS_PER_DEGREE=111320;
interface Candidate extends SentinelSceneSource {visual:string;scl:string;tile:string}
interface Mapping {epsg:number;width:number;height:number;dx:number;dy:number;x:number;y:number}
interface SelectedRaster extends Mapping {window:[number,number,number,number];channels:number;image:GeoTIFFImage;tiff:GeoTIFF;client:SentinelRangeClient}
interface DemandGroup {window:[number,number,number,number];points:number[];pixels:number[];tiles:number[];westTile:number;eastTile:number;northTile:number;southTile:number}
type SummerHorizon=12|24|36|48|60;
type Footprint=ReadonlyArray<{lat:number;lon:number}>;
interface ModelCoverage {version:1;footprint:Footprint;grassSensitivity:number;modelPixels:number;filledPixels:number}
interface CacheHeader {schema:1;collection:typeof COLLECTION;bounds:Bounds;width:number;height:number;scenes:SentinelSceneSource[];retrievedAt:string;attribution:string;modelCoverage?:ModelCoverage}
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
const cacheKey=(bounds:Bounds,footprint?:Footprint,grassSensitivity=50):string=>sha(JSON.stringify(footprint?
  {schema:2,collection:COLLECTION,bounds,footprint,grassSensitivity,coverageVersion:1}:{schema:1,collection:COLLECTION,bounds}));
const payloadName=(key:string,digest:string):string=>`sentinel-${key.slice(0,16)}-${digest.slice(0,32)}.rgb`;
function attribution(scenes:SentinelSceneSource[]):string {
  return `Contains modified Copernicus Sentinel data ${Array.from(new Set(scenes.map(scene=>scene.datetime.slice(0,4)))).sort().join(', ')}`;
}
function headerOf(manifest:CacheHeader):CacheHeader {
  return {schema:1,collection:COLLECTION,bounds:manifest.bounds,width:manifest.width,height:manifest.height,
    scenes:manifest.scenes,retrievedAt:manifest.retrievedAt,attribution:manifest.attribution,
    ...(manifest.modelCoverage?{modelCoverage:manifest.modelCoverage}:{})};
}
function integrity(header:CacheHeader,bytes:Uint8Array):string {
  return createHash('sha256').update(JSON.stringify(header)).update(bytes).digest('hex');
}
function result(header:CacheHeader,bytes:Uint8Array,cacheHit:boolean):SentinelColorImage {
  const {bounds,width,height,scenes,retrievedAt}=header;
  const domain=header.modelCoverage?coverageDomain(bounds,width,height,header.modelCoverage.footprint):undefined;
  // Operational cache state and retrieval time are excluded from appearance identity.
  const identity={collection:COLLECTION,bounds,width,height,scenes,...(header.modelCoverage?{modelCoverage:header.modelCoverage}:{})};
  const metadata:ColorImageMetadata={sha256:createHash('sha256').update(JSON.stringify(identity)).update(bytes).digest('hex'),
    byteLength:bytes.length,width,height,bounds:{...bounds},crs:'EPSG:4326',pixelIsArea:true};
  const image:ColorImage={metadata,sample(lat,lon) {
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lon<bounds.west||lon>bounds.east||lat<bounds.south||lat>bounds.north)return null;
    const column=Math.min(width-1,Math.floor((lon-bounds.west)/(bounds.east-bounds.west)*width));
    const row=Math.min(height-1,Math.floor((bounds.north-lat)/(bounds.north-bounds.south)*height));
    const cell=row*width+column,index=cell*3;
    if(domain&&(!domain.demand[cell]||(bytes[index]===0&&bytes[index+1]===0&&bytes[index+2]===0)))return null;
    return {r:bytes[index],g:bytes[index+1],b:bytes[index+2]};
  }};
  const source:SurfaceImageSource={provider:'Sentinel-2',collection:COLLECTION,scenes:scenes.map(scene=>({...scene})),
    cacheHit,retrievedAt,bounds:{...bounds},attribution:header.attribution,
    ...(header.modelCoverage?{coverageRepair:{filledPixels:header.modelCoverage.filledPixels,modelPixels:header.modelCoverage.modelPixels}}:{})};
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
/** June-August in the selected latest one through five northern summers, capped at today. */
function summerIntervals(now:Date,lookbackMonths:SummerHorizon):Array<{start:Date;end:Date}> {
  const latestYear=now.getUTCFullYear()-(now.getUTCMonth()<5?1:0);
  return Array.from({length:lookbackMonths/12},(_,index)=>{
    const year=latestYear-lookbackMonths/12+1+index;
    return {start:new Date(Date.UTC(year,5,1)),end:new Date(Math.min(Date.UTC(year,8,1)-1,now.getTime()))};
  });
}
function eligibleSummerDate(datetime:string,intervals:Array<{start:Date;end:Date}>):boolean {
  const time=Date.parse(datetime);
  return Number.isFinite(time)&&intervals.some(({start,end})=>time>=start.getTime()&&time<=end.getTime());
}
function validFootprint(value:Footprint|undefined,bounds:Bounds):Footprint|undefined {
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length<3||value.length>4096||value.some(point=>!point||!Number.isFinite(point.lat)||!Number.isFinite(point.lon)
    ||point.lat<bounds.south-1e-10||point.lat>bounds.north+1e-10||point.lon<bounds.west-1e-10||point.lon>bounds.east+1e-10))
    imageFail('IMAGE_REQUEST_INVALID','地表影像的模型轮廓无效或超出取景范围，请重新取景');
  return value.map(point=>({lat:point.lat,lon:point.lon}));
}
function coverageDomain(bounds:Bounds,width:number,height:number,footprint:Footprint):SurfaceCoverageDomain {
  return createSurfaceCoverageDomain({width,height,polygon:footprint.map(point=>({
    x:(point.lon-bounds.west)/(bounds.east-bounds.west)*width,y:(bounds.north-point.lat)/(bounds.north-bounds.south)*height})),
    pixelWidthM:(bounds.east-bounds.west)*METERS_PER_DEGREE*Math.cos((bounds.north+bounds.south)*Math.PI/360)/width,
    pixelHeightM:(bounds.north-bounds.south)*METERS_PER_DEGREE/height});
}
async function readCache(directory:string,bounds:Bounds,now:Date,lookbackMonths:SummerHorizon,footprint?:Footprint,grassSensitivity=50):Promise<SentinelColorImage|null> {
  try {
    await validateCacheDirectory(directory);
    const key=cacheKey(bounds,footprint,grassSensitivity),manifest=JSON.parse(new TextDecoder().decode(await readSmallFile(join(directory,`sentinel-${key}.json`),256*1024))) as Manifest;
    const size=dimensions(bounds);
    if(manifest.schema!==1||manifest.collection!==COLLECTION||JSON.stringify(manifest.bounds)!==JSON.stringify(bounds)
      ||manifest.width!==size.width||manifest.height!==size.height||!Array.isArray(manifest.scenes)||manifest.scenes.length<1
      ||manifest.scenes.length>MAX_SCENES||!manifest.scenes.every(validScene)||typeof manifest.retrievedAt!=='string'
      ||!Number.isFinite(Date.parse(manifest.retrievedAt))||Date.parse(manifest.retrievedAt)>now.getTime()
      ||manifest.scenes.some(scene=>!eligibleSummerDate(scene.datetime,summerIntervals(now,lookbackMonths)))
      ||manifest.attribution!==attribution(manifest.scenes)
      ||!/^[a-f0-9]{64}$/u.test(manifest.dataSha256)||manifest.dataFile!==payloadName(key,manifest.dataSha256))return null;
    const model=manifest.modelCoverage;
    if(footprint?(!model||model.version!==1||JSON.stringify(model.footprint)!==JSON.stringify(footprint)||model.grassSensitivity!==grassSensitivity
      ||model.modelPixels!==coverageDomain(bounds,size.width,size.height,footprint).modelCount||!Number.isSafeInteger(model.filledPixels)
      ||model.filledPixels<0||model.filledPixels/model.modelPixels>=.01):model!==undefined)return null;
    const bytes=await readSmallFile(join(directory,manifest.dataFile),MAX_OUTPUT_PIXELS*3),header=headerOf(manifest);
    if(bytes.length!==manifest.width*manifest.height*3||sha(bytes)!==manifest.dataSha256||integrity(header,bytes)!==manifest.integrity)return null;
    await validateCacheDirectory(directory);return result(header,bytes,true);
  } catch {return null;}
}
async function writeCache(directory:string,header:CacheHeader,bytes:Uint8Array,signal:AbortSignal):Promise<void> {
  const key=cacheKey(header.bounds,header.modelCoverage?.footprint,header.modelCoverage?.grassSensitivity),dataSha256=sha(bytes),dataFile=payloadName(key,dataSha256);
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
async function catalog(bounds:Bounds,fetch:typeof globalThis.fetch,now:Date,signal:AbortSignal,lookbackMonths:SummerHorizon,budget:DownloadBudget):Promise<Candidate[]> {
  const intervals=summerIntervals(now,lookbackMonths),candidates:Candidate[]=[];
  // Query each summer separately so low-cloud winter scenes cannot exhaust the result limit.
  for(const {start,end} of intervals) {
    signal.throwIfAborted();
    const bytes=await budget.retry(async()=>{
      signal.throwIfAborted();const reservation=budget.reserve(2*1024*1024);
      try {
        budget.requestCount++;budget.catalogRequestCount++;
        const response=await fetch(SEARCH,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal,
          body:JSON.stringify({collections:[COLLECTION],bbox:[bounds.west,bounds.south,bounds.east,bounds.north],
            datetime:`${start.toISOString()}/${end.toISOString()}`,limit:MAX_CANDIDATES,
            sortby:[{field:'properties.eo:cloud_cover',direction:'asc'},{field:'properties.datetime',direction:'desc'}]})});
        if(!response.ok) {await response.body?.cancel();throw new SentinelImageError('IMAGE_NETWORK_FAILED',`卫星影像目录 HTTP ${response.status}，请重试或本地导入`,undefined,response.status);}
        return await readBoundedBody(response,2*1024*1024,signal,bytes=>reservation.consume(bytes));
      } finally {reservation.release();}
    },signal);
    let document:{features?:unknown[]};try {document=JSON.parse(new TextDecoder().decode(bytes));} catch {return imageFail('IMAGE_CATALOG_INVALID','卫星影像目录响应无效，请重试');}
    if(!Array.isArray(document.features)||document.features.length>MAX_CANDIDATES)imageFail('IMAGE_CATALOG_INVALID','卫星影像目录响应超出允许范围');
    for(const feature of document.features) {
      if(!feature||typeof feature!=='object')continue;
      const item=feature as {id?:unknown;collection?:unknown;properties?:Record<string,unknown>;bbox?:unknown;assets?:Record<string,{href?:unknown}>};
      const datetime=item.properties?.datetime,cloud=item.properties?.['eo:cloud_cover'];
      if(item.collection!==COLLECTION||typeof item.id!=='string'||item.id.length<1||item.id.length>200
        ||typeof datetime!=='string'||!eligibleSummerDate(datetime,[{start,end}])
        ||typeof cloud!=='number'||!Number.isFinite(cloud)||cloud<0||cloud>100||!item.assets?.visual||!item.assets?.scl)continue;
      const bbox=item.bbox;
      if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite)||bbox[0]>=bounds.east||bbox[2]<=bounds.west||bbox[1]>=bounds.north||bbox[3]<=bounds.south
        ||candidates.some(candidate=>candidate.id===item.id))continue;
      candidates.push({id:item.id,datetime:new Date(datetime).toISOString(),cloudCover:cloud,
        visual:safeSentinelAsset(item.assets.visual.href),scl:safeSentinelAsset(item.assets.scl.href),
        tile:/_T(\d{2}[A-Z]{3})_/u.exec(item.id)?.[1]??JSON.stringify(bbox)});
    }
  }
  // Tile cloud scores describe the whole ~110km tile, not this small AOI. Within
  // similarly clear five-percent buckets prefer fresh imagery, then verify actual SCL pixels.
  candidates.sort((a,b)=>new Date(b.datetime).getUTCFullYear()-new Date(a.datetime).getUTCFullYear()||Math.floor(a.cloudCover/5)-Math.floor(b.cloudCover/5)
    ||Date.parse(b.datetime)-Date.parse(a.datetime)||a.cloudCover-b.cloudCover||a.id.localeCompare(b.id));
  // Round-robin tiles so a very clear tile cannot starve another tile of candidates.
  const ordered:Candidate[]=[];
  const years=[...new Set(candidates.map(candidate=>new Date(candidate.datetime).getUTCFullYear()))];
  for(const year of years) {
    const groups=new Map<string,Candidate[]>();for(const candidate of candidates) {
      if(new Date(candidate.datetime).getUTCFullYear()!==year)continue;
      const group=groups.get(candidate.tile)??[];group.push(candidate);groups.set(candidate.tile,group);
    }
    let selected=0;
    while(selected<MAX_SCENES_PER_SUMMER) {
      let added=false;for(const group of groups.values()) {
        const candidate=group.shift();if(candidate){ordered.push(candidate);selected++;added=true;}
        if(selected===MAX_SCENES_PER_SUMMER)break;
      }
      if(!added)break;
    }
  }
  if(!ordered.length)imageFail('IMAGE_SCENE_UNAVAILABLE',`最近 ${lookbackMonths/12} 个夏季（6–8月）没有可用的 Sentinel-2 地表影像，请重试或本地导入`);
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
function rasterFailure(error:unknown,budget:DownloadBudget,signal:AbortSignal):never {
  if(signal.aborted||error instanceof SentinelImageError)throw error;
  if(budget.failure)throw budget.failure;
  throw new SentinelImageError('IMAGE_INVALID_RASTER',`卫星 TIFF 无法解析：${error instanceof Error?error.message:String(error)}`,error);
}
/** Select the same bounded overview as the former whole-AOI reader, without reading pixels yet. */
async function openRaster(url:string,channels:number,bounds:Bounds,fetch:typeof globalThis.fetch,signal:AbortSignal,budget:DownloadBudget,cacheDir:string):Promise<SelectedRaster|null> {
  let tiff:GeoTIFF|undefined;
  try {
    const client=new SentinelRangeClient(url,fetch,signal,budget,cacheDir);
    tiff=await fromCustomClient(client,{allowFullFile:false,maxRanges:0},signal);
    const root=await tiff.getImage(),base=await mapping(root);let image=root,geometry=base,window=windowFor(base,bounds);
    if(!window){await tiff.close();return null;}
    await validatePixels(root,channels);
    if((window[2]-window[0])*(window[3]-window[1])>MAX_WINDOW_PIXELS) {
      const count=await tiff.getImageCount();
      if(count>12)imageFail('IMAGE_PIXEL_LIMIT','卫星影像包含过多概览');
      for(let index=1;index<count;index++) {
        image=await tiff.getImage(index);await validatePixels(image,channels);
        const width=image.getWidth(),height=image.getHeight();
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>base.width||height>base.height)
          imageFail('IMAGE_PIXEL_LIMIT','卫星影像概览尺寸无效');
        geometry={...base,width,height,dx:base.dx*base.width/width,dy:base.dy*base.height/height};window=windowFor(geometry,bounds);
        if(window&&(window[2]-window[0])*(window[3]-window[1])<=MAX_WINDOW_PIXELS)break;
      }
    }
    if(!window){await tiff.close();return null;}
    if((window[2]-window[0])*(window[3]-window[1])>MAX_WINDOW_PIXELS)
      imageFail('IMAGE_PIXEL_LIMIT','卫星影像裁剪范围超出像素限制，请缩小取景范围');
    return {...geometry,window,channels,image,tiff,client};
  } catch(error) {await tiff?.close();rasterFailure(error,budget,signal);}
}
function sourcePixel(raster:SelectedRaster,lat:number,lon:number):number|null {
  const point=projectUtm(lat,lon,raster.epsg),tolerance=.001;
  if(point.x<raster.x-tolerance||point.x>raster.x+raster.width*raster.dx+tolerance
    ||point.y>raster.y+tolerance||point.y<raster.y-raster.height*raster.dy-tolerance)return null;
  const column=Math.max(0,Math.min(raster.width-1,Math.floor((point.x-raster.x)/raster.dx)));
  const row=Math.max(0,Math.min(raster.height-1,Math.floor((raster.y-point.y)/raster.dy)));
  const [west,north,east,south]=raster.window;
  return column<west||column>=east||row<north||row>=south?null:row*raster.width+column;
}
function mergeDemandGroups(groups:DemandGroup[],vertical=false):DemandGroup[] {
  const merged:DemandGroup[]=[];
  for(const group of groups) {
    const previous=merged.at(-1),window:DemandGroup['window']=previous?
      [Math.min(previous.window[0],group.window[0]),Math.min(previous.window[1],group.window[1]),
        Math.max(previous.window[2],group.window[2]),Math.max(previous.window[3],group.window[3])]:group.window;
    const adjacent=previous&&(vertical?
      previous.westTile===group.westTile&&previous.eastTile===group.eastTile&&previous.southTile+1===group.northTile:
      previous.northTile===group.northTile&&previous.southTile===group.southTile&&previous.eastTile+1===group.westTile);
    if(adjacent&&previous.tiles.length+group.tiles.length<=8&&(window[2]-window[0])*(window[3]-window[1])<=MAX_WINDOW_PIXELS) {
      previous.window=window;previous.eastTile=Math.max(previous.eastTile,group.eastTile);previous.southTile=Math.max(previous.southTile,group.southTile);
      for(let index=0;index<group.points.length;index++){previous.points.push(group.points[index]);previous.pixels.push(group.pixels[index]);}
      previous.tiles.push(...group.tiles);
    } else merged.push(group);
  }
  return merged;
}
/** Group only demanded pixels; adjacent groups share bounded TIFF reads and every native tile is decoded once. */
async function readDemandPixels(raster:SelectedRaster,needed:Iterable<number>,pointAt:(index:number)=>{lat:number;lon:number},signal:AbortSignal,
  visit:(point:number,values:Uint8Array,offset:number)=>void,budget:DownloadBudget):Promise<void> {
  const tileWidth=raster.image.getTileWidth(),tileHeight=raster.image.getTileHeight(),tilesWide=Math.ceil(raster.width/tileWidth);
  const groups=new Map<number,DemandGroup>();let checked=0;
  for(const index of needed) {
    if((checked++&4095)===0)signal.throwIfAborted();const point=pointAt(index),pixel=sourcePixel(raster,point.lat,point.lon);if(pixel===null)continue;
    const column=pixel%raster.width,row=Math.floor(pixel/raster.width),x=Math.floor(column/tileWidth),y=Math.floor(row/tileHeight),tile=y*tilesWide+x;
    let group=groups.get(tile);
    if(!group){group={window:[column,row,column+1,row+1],points:[],pixels:[],tiles:[tile],westTile:x,eastTile:x,northTile:y,southTile:y};groups.set(tile,group);}
    group.points.push(index);group.pixels.push(pixel);
    group.window=[Math.min(group.window[0],column),Math.min(group.window[1],row),Math.max(group.window[2],column+1),Math.max(group.window[3],row+1)];
  }
  const ordered=mergeDemandGroups(mergeDemandGroups([...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([,group])=>group)),true);
  for(const group of ordered) {
    signal.throwIfAborted();const directory=raster.image.getFileDirectory(),ranges:Array<{offset:number;length:number}>=[];
    const perPlane=tilesWide*Math.ceil(raster.height/tileHeight),planes=raster.image.planarConfiguration===2?raster.channels:1;
    for(const tile of group.tiles)for(let sample=0;sample<planes;sample++) {
      const index=sample*perPlane+tile,offsetTag=raster.image.isTiled?'TileOffsets':'StripOffsets',countTag=raster.image.isTiled?'TileByteCounts':'StripByteCounts';
      const [rawOffset,rawLength]=await Promise.all([directory.loadValueIndexed(offsetTag,index),directory.loadValueIndexed(countTag,index)]).catch(error=>rasterFailure(error,budget,signal));
      const offset=Number(rawOffset),length=Number(rawLength);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||offset+length>2*1024*1024*1024)
        imageFail('IMAGE_INVALID_RASTER','卫星影像数据块位置或长度无效');
      if(length)ranges.push({offset,length});
    }
    await raster.client.prefetch(ranges,signal);
    const window=group.window,pixels=(window[2]-window[0])*(window[3]-window[1]);
    const values=await raster.image.readRasters({window,samples:Array.from({length:raster.channels},(_,index)=>index),interleave:true,signal}).catch(error=>rasterFailure(error,budget,signal));
    if(!(values instanceof Uint8Array)||values.length!==pixels*raster.channels)imageFail('IMAGE_INVALID_RASTER','卫星影像裁剪像元无效');
    for(let index=0;index<group.points.length;index++) {
      if((index&4095)===0)signal.throwIfAborted();const pixel=group.pixels[index],column=pixel%raster.width,row=Math.floor(pixel/raster.width);
      visit(group.points[index],values,((row-window[1])*(window[2]-window[0])+column-window[0])*raster.channels);
    }
  }
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
  if(options.lookbackMonths!==undefined&&![12,24,36,48,60].includes(options.lookbackMonths))
    imageFail('IMAGE_REQUEST_INVALID','地表影像时间范围无效，请选择最近 1–5 个夏季后重试');
  const lookbackMonths=options.lookbackMonths??24;
  const footprint=validFootprint(options.modelFootprint,bounds),grassSensitivity=options.grassSensitivity??50;
  if(!Number.isFinite(grassSensitivity)||grassSensitivity<0||grassSensitivity>100)imageFail('IMAGE_REQUEST_INVALID','草地识别灵敏度须在 0–100 之间');
  const size=dimensions(bounds),domain=footprint?coverageDomain(bounds,size.width,size.height,footprint):undefined;
  const directory=resolve(options.cacheDir),timeout=AbortSignal.timeout(Math.min(TIMEOUT_MS,Math.max(1,options.timeoutMs??TIMEOUT_MS)));
  const taskAbort=new AbortController(),signal=AbortSignal.any(options.signal?[options.signal,timeout,taskAbort.signal]:[timeout,taskAbort.signal]);
  let progress=.02,coverage=0,downloadMessage='正在下载公开 Sentinel-2 影像',sceneId:string|undefined,sceneDate:string|undefined,sceneContribution=0,attemptedScenes=0;
  const budget=new DownloadBudget(()=>report('download',downloadMessage));
  function report(stage:'query'|'download'|'cloud'|'complete',message:string):void {
    options.onProgress?.({progress,message,stage,downloadedBytes:budget.downloadedBytes,cacheBytes:budget.cacheBytes,
      requestCount:budget.requestCount,catalogRequestCount:budget.catalogRequestCount,rangeRequestCount:budget.rangeRequestCount,
      retryCount:budget.retryCount,downloadBudgetBytes:budget.downloadBudgetBytes,reservedBytes:budget.reserved,coverage,
      sceneId,sceneDate,sceneContribution,attemptedScenes});
  }
  try {
    signal.throwIfAborted();
    const now=(options.now??(()=>new Date()))();
    if(!Number.isFinite(now.getTime()))imageFail('IMAGE_METADATA_INVALID','卫星影像获取时间无效');
    const cached=await readCache(directory,bounds,now,lookbackMonths,footprint,grassSensitivity);signal.throwIfAborted();
    if(cached) {progress=1;coverage=1;budget.cacheBytes=cached.image.metadata.byteLength;
      report('complete','已读取经过完整性校验的卫星影像缓存');return cached;}
    if(options.offlineOnly)imageFail('IMAGE_CACHE_MISS','此取景范围没有符合夏季日期的完整有效影像缓存，请联网重试或本地导入');
    const fetch=options.fetch??globalThis.fetch;
    report('query',`正在查询最近 ${lookbackMonths/12} 个夏季（6–8月）的公开 Sentinel-2 影像`);
    const candidates=await catalog(bounds,fetch,now,signal,lookbackMonths,budget),{width,height}=size;
    const bytes=new Uint8Array(width*height*3),covered=new Uint8Array(width*height),scenes:SentinelSceneSource[]=[];
    // Pixel centers alone could hide missing strips at the requested rectangle's edges.
    const boundary=domain?[]:boundaryPoints(bounds,width,height),coverageCount=domain?.modelCount??covered.length+boundary.length;
    let remaining=coverageCount;
    const pointAt=(index:number):{lat:number;lon:number}=>index<covered.length?
      {lat:bounds.north-(Math.floor(index/width)+.5)/height*(bounds.north-bounds.south),
        lon:bounds.west+(index%width+.5)/width*(bounds.east-bounds.west)}:boundary[index-covered.length];
    function* missingPoints():Generator<number> {
      for(let index=0;index<covered.length;index++)if(!covered[index]&&(!domain||domain.demand[index]))yield index;
      for(let index=0;index<boundary.length;index++)if(!boundary[index].covered)yield covered.length+index;
    }
    for(let index=0;index<candidates.length&&remaining;index++) {
      signal.throwIfAborted();const candidate=candidates[index];sceneId=candidate.id;sceneDate=candidate.datetime;sceneContribution=0;attemptedScenes=index+1;
      progress=.05+.85*index/candidates.length;
      downloadMessage=`正在读取 ${candidate.datetime.slice(0,10)} 云层分类并检查缺口（${index+1}/${candidates.length}）`;
      report('download',downloadMessage);
      const eligible=new Uint8Array(covered.length+boundary.length);let eligibleCount=0;
      const scl=await openRaster(candidate.scl,1,bounds,fetch,signal,budget,directory);
      if(!scl)continue;
      try {
        await readDemandPixels(scl,missingPoints(),pointAt,signal,(point,values,offset)=>{
          if([2,4,5,6,7,11].includes(values[offset])){eligible[point]=1;eligibleCount++;}
        },budget);
      } finally {await scl.tiff.close();}
      let added=0;
      if(eligibleCount) {
        function* eligiblePoints():Generator<number>{for(let point=0;point<eligible.length;point++)if(eligible[point])yield point;}
        downloadMessage=`正在读取 ${candidate.datetime.slice(0,10)} 可补缺口的彩色数据块（${index+1}/${candidates.length}）`;
        const rgb=await openRaster(candidate.visual,3,bounds,fetch,signal,budget,directory);
        if(rgb)try {
          if(rgb.epsg!==scl.epsg)imageFail('IMAGE_CRS_UNSUPPORTED','卫星真彩色与云层分类坐标不一致');
          await readDemandPixels(rgb,eligiblePoints(),pointAt,signal,(point,values,offset)=>{
            const r=values[offset],g=values[offset+1],b=values[offset+2];if(r===0&&g===0&&b===0)return;
            if(point<covered.length){bytes.set([r,g,b],point*3);covered[point]=1;}else boundary[point-covered.length].covered=true;
            if(!domain||domain.model[point])remaining--;added++;
          },budget);
        } finally {await rgb.tiff.close();}
      }
      if(added)scenes.push({id:candidate.id,datetime:candidate.datetime,cloudCover:candidate.cloudCover});
      sceneContribution=added;coverage=1-remaining/coverageCount;progress=.05+.85*(index+1)/candidates.length;
      report('cloud',eligibleCount?`已校验云层与彩色像元，取景覆盖 ${(coverage*100).toFixed(1)}%`:
        `此景不能补上未覆盖缺口，已跳过彩色影像；取景覆盖 ${(coverage*100).toFixed(1)}%`);
    }
    let filledPixels=0;
    if(remaining&&domain) {
      filledPixels=repairSurfaceGaps({bytes,covered,domain,grassSensitivity,signal}).repaired;
      remaining=0;
    }
    if(remaining)imageFail('IMAGE_COVERAGE_INSUFFICIENT',`夏季覆盖不足：仍有 ${remaining} 个中心或边缘采样点（${(remaining/coverageCount*100).toFixed(6)}%）存在云层、无效彩色像元或缺失覆盖；请重试、缩小取景范围或本地导入`);
    const header:CacheHeader={schema:1,collection:COLLECTION,bounds,width,height,scenes,retrievedAt:now.toISOString(),attribution:attribution(scenes),
      ...(footprint?{modelCoverage:{version:1,footprint,grassSensitivity,modelPixels:coverageCount,filledPixels}}:{})};
    try {await writeCache(directory,header,bytes,signal);} catch(error) {
      if(signal.aborted)throw error;throw new SentinelImageError('IMAGE_CACHE_WRITE_FAILED','卫星影像缓存无法保存，请检查可用空间后重试',error);
    }
    signal.throwIfAborted();progress=1;coverage=1;report('complete',filledPixels?`模型地表已通过覆盖校验，依据邻近草地或山石补齐 ${filledPixels} 个小缺口采样点`:
      domain?'卫星影像已覆盖实际模型轮廓并通过云层筛选':'卫星影像已完整覆盖取景范围并通过云层筛选');
    return result(header,bytes,false);
  } catch(error) {
    taskAbort.abort(error);
    if(options.signal?.aborted)throw new SentinelImageError('IMAGE_ABORTED','卫星影像获取已取消，可以重试',error);
    if(timeout.aborted)throw new SentinelImageError('IMAGE_TIMEOUT','网络超时：夏季影像读取超过共享时限，请重试或本地导入',error);
    if(budget.failure)throw budget.failure;
    if(error instanceof SentinelImageError)throw error;
    throw new SentinelImageError('IMAGE_NETWORK_FAILED',budget.retryCount===2?'两次重试后网络仍无法读取夏季影像，请检查网络后重试或本地导入 RGB GeoTIFF':'夏季影像无法获取或解析，请检查网络后重试或本地导入 RGB GeoTIFF',error);
  }
}
