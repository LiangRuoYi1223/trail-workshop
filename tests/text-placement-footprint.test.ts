import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/index.js';
import {buildHeightfieldTerrainMesh} from '../src/vendor/trailprint/heightfield-mesh.js';
import type {TerrainCropRegion} from '../src/vendor/trailprint/types.js';

const circle:TerrainCropRegion={shape:'circle',widthMm:120,heightMm:120,radiusMm:60,centerLat:30,centerLon:104,bearingDeg:0,minLat:29.99,maxLat:30.01,minLon:103.99,maxLon:104.01};

test('preview footprint exposes the same adaptive circle chords used by heightfield clipping',()=>{
  const build=(core as any).buildTerrainFootprintPolygonMm;
  assert.equal(typeof build,'function','core exposes the actual clipping footprint for text inspection');
  const outline:Array<{x:number;y:number}>=build(circle,65,65);
  assert.equal(outline.length,80,'120 mm / 65 point circle uses 80 chords, not a fixed 128 point preview');
  assert.equal(build(circle,513,513).length,104,'the circle refines when the source grid step becomes smaller');
  assert.ok(outline.some(p=>p.x===60));assert.ok(outline.some(p=>p.y===60));assert.ok(outline.some(p=>p.x===-60));assert.ok(outline.some(p=>p.y===-60));
  for(let i=0;i<outline.length;i++){
    const p=outline[i],q=outline[(i+1)%outline.length];
    assert.ok(60-Math.hypot((p.x+q.x)/2,(p.y+q.y)/2)<=0.05,'chord sagitta stays within the mesh tolerance');
  }
  const mesh=buildHeightfieldTerrainMesh(circle,new Float64Array(65*65),65,65,2);
  for(const angle of [2.25,37,90,180]) {
    const a=angle*Math.PI/180,n={x:Math.sin(a),y:Math.cos(a)};
    const previewSupport=Math.max(...outline.map(p=>p.x*n.x+p.y*n.y));
    let meshSupport=-Infinity;
    for(let i=0;i<mesh.positions.length;i+=3)meshSupport=Math.max(meshSupport,mesh.positions[i]*n.x+mesh.positions[i+1]*n.y);
    assert.ok(Math.abs(previewSupport-meshSupport)<0.000005,`${angle} degree support uses the same clipping chord at STL precision`);
  }
});

test('shared terrain footprint preserves default circle radius and native rectangle or polygon corners',()=>{
  const build=(core as any).buildTerrainFootprintPolygonMm;
  assert.equal(typeof build,'function');
  const defaultCircle=build({...circle,radiusMm:undefined,widthMm:30,heightMm:20},65,33);
  assert.equal(Math.max(...defaultCircle.map((p:any)=>p.x)),10);
  const rectangle=build({...circle,shape:'rectangle',widthMm:30,heightMm:20},65,33);
  assert.deepEqual(rectangle,[{x:-15,y:-10},{x:15,y:-10},{x:15,y:10},{x:-15,y:10}]);
  const polygon=build({...circle,shape:'polygon',polygonSides:3,cornerRadiusMm:0},65,65);
  assert.equal(polygon.length,3);assert.ok(Math.abs(polygon[0].x-30*Math.sqrt(3))<1e-10);assert.ok(Math.abs(polygon[0].y+30)<1e-10);
  assert.ok(build({...circle,shape:'polygon',polygonSides:3,cornerRadiusMm:3},65,65).length>3);
});
