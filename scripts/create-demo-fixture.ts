/** Download a small, real Copernicus DSM crop for the upstream example GPX. */
import { fromUrl, writeArrayBuffer } from 'geotiff';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGeotiffSampler } from '../src/dem/geotiff.js';
const tile='Copernicus_DSM_COG_10_N30_00_E104_00_DEM';
const url=`https://copernicus-dem-30m.s3.amazonaws.com/${tile}/${tile}.tif`;
const requested={west:104.255,south:30.535,east:104.325,north:30.595};
const output=resolve('data/copernicus-longquanshan.tif');
const signal=AbortSignal.timeout(120000);
console.log('读取公共 Copernicus GLO-30 COG，仅获取龙泉山验收区域。');
const remoteOptions={allowFullFile:false,blockSize:65536,cacheSize:16};
const tiff=await fromUrl(url,remoteOptions,signal);
try {
  const image=await tiff.getImage();
  const keys=image.getGeoKeys();
  if(keys?.GeographicTypeGeoKey!==4326||image.getSamplesPerPixel()!==1)throw new Error('公共夹具的 CRS／波段与预期不一致');
  const directory=image.getFileDirectory();
  const scale=Array.from(await directory.loadValue('ModelPixelScale') as ArrayLike<number>);
  const tie=Array.from(await directory.loadValue('ModelTiepoint') as ArrayLike<number>);
  const dx=scale[0],dy=scale[1],ox=tie[3]-tie[0]*dx,oy=tie[4]+tie[1]*dy;
  const area=keys.GTRasterTypeGeoKey!==2,offset=area?0.5:0;
  const x0=Math.max(0,Math.floor((requested.west-ox)/dx-offset)-2);
  const x1=Math.min(image.getWidth(),Math.ceil((requested.east-ox)/dx-offset)+3);
  const y0=Math.max(0,Math.floor((oy-requested.north)/dy-offset)-2);
  const y1=Math.min(image.getHeight(),Math.ceil((oy-requested.south)/dy-offset)+3);
  const data=await image.readRasters({window:[x0,y0,x1,y1],samples:[0],interleave:true,signal});
  const nodata=await directory.loadValue('GDAL_NODATA');
  const metadata={width:x1-x0,height:y1-y0,ModelPixelScale:[dx,dy,0],ModelTiepoint:[0,0,0,ox+x0*dx,oy-y0*dy,0],
    GTModelTypeGeoKey:2,GTRasterTypeGeoKey:area?1:2,GeographicTypeGeoKey:4326,GeogAngularUnitsGeoKey:9102,VerticalUnitsGeoKey:9001,
    SampleFormat:[3],BitsPerSample:[32],SamplesPerPixel:1,PhotometricInterpretation:1,
    ...(nodata===undefined?{}:{GDAL_NODATA:String(nodata)})};
  const bytes=writeArrayBuffer(Float32Array.from(data as ArrayLike<number>),metadata);
  const sampler=await createGeotiffSampler(bytes);
  await mkdir(resolve('data'),{recursive:true});
  await writeFile(output,Buffer.from(bytes));
  const checksum=createHash('sha256').update(await readFile(output)).digest('hex');
  const source={dataset:'Copernicus DEM GLO-30 Public, 2021 release; DSM, not bare-earth DTM',
    sourceUrl:url,registry:'https://registry.opendata.aws/copernicus-dem/',
    attribution:'Copernicus Digital Elevation Model was accessed from https://registry.opendata.aws/copernicus-dem.',
    accessedAt:new Date().toISOString(),requestedBounds:requested,sourceWindow:[x0,y0,x1,y1],metadata:sampler.metadata,sha256:checksum,
    track:'Unmodified TrailPrint upstream example; sample route, not a user-recorded hike'};
  await writeFile(output.replace(/\.tif$/,'.source.json'),JSON.stringify(source,null,2)+'\n');
  console.log(JSON.stringify({output,bytes:bytes.byteLength,sha256:checksum,metadata:sampler.metadata},null,2));
} finally { await tiff.close(); }
