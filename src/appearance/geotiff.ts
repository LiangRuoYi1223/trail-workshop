import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fromArrayBuffer } from 'geotiff';
import type { ColorImage, ColorImageMetadata } from './types.js';

const MAX_BYTES=64*1024*1024,MAX_PIXELS=16777216,R=6378137,RAD=Math.PI/180;
const MERCATOR_LIMIT=Math.PI*R;
export class ColorGeoTiffError extends Error {
  constructor(public readonly code:string,message:string,cause?:unknown) {super(message,{cause});this.name='ColorGeoTiffError';}
}
function fail(code:string,message:string):never {throw new ColorGeoTiffError(code,message);}
function numbers(value:unknown,label:string):number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) fail('IMAGE_TRANSFORM_UNSUPPORTED',`地表影像缺少北向 ${label} 映射`);
  const out=Array.from(value as ArrayLike<number>);
  if(!out.every(Number.isFinite)) fail('IMAGE_TRANSFORM_UNSUPPORTED','地表影像北向映射包含无效数字');
  return out;
}
function channelNumbers(value:unknown,fallback:number,count:number):number[] {
  if(value===undefined) return Array(count).fill(fallback);
  return typeof value==='number' ? [value] : numbers(value,'RGB 通道');
}
function unproject(x:number,y:number):{lon:number;lat:number} {
  return {lon:x/R/RAD,lat:(2*Math.atan(Math.exp(y/R))-Math.PI/2)/RAD};
}

/** Only local north-up 8-bit RGB/RGBA rasters are accepted; no inferred CRS. */
export async function loadColorGeoTiff(path:string):Promise<ColorImage> {
  try {
    const handle=await open(path,'r');
    let bytes:Uint8Array;
    try {
      const before=await handle.stat();
      if(!before.isFile() || before.size<1) fail('IMAGE_INVALID_FILE','地表影像不是有效文件');
      if(before.size>MAX_BYTES) fail('IMAGE_FILE_TOO_LARGE','地表影像文件不能超过 64 MB');
      bytes=new Uint8Array(before.size);
      let offset=0;
      while(offset<bytes.length) {
        const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
        if(bytesRead===0) fail('IMAGE_INVALID_FILE','地表影像读取期间文件内容发生变化');
        offset+=bytesRead;
      }
      const after=await handle.stat();
      if(after.size!==before.size || after.mtimeMs!==before.mtimeMs)
        fail('IMAGE_INVALID_FILE','地表影像读取期间文件内容发生变化');
    } finally {await handle.close();}
    const tiff=await fromArrayBuffer(bytes.buffer as ArrayBuffer);
    const image=await tiff.getImage();
    const width=image.getWidth(),height=image.getHeight();
    // Do this before readRasters (which allocates the decoded raster).
    if(!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width<1 || height<1 || width*height>MAX_PIXELS)
      fail('IMAGE_PIXEL_LIMIT','地表影像像素上限为 16,777,216');
    const channels=image.getSamplesPerPixel();
    const directory=image.getFileDirectory(),keys=image.getGeoKeys();
    if(channels!==3 && channels!==4) fail('IMAGE_RGB_UNSUPPORTED','地表影像须为 RGB 或 RGBA 三/四通道');
    if(await directory.loadValue('PhotometricInterpretation')!==2)
      fail('IMAGE_RGB_UNSUPPORTED','地表影像须明确声明 RGB 通道');
    const bits=channelNumbers(await directory.loadValue('BitsPerSample'),1,channels);
    const formats=channelNumbers(await directory.loadValue('SampleFormat'),1,channels);
    if(bits.length!==channels || bits.some(value=>value!==8) || formats.length!==channels || formats.some(value=>value!==1))
      fail('IMAGE_RGB_UNSUPPORTED','地表影像仅支持无符号 8 位 RGB/RGBA 通道');
    const extra=channelNumbers(await directory.loadValue('ExtraSamples'),0,channels-3);
    if(channels===4 && (extra.length!==1 || (extra[0]!==1 && extra[0]!==2)))
      fail('IMAGE_RGB_UNSUPPORTED','RGBA 地表影像必须明确声明透明度通道');
    if(channels===3 && extra.some(value=>value!==0)) fail('IMAGE_RGB_UNSUPPORTED','RGB 地表影像含不支持的额外通道');
    let crs:ColorImageMetadata['crs'];
    if(keys?.GeographicTypeGeoKey===4326 && keys.ProjectedCSTypeGeoKey===undefined
      && (keys.GTModelTypeGeoKey===undefined || keys.GTModelTypeGeoKey===2)) crs='EPSG:4326';
    else if(keys?.ProjectedCSTypeGeoKey===3857 && (keys.GTModelTypeGeoKey===undefined || keys.GTModelTypeGeoKey===1)
      && (keys.GeographicTypeGeoKey===undefined || keys.GeographicTypeGeoKey===4326)) crs='EPSG:3857';
    else fail('IMAGE_CRS_UNSUPPORTED','地表影像坐标须明确声明 EPSG:4326 或 EPSG:3857');
    if((keys.GeogAngularUnitsGeoKey!==undefined && keys.GeogAngularUnitsGeoKey!==9102)
      || (crs==='EPSG:3857' && keys.ProjLinearUnitsGeoKey!==undefined && keys.ProjLinearUnitsGeoKey!==9001))
      fail('IMAGE_CRS_UNSUPPORTED','地表影像坐标单位须为度或 Web Mercator 米');
    const rasterType=keys.GTRasterTypeGeoKey ?? 1;
    if(rasterType!==1 && rasterType!==2) fail('IMAGE_TRANSFORM_UNSUPPORTED','地表影像栅格类型不支持北向映射');
    const pixelIsArea=rasterType===1;
    const orientation=await directory.loadValue('Orientation');
    if((orientation!==undefined && orientation!==1) || directory.hasTag('ModelTransformation'))
      fail('IMAGE_TRANSFORM_UNSUPPORTED','地表影像仅支持左上起点的北向 PixelScale/Tiepoint 映射');
    const scale=numbers(await directory.loadValue('ModelPixelScale'),'PixelScale');
    const ties=numbers(await directory.loadValue('ModelTiepoint'),'Tiepoint');
    if(scale.length!==3 || scale[0]<=0 || scale[1]<=0 || ![0,1].includes(scale[2])
      || ties.length<6 || ties.length%6!==0) fail('IMAGE_TRANSFORM_UNSUPPORTED','地表影像不是有效的北向映射');
    const [dx,dy]=scale,originX=ties[3]-ties[0]*dx,originY=ties[4]+ties[1]*dy;
    const tolerance=crs==='EPSG:3857'?1e-5:1e-9;
    for(let i=0;i<ties.length;i+=6) {
      if(ties[i+2]!==0 || ties[i+5]!==0 || Math.abs(ties[i+3]-ties[i]*dx-originX)>tolerance
        || Math.abs(ties[i+4]+ties[i+1]*dy-originY)>tolerance)
        fail('IMAGE_TRANSFORM_UNSUPPORTED','地表影像多个控制点与北向映射不一致');
    }
    const nativeBounds={west:originX,east:originX+(pixelIsArea?width:width-1)*dx,
      north:originY,south:originY-(pixelIsArea?height:height-1)*dy};
    const limitX=crs==='EPSG:4326'?180:MERCATOR_LIMIT,limitY=crs==='EPSG:4326'?90:MERCATOR_LIMIT;
    if(!Object.values(nativeBounds).every(Number.isFinite) || nativeBounds.west < -limitX || nativeBounds.east>limitX
      || nativeBounds.south < -limitY || nativeBounds.north>limitY)
      fail('IMAGE_TRANSFORM_UNSUPPORTED','地表影像北向映射的坐标范围无效');
    const southwest=crs==='EPSG:4326'?{lon:nativeBounds.west,lat:nativeBounds.south}:unproject(nativeBounds.west,nativeBounds.south);
    const northeast=crs==='EPSG:4326'?{lon:nativeBounds.east,lat:nativeBounds.north}:unproject(nativeBounds.east,nativeBounds.north);
    const bounds={west:southwest.lon,south:southwest.lat,east:northeast.lon,north:northeast.lat};
    const nodataValue=await directory.loadValue('GDAL_NODATA');
    let nodata:number|undefined;
    if(nodataValue!==undefined) {
      const text=typeof nodataValue==='string'?nodataValue.replace(/\0+$/u,'').trim():'';
      nodata=text===''?NaN:Number(text);
      if(!Number.isFinite(nodata)) fail('IMAGE_METADATA_INVALID','地表影像 NoData 元数据无效');
    }
    // TIFF tiles/strips may be larger than the image. Bound those decoded blocks
    // too, so a tiny claimed image cannot hide an oversized tile allocation.
    if(!Number.isSafeInteger(image.getTileWidth()) || !Number.isSafeInteger(image.getTileHeight())
      || image.getTileWidth()<1 || image.getTileHeight()<1 || image.getTileWidth()*image.getTileHeight()>MAX_PIXELS)
      fail('IMAGE_PIXEL_LIMIT','地表影像解码块超出像素上限 16,777,216');
    const raster=await image.readRasters({interleave:true,samples:Array.from({length:channels},(_,index)=>index)});
    if(!(raster instanceof Uint8Array) || raster.length!==width*height*channels)
      fail('IMAGE_RGB_UNSUPPORTED','地表影像 RGB 像元数组尺寸无效');
    const metadata:ColorImageMetadata={sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.byteLength,
      width,height,bounds,crs,pixelIsArea,...(nodata===undefined?{}:{nodata})};
    function sample(lat:number,lon:number):{r:number;g:number;b:number}|null {
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90 || lat>90 || lon < -180 || lon>180) return null;
      const x=crs==='EPSG:4326'?lon:R*lon*RAD,y=crs==='EPSG:4326'?lat:R*Math.log(Math.tan(Math.PI/4+lat*RAD/2));
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<nativeBounds.west || x>nativeBounds.east
        || y<nativeBounds.south || y>nativeBounds.north) return null;
      const shift=pixelIsArea?.5:0;
      const column=Math.max(0,Math.min(width-1,Math.round((x-originX)/dx-shift)));
      const row=Math.max(0,Math.min(height-1,Math.round((originY-y)/dy-shift)));
      const offset=(row*width+column)*channels,r=raster[offset],g=raster[offset+1],b=raster[offset+2];
      if((channels===4 && raster[offset+3]!==255) || (nodata!==undefined && [r,g,b].some(value=>value===nodata))) return null;
      return {r,g,b};
    }
    return {sample,metadata};
  } catch(error) {
    if(error instanceof ColorGeoTiffError) throw error;
    throw new ColorGeoTiffError('IMAGE_INVALID_FILE','地表影像 GeoTIFF 无法解析或读取',error);
  }
}
