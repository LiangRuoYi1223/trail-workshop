import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntegratedTerrainMesh } from '../src/mesh/integrated-model.js';
import { assertPrintableMesh, type PrintableMesh } from '../src/mesh/validate.js';
import { buildHeightfieldTerrainMesh } from '../src/vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload } from '../src/vendor/trailprint/types.js';

const crop: TerrainCropRegion = { shape: 'rectangle', widthMm: 20, heightMm: 20, centerLat: 30, centerLon: 104, bearingDeg: 0, minLat: 29.99, maxLat: 30.01, minLon: 103.99, maxLon: 104.01 };
const route = [[{ x: -10, y: 0 }, { x: 10, y: 0 }]];
type Part = PrintableMesh & { id: 'terrain'|'snow'|'route'|'base'|'text'; faceKinds?: string[] };
type SnowMesh = TerrainMeshPayload & { materialParts?: Part[] };
type SnowReport = { actualCoveragePercent: number; volumeMm3: number; maxThicknessMm: number; coverageTolerancePercent: number };
const validatePart = assertPrintableMesh as (mesh: PrintableMesh, options?: { allowDisconnected: boolean }) => ReturnType<typeof assertPrintableMesh>;

function terrain(height: (x:number,y:number)=>number = () => 0, customCrop = crop, size = 9): TerrainMeshPayload {
  const values = new Float64Array(size * size);
  for (let y=0;y<size;y++) for(let x=0;x<size;x++) values[y*size+x]=height((x/(size-1)-0.5)*customCrop.widthMm,(y/(size-1)-0.5)*customCrop.heightMm);
  const mesh=buildHeightfieldTerrainMesh(customCrop,values,size,size,2);
  for(let i=2;i<mesh.positions.length;i+=3)mesh.positions[i]+=2;
  mesh.minSurfaceZ+=2;mesh.bottomZ=0;
  return mesh;
}

function generate(source: TerrainMeshPayload, coverage = 30, thickness = 1, extra = {}) {
  const result=buildIntegratedTerrainMesh({terrainMesh:source,routeSegmentsMm:route,frameWidthMm:0,snowEnabled:true,snowCoveragePercent:coverage,snowMaxThicknessMm:thickness,...extra});
  return {mesh:result.mesh as SnowMesh,report:result.report as typeof result.report & {snow?:SnowReport}};
}

function close(actual:number,expected:number,tolerance=1e-5) {assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);}
function topAt(mesh:PrintableMesh,x:number,y:number):number {
  const p=mesh.positions;let highest=-Infinity;
  for(let i=0;i<mesh.indices.length;i+=3) {
    const [a,b,c]=mesh.indices.slice(i,i+3).map(id=>id*3);
    const cross=(p[b]-p[a])*(p[c+1]-p[a+1])-(p[b+1]-p[a+1])*(p[c]-p[a]);if(cross<=0)continue;
    const u=((x-p[a])*(p[c+1]-p[a+1])-(y-p[a+1])*(p[c]-p[a]))/cross,v=((p[b]-p[a])*(y-p[a+1])-(p[b+1]-p[a+1])*(x-p[a]))/cross;
    if(Math.min(1-u-v,u,v)>=-1e-8)highest=Math.max(highest,p[a+2]+u*(p[b+2]-p[a+2])+v*(p[c+2]-p[a+2]));
  }
  assert.ok(Number.isFinite(highest),`No surface at ${x},${y}`);return highest;
}
function bottomAt(mesh:PrintableMesh,x:number,y:number):number {
  const reflected={positions:mesh.positions.map((value,i)=>i%3===2?-value:value),indices:mesh.indices.slice()};
  for(let i=0;i<reflected.indices.length;i+=3)[reflected.indices[i+1],reflected.indices[i+2]]=[reflected.indices[i+2],reflected.indices[i+1]];
  return -topAt(reflected,x,y);
}
function part(mesh:SnowMesh,id:Part['id']):Part {const found=mesh.materialParts?.find(p=>p.id===id);assert.ok(found,`Missing closed ${id} volume`);return found;}
function checkVolumes(mesh:SnowMesh) {
  const outer=assertPrintableMesh(mesh);assert.equal(outer.connectedComponents,1);
  let sum=0;for(const material of mesh.materialParts??[]) {const check=validatePart(material,{allowDisconnected:true});assert.equal(check.boundaryEdges,0);assert.equal(check.nonManifoldEdges,0);sum+=check.volumeMm3;}
  close(sum,outer.volumeMm3,Math.max(1e-5,outer.volumeMm3*1e-7));
}
function exportedEuler(mesh:PrintableMesh):number {
  const byCoordinate=new Map<string,number>(),welded:number[]=[],used=new Set<number>(),edges=new Set<string>();
  for(let i=0;i<mesh.positions.length;i+=3) {
    const key=mesh.positions.slice(i,i+3).map(value=>Math.round(Math.fround(value)/1e-6)).join(',');
    if(!byCoordinate.has(key))byCoordinate.set(key,byCoordinate.size);welded.push(byCoordinate.get(key)!);
  }
  for(let i=0;i<mesh.indices.length;i+=3) {
    const [a,b,c]=mesh.indices.slice(i,i+3).map(id=>welded[id]);for(const id of [a,b,c])used.add(id);
    for(const [from,to] of [[a,b],[b,c],[c,a]])edges.add(from<to?`${from},${to}`:`${to},${from}`);
  }
  return used.size-edges.size+mesh.indices.length/3;
}

test('disabled snow and zero coverage preserve the existing exact integrated surface',()=>{
  const source=terrain(x=>x+10),request={terrainMesh:source,routeSegmentsMm:route,frameWidthMm:0};
  const old=buildIntegratedTerrainMesh(request);
  assert.deepEqual(buildIntegratedTerrainMesh({...request,snowEnabled:false,snowCoveragePercent:80,snowMaxThicknessMm:8}).mesh,old.mesh);
  assert.deepEqual(generate(source,0).mesh,old.mesh);
});

test('30 percent snow selects high terrain by projected XY area including below the route',()=>{
  const source=terrain(x=>0.2*(x+10));const result=generate(source);
  const snow=part(result.mesh,'snow');checkVolumes(result.mesh);
  assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,30,0.02);
  close(validatePart(snow,{allowDisconnected:true}).volumeMm3,result.report.snow.volumeMm3,1e-4);
  close(topAt(result.mesh,-6,4),topAt(source,-6,4));assert.ok(topAt(result.mesh,8,4)>topAt(source,8,4));
  const routePart=part(result.mesh,'route');close(validatePart(routePart,{allowDisconnected:true}).volumeMm3,result.report.route.areaMm2,1e-4);
  close(topAt(routePart,8,0)-topAt(snow,8,0),1);
  const ground=part(result.mesh,'terrain');
  for(const [x,y] of [[8,0],[8,4],[5,0]]) {close(topAt(ground,x,y),topAt(source,x,y));close(bottomAt(snow,x,y),topAt(ground,x,y));}
  close(bottomAt(routePart,8,0),topAt(snow,8,0));close(bottomAt(routePart,-6,0),topAt(ground,-6,0));
});

test('the snowline tapers continuously to zero and snow under the full route width raises its base',()=>{
  const source=terrain(x=>0.2*(x+10));const {mesh}=generate(source,30,1,{routeWidthMm:4,routeHeightMm:2.5});
  const snow=part(mesh,'snow'),relief=part(mesh,'route');checkVolumes(mesh);
  const at=(x:number)=>topAt(snow,x,3)-topAt(source,x,3);
  assert.ok(at(4.1)>0&&at(4.1)<at(6));assert.ok(at(4.1)<0.15);
  for(const y of [-1.9,0,1.9])close(topAt(relief,8,y)-topAt(snow,8,y),2.5);
});

test('maximum snow thickness is physical Z millimetres and slope attenuation ignores vertical exaggeration',()=>{
  const flat=terrain();const all=generate(flat,100,3);checkVolumes(all.mesh);close(topAt(all.mesh,0,4)-topAt(flat,0,4),3);
  const firstSource=terrain(x=>0.3*(x+10)),secondSource=terrain(x=>1.2*(x+10));
  const first=generate(firstSource,100,3,{zExaggeration:1}),second=generate(secondSource,100,3,{zExaggeration:4});
  const firstThickness=topAt(first.mesh,0,4)-topAt(firstSource,0,4),secondThickness=topAt(second.mesh,0,4)-topAt(secondSource,0,4);
  close(firstThickness,secondThickness);assert.ok(firstThickness<3&&firstThickness>0);checkVolumes(first.mesh);checkVolumes(second.mesh);
});

test('flat terrain has deterministic finite partial coverage and full coverage has no dry top',()=>{
  for(const coverage of [30,100]) {const result=generate(terrain(),coverage);checkVolumes(result.mesh);assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,coverage,0.02);assert.ok(result.mesh.positions.every(Number.isFinite));if(coverage===100)assert.ok(!result.mesh.faceKinds?.includes('terrain'));}
});

test('snow and terrain stay inside their footprint while the separate base includes its frame',()=>{
  const source=terrain(x=>0.2*(x+10));const {mesh}=generate(source,100,1,{frameWidthMm:3});checkVolumes(mesh);
  const bounds=validatePart(part(mesh,'snow'),{allowDisconnected:true}).bounds;close(bounds.size.x,20);close(bounds.size.y,20);
  close(validatePart(part(mesh,'terrain'),{allowDisconnected:true}).bounds.size.x,20);assert.ok(validatePart(part(mesh,'base'),{allowDisconnected:true}).bounds.size.x>25.9);
  close(topAt(mesh,11,3),2);
});

test('separated summits and GPX segments produce closed positive disconnected material parts',()=>{
  const source=terrain((x,y)=>Math.max(0,5-Math.hypot(x+5,y+5),5-Math.hypot(x-5,y-5)),crop,17);
  const segments=[[{x:-8,y:-5},{x:-2,y:-5}],[{x:2,y:5},{x:8,y:5}]];
  const {mesh}=generate(source,15,1,{routeSegmentsMm:segments,frameWidthMm:2});checkVolumes(mesh);
  assert.ok(validatePart(part(mesh,'snow'),{allowDisconnected:true}).connectedComponents>=2);
  assert.equal(validatePart(part(mesh,'route'),{allowDisconnected:true}).connectedComponents,2);
  assert.throws(()=>assertPrintableMesh(part(mesh,'route')),/connected components/);
});

test('invalid snow parameters fail before partitioning and cancellation remains effective',()=>{
  const source=terrain();for(const coverage of [-1,101,NaN,Infinity])assert.throws(()=>generate(source,coverage),{code:'CONFIG_INVALID'});
  for(const thickness of [0.099,10.001,NaN,Infinity])assert.throws(()=>generate(source,30,thickness),{code:'CONFIG_INVALID'});
  const controller=new AbortController();controller.abort();assert.throws(()=>generate(source,30,1,{signal:controller.signal}),{name:'AbortError'});
});

test('rounded rectangles, circles and polygons preserve closed snow layers where the snowline meets the frame',()=>{
  for(const shape of [{...crop,cornerRadiusMm:3},{...crop,shape:'circle' as const,radiusMm:10},{...crop,shape:'polygon' as const,radiusMm:10,polygonSides:5}]) {
    for(const coverage of [30,100]) {
      const source=terrain((x,y)=>0.2*(x+10)+0.1*(y+10),shape,9),result=generate(source,coverage,1,{frameWidthMm:2});
      checkVolumes(result.mesh);assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,coverage,0.02);
    }
  }
});

test('allowDisconnected still rejects an inverted material island even when total volume remains positive',()=>{
  const make=(size:number,x:number)=>({positions:[x,0,0,x+size,0,0,x,size,0,x,0,size],indices:[0,2,1,0,1,3,0,3,2,1,2,3]});
  const large=make(2,0),small=make(1,4),inverted=small.indices.slice();
  for(let i=0;i<inverted.length;i+=3)[inverted[i+1],inverted[i+2]]=[inverted[i+2],inverted[i+1]];
  const mesh={positions:[...large.positions,...small.positions],indices:[...large.indices,...inverted.map(id=>id+4)]};
  assert.throws(()=>validatePart(mesh,{allowDisconnected:true}),/component .*volume must be positive/);
});

test('snow contours remain printable at DEM level ties, plateaus and saddle points',()=>{
  const segments=[[{x:-9,y:-7},{x:9,y:8}],[{x:-8,y:-8},{x:8,y:-8},{x:8,y:8},{x:-8,y:8},{x:-8,y:-8}]];
  const cases:Array<{height:(x:number,y:number)=>number;coverage:number}>=[
    {height:(x,y)=>0.5*(x+10)+0.3*(y+10),coverage:30},
    {height:(x,y)=>0.5*(x+10)+0.3*(y+10),coverage:70},
    {height:x=>x>0?8:0,coverage:13},
    {height:x=>x>0?8:0,coverage:30},
    {height:x=>x>0?8:0,coverage:50},
    {height:x=>x>0?8:0,coverage:70},
    {height:(x,y)=>6+2*Math.sin(x)*Math.cos(y),coverage:50},
  ];
  for(const {height,coverage} of cases) {
    const result=generate(terrain(height,crop,17),coverage,0.1,{routeSegmentsMm:segments,frameWidthMm:2});checkVolumes(result.mesh);
    assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,coverage,0.02);
  }
});

test('large Gaussian terrain has physical snow across its foothills and resolves its microscopic frame seam',()=>{
  const large={...crop,widthMm:240.1234,heightMm:80};
  const source=terrain((x,y)=>20*Math.exp(-((x-4)**2+(y-2)**2)/90),large,17);
  const segments=[[{x:-90,y:-25},{x:90,y:25}]];
  const result=generate(source,30,1,{routeSegmentsMm:segments,frameWidthMm:3});
  checkVolumes(result.mesh);assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,30,0.02);
  assert.ok(validatePart(part(result.mesh,'snow'),{allowDisconnected:true}).volumeMm3>100,'selected foothills need a physical snow layer');
});

test('sub-resolution coverage limits are reported visibly within the measured coverage tolerance',()=>{
  for(const coverage of [0.01,99.99]) {
    const result=generate(terrain(x=>x>0?8:0,crop,17),coverage,0.1);
    checkVolumes(result.mesh);assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,coverage,result.report.snow.coverageTolerancePercent);
    if(coverage===0.01)assert.equal(result.mesh.materialParts?.some(part=>part.id==='snow'),false);
  }
});

test('snow contours on curved crop chords use globally consistent edge membership for their frame',()=>{
  const segments=[[{x:-9,y:-7},{x:9,y:8}],[{x:-8,y:-8},{x:8,y:-8},{x:8,y:8},{x:-8,y:8},{x:-8,y:-8}]];
  for(const shape of [{...crop,shape:'circle' as const,radiusMm:10},{...crop,shape:'polygon' as const,radiusMm:10,polygonSides:5}]) {
    const source=terrain(shape.shape==='circle'?(x,y)=>6+2*Math.sin(x)*Math.cos(y):x=>x>0?8:0,shape,17);
    for(const thickness of [0.1,10]) {
      const result=generate(source,50,thickness,{routeSegmentsMm:segments,frameWidthMm:2});checkVolumes(result.mesh);
      assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,50,0.02);
    }
  }
});

test('snow partition retains a positive source facet above weld precision instead of opening an interior hole',()=>{
  // Synthetic square with 6e-11 / 2e-11 mm² interior facets: the source stays
  // valid at fixed 1e-6 mm welding and binary STL precision. No private fixture.
  for(const [dx,cx,dy] of [[0.000012,0.00001,0.00001],[0.000008,0.000006,0.000005]]) {
    const source:TerrainMeshPayload={positions:[20,20,20,40,20,20,40,40,20,20,40,20,
      30,30,20,30+dx,30,20,30+cx,30+dy,20,
      20,20,0,40,20,0,40,40,0,20,40,0],
      indices:[0,1,4,1,5,4,1,2,5,2,6,5,2,3,6,3,4,6,3,0,4,4,5,6,
        7,9,8,7,10,9],minSurfaceZ:20,bottomZ:0,gridCols:17,gridRows:17};
    for(const [a,b] of [[0,1],[1,2],[2,3],[3,0]])source.indices.push(a,a+7,b+7,a,b+7,b);
    close(assertPrintableMesh(source).volumeMm3,8000);
    const result=generate(source,100,1,{routeSegmentsMm:[[{x:21,y:25},{x:39,y:25}]]});
    checkVolumes(result.mesh);assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,100);
    assert.equal(exportedEuler(result.mesh),2,'complete terrain must not gain a through-hole');
    close(validatePart(part(result.mesh,'snow'),{allowDisconnected:true}).volumeMm3,400);
    for(let face=0;face<result.mesh.indices.length/3;face++)if(result.mesh.faceKinds?.[face]==='wall') {
      const vertices=result.mesh.indices.slice(face*3,face*3+3).map(id=>result.mesh.positions.slice(id*3,id*3+3));
      assert.ok(vertices.every(([x,y])=>x===20||x===40||y===20||y===40),'retained facet must not turn into an internal through-hole wall');
    }
  }
});

test('snow frame nodes collinear Float32 crop points without retaining a phantom flat triangle',()=>{
  const radius=60,step=120/256,sqrt3=Math.sqrt(3);
  const diagonal=(offset:number)=>({x:Math.fround(radius-offset/(1+sqrt3)),y:Math.fround(-offset*sqrt3/(1+sqrt3))});
  const ring=[{x:radius,y:Math.fround(-Number.EPSILON*40)},
    ...[1,2,3,4,5].map(i=>({x:Math.fround(radius*Math.cos(i*Math.PI/3)),y:Math.fround(radius*Math.sin(i*Math.PI/3))})),
    diagonal(2*step),{x:Math.fround(radius-step/sqrt3),y:-step},diagonal(step)];
  const count=ring.length,positions=[0,0,2,...ring.flatMap(p=>[p.x,p.y,2]),0,0,0,...ring.flatMap(p=>[p.x,p.y,0])],indices:number[]=[];
  for(let i=0;i<count;i++) {
    const a=i+1,b=(i+1)%count+1,ba=a+count+1,bb=b+count+1;
    indices.push(0,a,b,count+1,bb,ba,a,ba,bb,a,bb,b);
  }
  const source:TerrainMeshPayload={positions,indices,minSurfaceZ:2,bottomZ:0,gridCols:257,gridRows:257};
  assertPrintableMesh(source);
  const result=generate(source,100,1,{routeSegmentsMm:[[{x:-10,y:0},{x:10,y:0}]],frameWidthMm:3});
  checkVolumes(result.mesh);assert.ok(result.report.snow);close(result.report.snow.actualCoveragePercent,100);
  assert.equal(exportedEuler(result.mesh),2);
  const canonical={...result.mesh,positions:result.mesh.positions.map(Math.fround),materialParts:result.mesh.materialParts?.map(part=>({...part,positions:part.positions.map(Math.fround)}))};
  checkVolumes(canonical);assert.equal(exportedEuler(canonical),2);
});
