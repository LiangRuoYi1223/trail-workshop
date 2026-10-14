import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntegratedTerrainMesh } from '../src/mesh/integrated-model.js';
import { assertPrintableMesh } from '../src/mesh/validate.js';
import { buildHeightfieldTerrainMesh } from '../src/vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload } from '../src/vendor/trailprint/types.js';

const crop:TerrainCropRegion={shape:'rectangle',widthMm:20,heightMm:20,centerLat:30,centerLon:104,
  bearingDeg:0,minLat:29.99,maxLat:30.01,minLon:103.99,maxLon:104.01};
function terrain(cols:number,tilted:boolean):TerrainMeshPayload {
  const heights=new Float64Array(cols*cols);
  for(let row=0;row<cols;row++) for(let col=0;col<cols;col++) {
    const x=(col/(cols-1)-.5)*20,y=(row/(cols-1)-.5)*20;
    heights[row*cols+col]=tilted ? .05*(x+10)+.1*(y+10) : 0;
  }
  const mesh=buildHeightfieldTerrainMesh(crop,heights,cols,cols,2);
  for(let i=2;i<mesh.positions.length;i+=3) mesh.positions[i]+=2;
  mesh.minSurfaceZ+=2;mesh.bottomZ=0;
  return mesh;
}
function triangleArea(points:number[][]):number {
  const [a,b,c]=points,u=b.map((value,index)=>value-a[index]),v=c.map((value,index)=>value-a[index]);
  return Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;
}
function assertExteriorBands(mesh:TerrainMeshPayload,heightAt:(x:number,y:number)=>number,relief:number):number {
  let routeWallArea=0;
  for(let face=0;face<mesh.indices.length/3;face++) {
    const points=mesh.indices.slice(face*3,face*3+3).map(index=>mesh.positions.slice(index*3,index*3+3));
    const exterior=[0,1].some(axis=>[-10,10].some(value=>points.every(point=>Math.abs(point[axis]-value)<1e-7)));
    if(!exterior) continue;
    const kind=mesh.faceKinds![face],offsets=points.map(([x,y,z])=>z-heightAt(x,y));
    if(kind==='route-wall') {
      assert.ok(offsets.every(offset=>offset>=-1e-6 && offset<=relief+1e-6),'route color must cover only the exterior relief strip');
      routeWallArea+=triangleArea(points);
    } else {
      if(kind==='base')assert.ok(points.every(point=>point[2]<=2+1e-6),'base color must stay below the exact base interface');else assert.equal(kind,'wall');
      assert.ok(offsets.every(offset=>offset<=1e-6),'mountain wall must stop at the underlying terrain, below the route relief');
    }
  }
  return routeWallArea;
}

test('a route crossing both crop edges splits exterior wall colors exactly at underlying DEM elevations',() => {
  for(const tilted of [false,true]) for(const cols of [3,5,17]) for(const routeHeightMm of [.1,1,10]) {
    const source=terrain(cols,tilted),routeWidthMm=tilted?3:1;
    const result=buildIntegratedTerrainMesh({terrainMesh:source,routeSegmentsMm:[[{x:-15,y:0},{x:15,y:0}]],
      frameWidthMm:0,routeHeightMm,routeWidthMm});
    const original=assertPrintableMesh(source),final=assertPrintableMesh(result.mesh);
    assert.equal(final.boundaryEdges,0);
    assert.equal(final.nonManifoldEdges,0);
    assert.equal(final.connectedComponents,1);
    assert.ok(Math.abs(final.volumeMm3-original.volumeMm3-20*routeWidthMm*routeHeightMm)<1e-4);
    const area=assertExteriorBands(result.mesh,(x,y)=>tilted?3.5+.05*x+.1*y:2,routeHeightMm);
    assert.ok(Math.abs(area-2*routeWidthMm*routeHeightMm)<1e-4,'both clipped end strips must use route color');
  }
});

test('route-only corner vertices and an entire boundary edge remain conforming after the material split',() => {
  const source=terrain(5,true),routeHeightMm=1;
  for(const path of [
    [{x:-15,y:-15},{x:15,y:15}],
    [{x:10,y:-15},{x:10,y:15}],
  ]) {
    const result=buildIntegratedTerrainMesh({terrainMesh:source,routeSegmentsMm:[path],frameWidthMm:0,routeHeightMm});
    const final=assertPrintableMesh(result.mesh);
    assert.equal(final.boundaryEdges,0);
    assert.equal(final.nonManifoldEdges,0);
    assert.equal(final.connectedComponents,1);
    assert.ok(assertExteriorBands(result.mesh,(x,y)=>3.5+.05*x+.1*y,routeHeightMm)>0);
    // The color split only subdivides vertical walls; relief volume remains intact.
    const original=assertPrintableMesh(source);
    assert.ok(Math.abs(final.volumeMm3-original.volumeMm3-result.report.route.areaMm2)<1e-4);
  }
});

test('a route meeting the integral frame colors only the raised strip above the original terrain',() => {
  for(const tilted of [false,true]) for(const routeHeightMm of [.1,1,10]) {
    const source=terrain(5,tilted),routeWidthMm=3;
    const result=buildIntegratedTerrainMesh({terrainMesh:source,routeSegmentsMm:[[{x:-15,y:0},{x:15,y:0}]],
      frameWidthMm:3,routeHeightMm,routeWidthMm});
    const final=assertPrintableMesh(result.mesh);
    assert.equal(final.boundaryEdges,0);
    assert.equal(final.nonManifoldEdges,0);
    assert.equal(final.connectedComponents,1);
    const area=assertExteriorBands(result.mesh,(x,y)=>tilted?3.5+.05*x+.1*y:2,routeHeightMm);
    assert.ok(Math.abs(area-2*routeWidthMm*routeHeightMm)<1e-4,'route/frame relief strips must retain route color');
    const original=assertPrintableMesh(source);
    assert.ok(Math.abs(final.volumeMm3-original.volumeMm3-20*routeWidthMm*routeHeightMm-2*result.report.frame.areaMm2)<1e-4);
  }
});
