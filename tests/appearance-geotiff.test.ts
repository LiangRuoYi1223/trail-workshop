import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeArrayBuffer, type GeotiffWriterMetadata } from 'geotiff';
import { loadColorGeoTiff } from '../src/appearance/geotiff.js';

const rgb = [30,140,40, 120,80,60, 70,180,90, 100,100,100];
function fixture(values=rgb,overrides:GeotiffWriterMetadata={}):ArrayBuffer {
  const bands=values.length/4;
  const metadata:GeotiffWriterMetadata={width:2,height:2,BitsPerSample:Array(bands).fill(8),SampleFormat:Array(bands).fill(1),
    PhotometricInterpretation:2, GeographicTypeGeoKey:4326,GTModelTypeGeoKey:2,GTRasterTypeGeoKey:1,
    ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,100,30,0], ...(bands===4?{ExtraSamples:[2]}:{}), ...overrides};
  for (const key of Object.keys(metadata) as Array<keyof GeotiffWriterMetadata>) if(metadata[key]===undefined) delete metadata[key];
  return writeArrayBuffer(new Uint8Array(values),metadata);
}
async function withFile(buffer:ArrayBuffer,run:(path:string)=>Promise<void>):Promise<void> {
  const directory=await mkdtemp(join(tmpdir(),'trail-color-'));
  try { const path=join(directory,'color.tif'); await writeFile(path,new Uint8Array(buffer)); await run(path); }
  finally { await rm(directory,{recursive:true,force:true}); }
}
function replaceDimension(buffer:ArrayBuffer,tag:number,value:number):ArrayBuffer {
  const view=new DataView(buffer),little=view.getUint16(0,false)===0x4949,ifd=view.getUint32(4,little);
  for(let i=0;i<view.getUint16(ifd,little);i++) {
    const entry=ifd+2+i*12;
    if(view.getUint16(entry,little)===tag) {view.setUint16(entry+2,4,little);view.setUint32(entry+4,1,little);view.setUint32(entry+8,value,little);return buffer;}
  }
  throw new Error('missing fixture dimension');
}

test('RGB GeoTIFF uses nearest georeferenced pixels and carries content identity', async () => {
  const buffer=fixture();
  await withFile(buffer,async path => {
    const image=await loadColorGeoTiff(path);
    assert.deepEqual(image.sample(29.5,100.5),{r:30,g:140,b:40});
    assert.deepEqual(image.sample(28.5,101.5),{r:100,g:100,b:100});
    assert.equal(image.sample(30.01,100),null);
    assert.equal(image.sample(29,102.01),null);
    assert.equal(image.sample(NaN,101),null);
    assert.deepEqual(image.metadata.bounds,{west:100,south:28,east:102,north:30});
    assert.equal(image.metadata.crs,'EPSG:4326');
    assert.equal(image.metadata.width,2);
    assert.equal(image.metadata.height,2);
    assert.equal(image.metadata.byteLength,buffer.byteLength);
    assert.equal(image.metadata.sha256,createHash('sha256').update(new Uint8Array(buffer)).digest('hex'));
  });
});

test('RGBA partial or zero alpha is invalid coverage rather than a made-up terrain color', async () => {
  await withFile(fixture([30,140,40,255, 120,80,60,0, 70,180,90,128, 100,100,100,255]),async path => {
    const image=await loadColorGeoTiff(path);
    assert.deepEqual(image.sample(29.5,100.5),{r:30,g:140,b:40});
    assert.equal(image.sample(29.5,101.5),null);
    assert.equal(image.sample(28.5,100.5),null);
  });
});

test('RGB nodata samples return no coverage', async () => {
  await withFile(fixture([0,0,0,...rgb.slice(3)],{GDAL_NODATA:'0'}),async path => {
    const image=await loadColorGeoTiff(path);
    assert.equal(image.sample(29.5,100.5),null);
    assert.deepEqual(image.sample(29.5,101.5),{r:120,g:80,b:60});
  });
});

test('EPSG:3857 uses actual projected coordinates rather than stretching a geographic rectangle', async () => {
  await withFile(fixture(rgb,{GeographicTypeGeoKey:undefined,ProjectedCSTypeGeoKey:3857,GTModelTypeGeoKey:1,
    ModelPixelScale:[1000,1000,0],ModelTiepoint:[0,0,0,0,2000,0]}),async path => {
    const image=await loadColorGeoTiff(path);
    assert.equal(image.metadata.crs,'EPSG:3857');
    assert.deepEqual(image.sample(.01347472913758,.004491576420598),{r:30,g:140,b:40});
    assert.deepEqual(image.sample(.004491576415998,.01347472926179),{r:100,g:100,b:100});
    assert.equal(image.sample(.018,0),null);
  });
});

test('nonzero tiepoints and PixelIsPoint retain their declared mapping',async () => {
  await withFile(fixture(rgb,{GTRasterTypeGeoKey:2,ModelPixelScale:[2,.5,0],
    ModelTiepoint:[7,9,0,114,25.5,0,8,10,0,116,25,0]}),async path => {
    const image=await loadColorGeoTiff(path);
    assert.deepEqual(image.metadata.bounds,{west:100,south:29.5,east:102,north:30});
    assert.deepEqual(image.sample(29.5,102),{r:100,g:100,b:100});
    assert.equal(image.sample(29.49,101),null);
  });
});

test('unsupported CRS, bands, sample depth and orientation reject before raster decoding', async () => {
  const invalid:GeotiffWriterMetadata[]=[{GeographicTypeGeoKey:4269},{GeoKeyDirectory:[1,1,0,0]},
    {BitsPerSample:[16,16,16]},{SampleFormat:[2,2,2]},{PhotometricInterpretation:1},
    {Orientation:4},{ModelPixelScale:[-1,1,0]},
    {ModelTransformation:[1,0,0,100,0,-1,0,30,0,0,1,0,0,0,0,1]},
    {ModelTiepoint:[0,0,0,100,30,0,1,1,0,102,29,0]},
    {ModelPixelScale:undefined}];
  for(const overrides of invalid) await withFile(fixture(rgb,overrides),async path => {
    await assert.rejects(loadColorGeoTiff(path), /坐标|RGB|8 位|北向|映射/u);
  });
  await withFile(fixture([1,2,3,4]),async path => { await assert.rejects(loadColorGeoTiff(path),/RGB/u); });
});

test('pixel budget checks metadata before attempting to allocate or read a claimed huge raster', async () => {
  const buffer=replaceDimension(replaceDimension(fixture(),256,5000),257,5000);
  await withFile(buffer,async path => { await assert.rejects(loadColorGeoTiff(path),/16,777,216|像素上限/u); });
});

test('file byte budget rejects a sparse oversized file without reading it into memory', async () => {
  await withFile(fixture(),async path => {
    const handle=await open(path,'r+');
    try { await handle.truncate(64*1024*1024+1); } finally { await handle.close(); }
    await assert.rejects(loadColorGeoTiff(path),/64 MB/u);
  });
});

test('broken files and malformed nodata reject clearly',async () => {
  await withFile(new ArrayBuffer(20),async path => { await assert.rejects(loadColorGeoTiff(path),/地表影像/u); });
  await withFile(fixture(rgb,{GDAL_NODATA:'not-a-number'}),async path => { await assert.rejects(loadColorGeoTiff(path),/NoData/u); });
});
