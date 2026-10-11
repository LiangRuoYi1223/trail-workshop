/** Copernicus GLO-30 public COG window loader. No full-tile download or API key. */
import { fromUrl } from 'geotiff';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { TerrainError } from '../errors.js';
import type { Bounds, DemSampler } from '../types.js';

const DATASET = 'Copernicus DEM GLO-30 Public (DSM)';
const ATTRIBUTION = 'Copernicus Digital Elevation Model was accessed from https://registry.opendata.aws/copernicus-dem.';
const ROWS = 3600;
const MAX_TILES = 9;
const MAX_PIXELS = 4_000_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const TIMEOUT_MS = 120_000;
const INDEX_EPSILON = 1e-7;
type Window = [number, number, number, number];
interface TileRecord {
  id: string; url: string; south: number; west: number;
  width: number; height: number; dx: number; dy: number;
  centerX: number; centerY: number; window: Window;
  offset: number; length: number; nodata?: number | 'NaN';
}
interface CacheHeader { schema: 1; dataset: string; requestedBounds: Bounds; tiles: TileRecord[] }
interface CacheManifest extends CacheHeader { sha256: string }
interface RasterTile extends TileRecord { values: Float64Array }
interface NamespaceIdentity { cacheDir: string; namespace: string }
export interface CopernicusImage {
  getWidth(): number; getHeight(): number; getSamplesPerPixel(): number;
  getGeoKeys(): Record<string, unknown> | null;
  getFileDirectory(): { loadValue(name: string): Promise<unknown>; hasTag(name: string): boolean };
  readRasters(options: {window: number[]; samples: number[]; interleave: boolean; signal: AbortSignal}): Promise<ArrayLike<number>>;
}
export interface CopernicusTiff { getImage(): Promise<CopernicusImage>; close(): Promise<void> }
/** Dependency injection exists for deterministic COG/HTTP tests; application callers omit it. */
export interface CopernicusDependencies {
  open?: (url: string, options: {allowFullFile: boolean; blockSize: number; cacheSize: number}, signal: AbortSignal) => Promise<CopernicusTiff>;
  timeoutMs?: number;
}
export interface CopernicusOptions {
  cacheDir: string; signal?: AbortSignal; offlineOnly?: boolean;
  onProgress?: (event: {progress: number; message: string}) => void;
}
const errorCode = (error: unknown): unknown => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
function fail(code: string, message: string): never { throw new TerrainError(code, message); }
function snap(index: number): number { const near = Math.round(index); return Math.abs(near - index) < INDEX_EPSILON ? near : index; }
function tileWidth(south: number): number {
  // A band at 50°N has 2400 columns; the corresponding southern tile is S51.
  const latitude = south >= 0 ? south : -south - 1;
  return latitude < 50 ? 3600 : latitude < 60 ? 2400 : latitude < 70 ? 1800 : latitude < 80 ? 1200 : latitude < 85 ? 720 : 360;
}
function tileIdentity(south: number, west: number): {id: string; url: string} {
  const lat = `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}_00`;
  const lon = `${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}_00`;
  const id = `Copernicus_DSM_COG_10_${lat}_${lon}_DEM`;
  return {id, url: `https://copernicus-dem-30m.s3.amazonaws.com/${id}/${id}.tif`};
}
function checkBounds(bounds: Bounds): Bounds {
  if (!bounds || !Object.values(bounds).every(Number.isFinite)
    || bounds.west < -180 || bounds.east > 180 || bounds.south <= -90 || bounds.north > 90
    || bounds.east <= bounds.west || bounds.north <= bounds.south) {
    fail('DEM_BOUNDS_INVALID', '高程选区无效；暂不支持跨越日期变更线或南极极点');
  }
  if (bounds.east - bounds.west > 2 || bounds.north - bounds.south > 2) {
    fail('DEM_REGION_TOO_LARGE', '自动高程选区过大，请缩小范围或导入已裁剪的本地 DEM');
  }
  return {west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north};
}
function planTiles(bounds: Bounds): TileRecord[] {
  const northRow = Math.ceil(snap(bounds.north * ROWS)) / ROWS;
  const southRow = Math.floor(snap(bounds.south * ROWS)) / ROWS;
  const minSouth = Math.floor(southRow - 1e-9);
  const maxSouth = Math.floor(northRow - 1e-9);
  const planned: TileRecord[] = [];
  let pixels = 0;
  for (let south = minSouth; south <= maxSouth; south++) {
    if (south < -90 || south >= 90) fail('DEM_COVERAGE_MISSING', '选区包含 Copernicus 未提供的极点边界，请缩小范围');
    const width = tileWidth(south), dx = 1 / width, dy = 1 / ROWS;
    const minWest = Math.floor(bounds.west);
    // The eastern halo comes from the next tile when the next source sample lies there.
    const maxWest = Math.floor(Math.ceil(snap(bounds.east * width)) / width + 1e-10);
    for (let west = minWest; west <= maxWest; west++) {
      if (west >= 180) fail('DEM_COVERAGE_MISSING', '选区接近日期变更线边界，请缩小范围');
      const x0 = Math.max(0, Math.floor(snap((bounds.west - west) / dx)));
      const x1 = Math.min(width, Math.ceil(snap((bounds.east - west) / dx)) + 1);
      const y0 = Math.max(0, Math.floor(snap(((south + 1) - northRow) / dy)));
      const y1 = Math.min(ROWS, Math.ceil(snap(((south + 1) - southRow) / dy)) + 1);
      if (x1 <= x0 || y1 <= y0) continue;
      const length = (x1 - x0) * (y1 - y0);
      planned.push({...tileIdentity(south, west), south, west, width, height: ROWS,
        dx, dy, centerX: west, centerY: south + 1, window: [x0,y0,x1,y1], offset: pixels, length});
      pixels += length;
    }
  }
  if (!planned.length || planned.length > MAX_TILES || pixels > MAX_PIXELS) {
    fail('DEM_REGION_TOO_LARGE', '自动高程最多读取 9 个瓦片及 400 万个选区像元，请缩小范围或使用本地 DEM');
  }
  return planned;
}
function numbers(value: unknown): number[] {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value))) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片缺少有效的地理控制点');
  const values = Array.from(value as ArrayLike<number>);
  if (!values.every(Number.isFinite)) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片控制点含无效数值');
  return values;
}
async function validateImage(image: CopernicusImage, tile: TileRecord): Promise<TileRecord> {
  const keys = image.getGeoKeys(), directory = image.getFileDirectory();
  if (keys?.GeographicTypeGeoKey !== 4326 || image.getSamplesPerPixel() !== 1
    || image.getWidth() !== tile.width || image.getHeight() !== ROWS
    || directory.hasTag('ModelTransformation')) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片坐标或栅格尺寸与官方 GLO-30 不一致');
  if (keys.VerticalUnitsGeoKey !== undefined && keys.VerticalUnitsGeoKey !== 9001) fail('DEM_SOURCE_INVALID', 'Copernicus 高程单位不是米');
  if (keys.ProjectedCSTypeGeoKey !== undefined || (keys.GTModelTypeGeoKey !== undefined && keys.GTModelTypeGeoKey !== 2)
    || (keys.GeogAngularUnitsGeoKey !== undefined && keys.GeogAngularUnitsGeoKey !== 9102)) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片不是经纬度网格');
  const rasterType = keys.GTRasterTypeGeoKey ?? 1;
  if (rasterType !== 1 && rasterType !== 2) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片栅格类型无法识别');
  const orientation = await directory.loadValue('Orientation');
  if (orientation !== undefined && orientation !== 1) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片方向不受支持');
  const scale = numbers(await directory.loadValue('ModelPixelScale'));
  const tie = numbers(await directory.loadValue('ModelTiepoint'));
  if (scale.length !== 3 || tie.length < 6 || tie.length % 6 !== 0 || tie[2] !== 0 || tie[5] !== 0) fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片仿射坐标无效');
  const offset = rasterType === 1 ? .5 : 0;
  const centerX = tie[3] - tie[0] * scale[0] + offset * scale[0];
  const centerY = tie[4] + tie[1] * scale[1] - offset * scale[1];
  if (Math.abs(scale[0] - tile.dx) > 1e-12 || Math.abs(scale[1] - tile.dy) > 1e-12
    || Math.abs(centerX - tile.west) > 1e-8 || Math.abs(centerY - tile.south - 1) > 1e-8) {
    fail('DEM_SOURCE_INVALID', 'Copernicus 瓦片采样中心与官方 1° 网格不一致，已停止以避免边界错位');
  }
  for (let i=0;i<tie.length;i+=6) if (tie[i+2] !== 0 || tie[i+5] !== 0
    || Math.abs(tie[i+3] - tie[i]*scale[0] + offset*scale[0] - centerX) > 1e-8
    || Math.abs(tie[i+4] + tie[i+1]*scale[1] - offset*scale[1] - centerY) > 1e-8) fail('DEM_SOURCE_INVALID', 'Copernicus 多个控制点不一致');
  const rawNoData = await directory.loadValue('GDAL_NODATA');
  let nodata: number | 'NaN' | undefined;
  if (rawNoData !== undefined) {
    if (typeof rawNoData !== 'string') fail('DEM_SOURCE_INVALID', 'Copernicus 缺值标记无效');
    const text = rawNoData.replace(/\0+$/u,'').trim();
    nodata = /^nan$/iu.test(text) ? 'NaN' : Number(text);
    if (nodata !== 'NaN' && (!text || !Number.isFinite(nodata))) fail('DEM_SOURCE_INVALID', 'Copernicus 缺值标记无法解析');
  }
  return {...tile, centerX, centerY, ...(nodata === undefined ? {} : {nodata})};
}
function makeSampler(bounds: Bounds, tiles: RasterTile[], sha256: string, cacheHit: boolean, cacheRecovered=false): DemSampler {
  const byLocation = new Map(tiles.map(tile => [`${tile.south},${tile.west}`,tile]));
  const point = (tile: RasterTile, x: number, y: number): number | null => {
    const [x0,y0,x1,y1]=tile.window;
    if (x<x0 || x>=x1 || y<y0 || y>=y1) return null;
    const value=tile.values[(y-y0)*(x1-x0)+(x-x0)];
    return Number.isFinite(value) && value !== tile.nodata ? value : null;
  };
  const rowSample = (lat: number, lon: number): {sum:number; weight:number} => {
    const south=Math.floor(lat-1e-9),west=Math.floor(lon),tile=byLocation.get(`${south},${west}`);
    if(!tile) return {sum:0,weight:0};
    const y=Math.round((tile.centerY-lat)/tile.dy);
    const x=snap((lon-tile.centerX)/tile.dx),left=Math.floor(x),fraction=x-left;
    let sum=0,weight=0;
    for(const [index,contribution] of [[left,1-fraction],[left+1,fraction]]) {
      if(contribution<=0) continue;
      const source=index===tile.width?byLocation.get(`${south},${west+1}`):tile;
      const value=source?point(source,index===tile.width?0:index,y):null;
      if(value!==null){sum+=value*contribution;weight+=contribution;}
    }
    return {sum,weight};
  };
  let missingPixels=0;
  for(const tile of tiles) for(const value of tile.values) if(!Number.isFinite(value)||value===tile.nodata)missingPixels++;
  return {
    sample(lat,lon) {
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<bounds.south||lat>bounds.north||lon<bounds.west||lon>bounds.east)return null;
      const y=snap((90-lat)*ROWS),northIndex=Math.floor(y),fraction=y-northIndex;
      let sum=0,weight=0;
      for(const [row,contribution]of [[northIndex,1-fraction],[northIndex+1,fraction]]) {
        if(contribution<=0)continue;
        const result=rowSample(90-row/ROWS,lon);
        sum+=result.sum*contribution;weight+=result.weight*contribution;
      }
      return weight>0?sum/weight:null;
    },
    metadata:{provider:'copernicus-glo30',dataset:DATASET,cacheHit, ...(cacheRecovered?{cacheRecovered:true}:{}),
      sha256,requestedBounds:bounds,bounds,sourceUrls:tiles.map(t=>t.url),tileCount:tiles.length,
      tiles:tiles.map(({values:_,...tile})=>tile),crs:'EPSG:4326',pixelIsArea:false,elevationUnit:'m',unitSource:'dataset-contract',
      validPixels:tiles.reduce((sum,tile)=>sum+tile.length,0)-missingPixels,missingPixels,attribution:ATTRIBUTION,
      warnings:['Copernicus GLO-30 是包含植被和建筑物的 DSM，不是裸地 DTM；未转换垂直基准。']},
  };
}
function checksum(header: CacheHeader, bytes: Buffer): string { return createHash('sha256').update(JSON.stringify(header)).update(bytes).digest('hex'); }
function canonical(path:string):string { const absolute=resolve(path);return process.platform==='win32'?absolute.toLowerCase():absolute; }
function unsafeCache():never { return fail('DEM_CACHE_UNSAFE','高程缓存含链接、目录替换或非普通文件，已停止读取；请使用正常本地缓存目录或导入本地 DEM'); }
async function assertDirectory(path:string):Promise<void>{
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||canonical(await realpath(path))!==canonical(path))unsafeCache();
}
async function makeSafeDirectory(path:string):Promise<void>{
  try{await assertDirectory(path);return;}catch(error){if(errorCode(error)!=='ENOENT')throw error;}
  const parent=dirname(path);
  if(parent===path)unsafeCache();
  // Validate existing ancestors before mkdir: a missing child below a junction
  // must not create a new directory in its redirected destination.
  await makeSafeDirectory(parent);await assertDirectory(parent);
  try{await mkdir(path);}catch(error){if(errorCode(error)!=='EEXIST')throw error;}
  await assertDirectory(path);
}
async function directoryIdentity(path:string):Promise<string>{const info=await lstat(path,{bigint:true});return `${info.dev}:${info.ino}`;}
async function assertNamespace(namespace:string,identity?:NamespaceIdentity):Promise<void>{
  await assertDirectory(dirname(namespace));await assertDirectory(namespace);
  if(identity&&(await directoryIdentity(dirname(namespace))!==identity.cacheDir||await directoryIdentity(namespace)!==identity.namespace))unsafeCache();
}
async function regularFile(path:string):Promise<Awaited<ReturnType<typeof lstat>>>{
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||canonical(await realpath(path))!==canonical(path))unsafeCache();
  return info;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolvePromise,reject)=>{
    const aborted=():void=>reject(signal.reason);
    signal.addEventListener('abort',aborted,{once:true});
    promise.then(resolvePromise,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}
async function openPublicCog(url: string, remoteOptions: {allowFullFile:boolean;blockSize:number;cacheSize:number}, signal: AbortSignal): Promise<CopernicusTiff> {
  // geotiff discards HTTP status in its generic errors. HEAD distinguishes genuinely
  // unavailable tiles from network failures without ever interpreting absence as sea level.
  const response=await fetch(url,{method:'HEAD',signal,redirect:'error'});
  await response.body?.cancel().catch(()=>{});
  if(response.status===404)fail('DEM_COVERAGE_MISSING','选区包含尚未公开或无覆盖的 Copernicus 瓦片，请缩小选区或导入本地 DEM');
  if(!response.ok)fail('DEM_FETCH_FAILED',`Copernicus 高程服务器返回 HTTP ${response.status}，请稍后重试或使用本地 DEM`);
  return fromUrl(url,remoteOptions,signal) as unknown as Promise<CopernicusTiff>;
}
async function readCache(path: string, bounds: Bounds, plan: TileRecord[], identity: NamespaceIdentity): Promise<DemSampler | null> {
  try {
    await assertNamespace(dirname(path),identity);
    try{await lstat(path);}catch(error){if(errorCode(error)==='ENOENT')return null;throw error;}
    await assertDirectory(path);
    const info=await regularFile(join(path,'manifest.json'));
    if(info.size>MAX_MANIFEST_BYTES)fail('DEM_CACHE_INVALID','高程缓存清单过大，无法安全读取');
    const manifest=JSON.parse(await readFile(join(path,'manifest.json'),'utf8')) as CacheManifest;
    const dataInfo=await regularFile(join(path,'elevations.bin'));
    if(dataInfo.size>MAX_PIXELS*8)fail('DEM_CACHE_INVALID','高程缓存数据过大');
    const bytes=await readFile(join(path,'elevations.bin'));
    if(manifest.schema!==1||manifest.dataset!==DATASET||JSON.stringify(manifest.requestedBounds)!==JSON.stringify(bounds)
      ||!Array.isArray(manifest.tiles)||manifest.tiles.length!==plan.length||! /^[0-9a-f]{64}$/u.test(manifest.sha256))fail('DEM_CACHE_INVALID','高程缓存清单不一致');
    const {sha256,...header}=manifest;
    if(checksum(header,bytes)!==sha256)fail('DEM_CACHE_INVALID','高程缓存校验失败，请联网重新获取或使用本地 DEM');
    let total=0;
    const tiles:RasterTile[]=manifest.tiles.map((tile,index)=>{
      const expected=plan[index];
      for(const field of ['id','url','south','west','width','height','dx','dy','offset','length']as const)if(tile[field]!==expected[field])fail('DEM_CACHE_INVALID','高程缓存网格与选区不一致');
      if(JSON.stringify(tile.window)!==JSON.stringify(expected.window)||!Number.isFinite(tile.centerX)||!Number.isFinite(tile.centerY)
        ||Math.abs(tile.centerX-tile.west)>1e-8||Math.abs(tile.centerY-tile.south-1)>1e-8
        ||(tile.nodata!==undefined&&tile.nodata!=='NaN'&&!Number.isFinite(tile.nodata)))fail('DEM_CACHE_INVALID','高程缓存坐标无效');
      total+=tile.length;
      const values=new Float64Array(tile.length);
      for(let n=0;n<values.length;n++)values[n]=bytes.readDoubleLE((tile.offset+n)*8);
      return {...tile,values};
    });
    if(bytes.length!==total*8)fail('DEM_CACHE_INVALID','高程缓存长度不一致');
    return makeSampler(bounds,tiles,sha256,true);
  } catch(error) {
    if(errorCode(error)==='ENOENT') {
      // A published directory with either file missing is corrupt, not a cache miss.
      try{await lstat(path);}catch(check){if(errorCode(check)==='ENOENT')return null;throw check;}
    }
    if(error instanceof TerrainError)throw error;
    if(['EACCES','EPERM','EIO'].includes(String(errorCode(error))))throw error;
    fail('DEM_CACHE_INVALID','高程缓存无法读取或校验，请联网重新获取或使用本地 DEM');
  }
}
async function removeOwnedTemporary(namespace:string,path:string,identity:NamespaceIdentity,temporaryIdentity?:string):Promise<void>{
  const absolute=resolve(path),root=resolve(namespace)+sep;
  if(!absolute.startsWith(root)||! /^\.partial-[a-zA-Z0-9-]+$/u.test(absolute.slice(root.length)))throw new Error('Unexpected temporary DEM path');
  await assertNamespace(namespace,identity);
  try{await assertDirectory(absolute);}catch(error){if(errorCode(error)==='ENOENT')return;throw error;}
  if(temporaryIdentity!==undefined&&await directoryIdentity(absolute)!==temporaryIdentity)unsafeCache();
  await rm(absolute,{recursive:true,force:true});
}
async function cleanOldTemporary(namespace:string,identity:NamespaceIdentity):Promise<void>{
  await assertNamespace(namespace,identity);
  for(const entry of await readdir(namespace,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&& /^\.partial-[a-zA-Z0-9-]+$/u.test(entry.name)){
    const path=join(namespace,entry.name);
    await assertDirectory(path);
    if(Date.now()-(await lstat(path)).mtimeMs>24*60*60*1000)await removeOwnedTemporary(namespace,path,identity);
  }
}
export async function loadCopernicusDem(input: Bounds, options: CopernicusOptions, deps: CopernicusDependencies={}): Promise<DemSampler> {
  const bounds=checkBounds(input),plan=planTiles(bounds);
  options.signal?.throwIfAborted();
  const namespace=join(resolve(options.cacheDir),'copernicus-glo30');
  const identity=createHash('sha256').update(JSON.stringify({schema:1,bounds})).digest('hex');
  const path=join(namespace,`window-v1-${identity}`);
  await makeSafeDirectory(dirname(namespace));await makeSafeDirectory(namespace);await assertNamespace(namespace);
  const ownership:NamespaceIdentity={cacheDir:await directoryIdentity(dirname(namespace)),namespace:await directoryIdentity(namespace)};
  let cacheRecovered=false;
  try {
    const cached=await readCache(path,bounds,plan,ownership);
    options.signal?.throwIfAborted();
    if(cached){options.onProgress?.({progress:1,message:'已校验并复用本地高程缓存'});return cached;}
  } catch(error) {
    options.signal?.throwIfAborted();
    if(!(error instanceof TerrainError)||error.code!=='DEM_CACHE_INVALID'||options.offlineOnly)throw error;
    // Preserve bad data for diagnosis, never merge it with a newly downloaded window.
    await assertNamespace(namespace,ownership);await assertDirectory(path);
    await rename(path,join(namespace,`.invalid-${identity}-${randomUUID()}`));
    cacheRecovered=true;
  }
  if(options.offlineOnly)fail('DEM_CACHE_MISS','此选区尚无已校验的离线高程缓存，请联网获取一次或导入本地 DEM');
  await cleanOldTemporary(namespace,ownership);
  const timeout=AbortSignal.timeout(deps.timeoutMs??TIMEOUT_MS);
  const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  const check=():void=>{options.signal?.throwIfAborted();if(timeout.aborted)fail('DEM_FETCH_TIMEOUT','自动高程下载超时，请重试或导入本地 DEM');};
  const open=deps.open??openPublicCog;
  const tiles:RasterTile[]=[];
  options.onProgress?.({progress:0,message:`正在获取 ${plan.length} 个 Copernicus 瓦片的选区`});
  for(const [index,planned]of plan.entries()){
    check();let tiff:CopernicusTiff|undefined;
    try{
      const opening=open(planned.url,{allowFullFile:false,blockSize:65536,cacheSize:16},signal);
      opening.then((late)=>{if(signal.aborted)void late.close().catch(()=>{});},()=>{});
      tiff=await abortable(opening,signal);
      check();const image=await abortable(tiff.getImage(),signal);check();const tile=await abortable(validateImage(image,planned),signal);check();
      const data=await abortable(image.readRasters({window:tile.window,samples:[0],interleave:true,signal}),signal);check();
      if(data.length!==tile.length)fail('DEM_SOURCE_INVALID','Copernicus 返回的选区像元数量不一致');
      tiles.push({...tile,values:Float64Array.from(data)});
      options.onProgress?.({progress:(index+1)/plan.length*.9,message:`已读取高程选区 ${index+1}/${plan.length}`});
    }catch(error){
      check();if(error instanceof TerrainError)throw error;
      const status=error&&typeof error==='object'&&'status'in error?error.status:undefined;
      if(status===404||errorCode(error)==='HTTP_404'||(error instanceof Error&&/\b404\b/u.test(error.message)))fail('DEM_COVERAGE_MISSING','选区包含尚未公开或无覆盖的 Copernicus 瓦片，请缩小选区或导入本地 DEM；未将缺失区域当作零高程');
      fail('DEM_FETCH_FAILED','无法获取公开 Copernicus 高程，请检查网络、稍后重试或导入本地 DEM');
    }finally{await tiff?.close().catch(()=>{});}
  }
  check();
  const total=tiles.reduce((sum,tile)=>sum+tile.length,0),bytes=Buffer.alloc(total*8);
  for(const tile of tiles)for(let n=0;n<tile.length;n++)bytes.writeDoubleLE(tile.values[n],(tile.offset+n)*8);
  const header:CacheHeader={schema:1,dataset:DATASET,requestedBounds:bounds,tiles:tiles.map(({values:_,...tile})=>tile)};
  const sha256=checksum(header,bytes),manifest:CacheManifest={...header,sha256};
  const temporary=join(namespace,`.partial-${process.pid}-${randomUUID()}`);
  let temporaryIdentity:string|undefined;
  const checkTemporary=async():Promise<void>=>{
    await assertNamespace(namespace,ownership);await assertDirectory(temporary);
    if(temporaryIdentity===undefined||await directoryIdentity(temporary)!==temporaryIdentity)unsafeCache();
  };
  try{
    await assertNamespace(namespace,ownership);await mkdir(temporary);await assertDirectory(temporary);
    temporaryIdentity=await directoryIdentity(temporary);
    await checkTemporary();
    await writeFile(join(temporary,'elevations.bin'),bytes,{flag:'wx'});check();
    await checkTemporary();
    await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest)+'\n',{flag:'wx'});check();
    await checkTemporary();
    await regularFile(join(temporary,'elevations.bin'));await regularFile(join(temporary,'manifest.json'));
    try{await assertDirectory(path);}catch(error){if(errorCode(error)!=='ENOENT')throw error;}
    try{await rename(temporary,path);}catch(error){
      if(!['EEXIST','ENOTEMPTY','EPERM'].includes(String(errorCode(error))))throw error;
      const winner=await readCache(path,bounds,plan,ownership);if(!winner)throw error;
    }
    check();
  }finally{await removeOwnedTemporary(namespace,temporary,ownership,temporaryIdentity).catch(()=>{});}
  options.onProgress?.({progress:1,message:'高程选区已下载并校验，已保存离线缓存'});
  return makeSampler(bounds,tiles,sha256,false,cacheRecovered);
}
