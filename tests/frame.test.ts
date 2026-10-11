import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainFrame } from '../src/geo/frame.js';
const points=[{lat:30.55,lon:104.275},{lat:30.57,lon:104.305}];
test('模型与经纬度互逆，旋转后 DEM 外框覆盖角点',()=>{
  const f=createTerrainFrame(points,{widthMm:120,heightMm:80,bearingDeg:37});
  for(const p of points) {
    const mm=f.geoToMm(p),back=f.mmToGeo(mm.x,mm.y);
    assert.ok(Math.abs(p.lat-back.lat)<1e-10&&Math.abs(p.lon-back.lon)<1e-10);
    assert.ok(Math.abs(mm.x)<=54.00001 && Math.abs(mm.y)<=36.00001);
  }
  for(const x of [-60,60])for(const y of [-40,40]) {
    const g=f.mmToGeo(x,y);
    assert.ok(g.lon>=f.bounds.west-1e-10&&g.lon<=f.bounds.east+1e-10&&g.lat>=f.bounds.south-1e-10&&g.lat<=f.bounds.north+1e-10);
  }
});
test('固定选区米制宽度时旋转不改变毫米比例',()=>{
  const a=createTerrainFrame(points,{groundWidthM:4000,bearingDeg:0});
  const b=createTerrainFrame(points,{groundWidthM:4000,bearingDeg:45});
  assert.equal(a.mmPerMeter,0.03);assert.equal(a.mmPerMeter,b.mmPerMeter);
  assert.notDeepEqual(a.bounds,b.bounds);
});
test('自动取景保持 XY 等比，圆形能容纳所有路线点',()=>{
  const f=createTerrainFrame(points,{shape:'circle',widthMm:120,bearingDeg:65});
  for(const p of points){const q=f.geoToMm(p);assert.ok(Math.hypot(q.x,q.y)<=54.00001);}
  const origin=f.geoToMm(f.mmToGeo(0,0)),east=f.geoToMm(f.mmToGeo(10,0)),north=f.geoToMm(f.mmToGeo(0,10));
  assert.ok(Math.abs(Math.hypot(east.x-origin.x,east.y-origin.y)-Math.hypot(north.x-origin.x,north.y-origin.y))<1e-8);
});
test('拒绝不支持的坐标、选区尺度和参数',()=>{
  assert.throws(()=>createTerrainFrame([{lat:85,lon:0},{lat:85,lon:1}]),/GEO|纬度/);
  assert.throws(()=>createTerrainFrame([{lat:30,lon:179},{lat:30,lon:-179}]),/日期/);
  assert.throws(()=>createTerrainFrame(points,{groundWidthM:0}),/选区/);
  assert.throws(()=>createTerrainFrame(points,{widthMm:NaN}),/长宽/);
  assert.throws(()=>createTerrainFrame(points,{paddingFraction:0.9}),/留白/);
});

test('圆角有效值与实际轮廓一致，微小圆角明确归零',()=>{
  assert.throws(()=>createTerrainFrame(points,{shape:'circle',cornerRadiusMm:1}),/圆角/);
  assert.throws(()=>createTerrainFrame(points,{shape:'polygon',polygonSides:3,widthMm:120,cornerRadiusMm:31}),/圆角/);
  assert.equal(createTerrainFrame(points,{shape:'polygon',polygonSides:3,widthMm:120,cornerRadiusMm:30}).crop.cornerRadiusMm,30);
  assert.equal(createTerrainFrame(points,{cornerRadiusMm:0.00001}).crop.cornerRadiusMm,0);
});
