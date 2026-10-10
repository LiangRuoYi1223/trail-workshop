import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTerrain } from '../src/generate-terrain.js';
import { writeBinaryStl } from '../src/vendor/trailprint/stl-writer.js';
import { assertPrintableMesh } from '../src/mesh/validate.js';
const gpx='<gpx version="1.1"><trk><trkseg><trkpt lat="30.55" lon="104.275"/><trkpt lat="30.57" lon="104.305"/></trkseg></trk></gpx>';
const sampler={sample:(lat:number,lon:number)=>500+(lat-30.55)*1000+(lon-104.275)*200,metadata:{provider:'analytic-test-only'}};
test('地形南北方向、固定底厚、无槽单实体及 STL 写出往返验证',async()=>{
  const result=await generateTerrain({gpxXml:gpx,options:{widthMm:120,heightMm:80,gridColumns:33,groundWidthM:4000,baseThicknessMm:2,zExaggeration:2},loadDem:async()=>sampler});
  const h=result.heightfield;
  assert.ok(h.heightsMm[(h.rows-1)*h.cols]>h.heightsMm[0]);
  assert.equal(Math.min(...result.mesh.positions.filter((_,i)=>i%3===2)),0);
  assert.equal(result.mesh.minSurfaceZ,2);
  const folder=await mkdtemp(join(tmpdir(),'terrain-test-')),path=join(folder,'terrain.stl');
  await writeBinaryStl(path,result.mesh);
  const data=await readFile(path),count=data.readUInt32LE(80);
  assert.equal(data.length,84+50*count);assert.equal(count,result.mesh.indices.length/3);
  const positions:number[]=[],indices:number[]=[];
  for(let face=0;face<count;face++)for(let v=0;v<3;v++){
    const offset=84+face*50+12+v*12;
    indices.push(indices.length);positions.push(data.readFloatLE(offset),data.readFloatLE(offset+4),data.readFloatLE(offset+8));
  }
  assert.equal(assertPrintableMesh({positions,indices}).connectedComponents,1);
});
test('平地与圆形／圆角／奇数多边形均闭合且有正体积',async()=>{
  for(const options of [{shape:'circle' as const},{shape:'rectangle' as const,cornerRadiusMm:5},{shape:'polygon' as const,polygonSides:5}]) {
    const result=await generateTerrain({gpxXml:gpx,options:{...options,gridColumns:25},loadDem:async()=>({sample:()=>300,metadata:{provider:'flat-test-only'}})});
    const report=result.report.validation as {connectedComponents:number;volumeMm3:number};
    assert.equal(report.connectedComponents,1);assert.ok(report.volumeMm3>0);
  }
});
test('高程比例来自独立frame；固定选区旋转不改变 Z 夸张',async()=>{
  for(const bearingDeg of [0,45]) {
    const result=await generateTerrain({gpxXml:gpx,options:{gridColumns:25,groundWidthM:4000,bearingDeg,zExaggeration:2},loadDem:async()=>sampler});
    const h=result.heightfield,expected=(h.maximumElevationM-h.minimumElevationM)*0.03*2;
    assert.ok(Math.abs(Math.max(...h.heightsMm)-expected)<1e-10);
  }
});
test('拒绝全缺失与过量缺值，不把错误 DEM 变成平地',async()=>{
  await assert.rejects(generateTerrain({gpxXml:gpx,loadDem:async()=>({sample:()=>null,metadata:{}})}),/高程缺失/);
  await assert.rejects(generateTerrain({gpxXml:gpx,loadDem:async()=>({sample:(lat)=>lat>30.56?null:100,metadata:{}})}),/高程缺失/);
});
test('少量缺值明确计入插补报告，取消不产生模型',async()=>{
  let count=0;
  const result=await generateTerrain({gpxXml:gpx,options:{gridColumns:33},loadDem:async()=>({sample:()=>++count===100?null:100,metadata:{}})});
  assert.equal((result.report.elevation as {filledSamples:number}).filledSamples,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(generateTerrain({gpxXml:gpx,signal:controller.signal,loadDem:async()=>sampler}),/abort/i);
});
