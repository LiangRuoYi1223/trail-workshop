import assert from 'node:assert/strict';
import test from 'node:test';
import ClipperLib from 'clipper-lib';
import {prepareTextLayout} from '../src/mesh/base-text.js';
import {buildIntegratedTerrainMesh} from '../src/mesh/integrated-model.js';
import {generatePrintableTerrain} from '../src/generate-printable-terrain.js';
import {assertPrintableMesh} from '../src/mesh/validate.js';
import {validateMaterialParts} from '../src/export/material-parts.js';
import {buildHeightfieldTerrainMesh} from '../src/vendor/trailprint/heightfield-mesh.js';
import {buildFootprintPolygonMm} from '../src/vendor/trailprint/footprint.js';
import {SCALE} from '../src/route/corridor.js';
import type {TerrainCropRegion} from '../src/vendor/trailprint/types.js';

const ring=(x:number,y:number,w:number,h:number)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
// An asymmetric, disconnected fixture catches accidental origin anchoring and lost holes.
const contours=[{outer:ring(7,2,3,3),holes:[ring(8,2.5,1,1)]},{outer:ring(11,2,0.5,3),holes:[]}];
const circle=Array.from({length:96},(_,i)=>({X:Math.round(15*Math.cos(i*Math.PI/48)*SCALE),Y:Math.round(15*Math.sin(i*Math.PI/48)*SCALE)}));
const options={baseText:'08',baseTextContours:contours,baseTextSizeMm:3};
const close=(actual:number,want:number,tolerance=3e-5)=>assert.ok(Math.abs(actual-want)<tolerance,`${actual} must be within ${tolerance} of ${want}`);
function projectionBounds(layout:any,t:{x:number;y:number}) {
  const values=layout.report.contours.flatMap((c:any)=>c.outer.map((p:any)=>p.x*t.x+p.y*t.y));
  return{min:Math.min(...values),max:Math.max(...values)};
}
function assertFullSafetyMargin(layout:any,inner:Array<{X:number;Y:number}>) {
  const offset=new ClipperLib.ClipperOffset(2,0.005*SCALE);
  for(const region of layout.regions)offset.AddPath(region.outer,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
  const safe:Array<Array<{X:number;Y:number}>>=[];offset.Execute(safe,0.5*SCALE);
  const outline=layout.outlineMm.map((p:{x:number;y:number})=>({X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)}));
  for(const [clip,operation] of [[inner,ClipperLib.ClipType.ctIntersection],[outline,ClipperLib.ClipType.ctDifference]] as const) {
    const boolean=new ClipperLib.Clipper();boolean.AddPaths(safe,ClipperLib.PolyType.ptSubject,true);boolean.AddPath(clip,ClipperLib.PolyType.ptClip,true);
    const remainder:Array<Array<{X:number;Y:number}>>=[];boolean.Execute(operation,remainder,ClipperLib.PolyFillType.pftNonZero,ClipperLib.PolyFillType.pftNonZero);
    const area=remainder.reduce((sum,path)=>sum+Math.abs(ClipperLib.Clipper.Area(path)),0)/(SCALE*SCALE);
    assert.ok(area<1e-7,`${area} mm² of safety margin crosses the ledge boundary`);
  }
}

test('circular labels use cardinal tangent positions, preserve a straight baseline, and canonicalize 360 to zero',()=>{
  const expected=[{angle:0,n:{x:0,y:1},t:{x:-1,y:0},rotation:180},{angle:90,n:{x:1,y:0},t:{x:0,y:1},rotation:90},{angle:180,n:{x:0,y:-1},t:{x:1,y:0},rotation:0},{angle:270,n:{x:-1,y:0},t:{x:0,y:-1},rotation:270}];
  for(const {angle,n,t,rotation} of expected) {
    const layout:any=prepareTextLayout({...options,shape:'circle',baseTextAngleDeg:angle} as any,circle,0);
    assert.ok(layout.report.anchorMm,'layout exposes the centre used to place the glyphs');
    close(layout.report.anchorMm.x,n.x*17.00002);close(layout.report.anchorMm.y,n.y*17.00002);
    assert.equal(layout.report.rotationDeg,rotation);assert.equal(layout.report.baseTextAngleDeg,angle);
    const tangent=projectionBounds(layout,t),outward=projectionBounds(layout,n);
    close((tangent.min+tangent.max)/2,0);close(tangent.max-tangent.min,4.5);
    close(outward.min,15.50002);close(outward.max-outward.min,3);
    assert.equal(layout.report.contours[0].holes.length,1);close(layout.report.volumeMm3,5.7);
    assertFullSafetyMargin(layout,circle);
    const hole=layout.report.contours[0].holes[0],holeX=hole.reduce((sum:number,p:any)=>sum+p.x,0)/hole.length,holeY=hole.reduce((sum:number,p:any)=>sum+p.y,0)/hole.length;
    // The hole centre is 0.75 mm left and 0.5 mm below the complete glyph bbox centre.
    close(holeX,layout.report.anchorMm.x-0.75*t.x+0.5*n.x);close(holeY,layout.report.anchorMm.y-0.75*t.y+0.5*n.y);
  }
  const zero:any=prepareTextLayout({...options,shape:'circle',baseTextAngleDeg:0} as any,circle,0),full:any=prepareTextLayout({...options,shape:'circle',baseTextAngleDeg:360} as any,circle,0);
  assert.deepEqual(full,zero);
});

test('arbitrary circular positions use the actual outline support and centre the glyph bounding box on the tangent',()=>{
  const layout:any=prepareTextLayout({...options,shape:'circle',baseTextAngleDeg:37} as any,circle,0);
  assert.ok(layout.report.anchorMm,'layout exposes the centre used to place the glyphs');
  const n={x:Math.sin(37*Math.PI/180),y:Math.cos(37*Math.PI/180)},t={x:-n.y,y:n.x};
  const support=Math.max(...circle.map(p=>(p.X*n.x+p.Y*n.y)/SCALE));
  close(layout.report.anchorMm.x*n.x+layout.report.anchorMm.y*n.y,support+2.00002);
  const tangent=projectionBounds(layout,t),outward=projectionBounds(layout,n);
  close((tangent.min+tangent.max)/2,0);close(outward.min,support+0.50002);
  close(layout.report.rotationDeg,143);
});

test('every sharp and rounded polygon edge keeps its original number and centres the complete label on that side',()=>{
  for(let sides=3;sides<=8;sides++)for(const cornerRadiusMm of [0,3,15*Math.cos(Math.PI/sides)])for(let edge=0;edge<sides;edge++) {
    const crop:TerrainCropRegion={shape:'polygon',widthMm:30,heightMm:30,radiusMm:15,polygonSides:sides,cornerRadiusMm,centerLat:30,centerLon:104,bearingDeg:0,minLat:29,maxLat:31,minLon:103,maxLon:105};
    const inner=buildFootprintPolygonMm(crop)!.map(p=>({X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)}));
    const layout:any=prepareTextLayout({...options,shape:'polygon',widthMm:30,polygonSides:sides,cornerRadiusMm,baseTextEdgeIndex:edge} as any,inner,0);
    const rotation=edge*360/sides,a=rotation*Math.PI/180,t={x:Math.cos(a),y:Math.sin(a)},n={x:Math.sin(a),y:-Math.cos(a)};
    close(layout.report.rotationDeg,rotation);assert.equal(layout.report.baseTextEdgeIndex,edge);
    const tangent=projectionBounds(layout,t),outward=projectionBounds(layout,n);
    close((tangent.min+tangent.max)/2,0);close(tangent.max-tangent.min,4.5);
    close(outward.min,Math.max(...inner.map(p=>(p.X*n.x+p.Y*n.y)/SCALE))+0.50002);
    assert.equal(layout.report.edgeCentersMm.length,sides);
    close(layout.report.edgeCentersMm[edge].x,n.x*15*Math.cos(Math.PI/sides));
    close(layout.report.edgeCentersMm[edge].y,n.y*15*Math.cos(Math.PI/sides));
    assertFullSafetyMargin(layout,inner);
    assert.equal(ClipperLib.Clipper.PointInPolygon({X:Math.round(layout.report.anchorMm.x*SCALE),Y:Math.round(layout.report.anchorMm.y*SCALE)},inner),0);
    assert.ok(layout.effectiveFrameWidthMm<=20);
  }
});

test('the default front placement stays compatible for direct rectangle callers and returns the shared final outline',()=>{
  const inner=ring(-15,-15,30,30).map(p=>({X:p.x*SCALE,Y:p.y*SCALE}));
  const layout:any=prepareTextLayout(options,inner,0),explicit:any=prepareTextLayout({...options,shape:'rectangle',baseTextAngleDeg:90,baseTextEdgeIndex:7} as any,inner,0);
  assert.ok(layout.report.anchorMm,'layout exposes the centre used to place the glyphs');
  assert.deepEqual(explicit.report.contours,layout.report.contours);close(layout.report.anchorMm.x,0);close(layout.report.anchorMm.y,-17.00002);assert.equal(layout.report.rotationDeg,0);
  assert.ok(layout.outlineMm.length>=4);close(Math.min(...layout.outlineMm.map((p:any)=>p.y)),-15-layout.effectiveFrameWidthMm,0.0001);
  const empty:any=prepareTextLayout({baseText:''},inner,0);assert.deepEqual(empty.outlineMm,ring(-15,-15,30,30));assert.equal(empty.report.finalSizeMm.width,30);
  const emptyFrame:any=prepareTextLayout({baseText:''},inner,3);assert.ok(emptyFrame.outlineMm.some((p:any)=>p.y<-15));assert.equal(emptyFrame.report.finalSizeMm.width,36);
});

function sourceMesh(shape:'circle'|'polygon',sides=6,cornerRadiusMm=0) {
  const crop:TerrainCropRegion={shape,widthMm:30,heightMm:30,radiusMm:15,polygonSides:sides,cornerRadiusMm,centerLat:30,centerLon:104,bearingDeg:0,minLat:29,maxLat:31,minLon:103,maxLon:105};
  const heights=Float64Array.from({length:81},(_,i)=>(i%9)*0.2);
  const mesh=buildHeightfieldTerrainMesh(crop,heights,9,9,2);for(let i=2;i<mesh.positions.length;i+=3)mesh.positions[i]+=2;mesh.minSurfaceZ+=2;mesh.bottomZ=0;return mesh;
}

test('selected circular positions and polygon sides form closed terrain, snow and text volumes with conserved added volume',()=>{
  const cases=[...[0,90,180,270,360].map(angle=>({shape:'circle' as const,baseTextAngleDeg:angle})),...[3,4,5,6,7,8].flatMap(polygonSides=>[...Array.from({length:polygonSides},(_,baseTextEdgeIndex)=>({shape:'polygon' as const,polygonSides,baseTextEdgeIndex,cornerRadiusMm:3})),{shape:'polygon' as const,polygonSides,baseTextEdgeIndex:0,cornerRadiusMm:15*Math.cos(Math.PI/polygonSides)}])];
  for(const placement of cases) {
    const terrainMesh=sourceMesh(placement.shape,'polygonSides' in placement?placement.polygonSides:6,'cornerRadiusMm' in placement?placement.cornerRadiusMm:0),source=assertPrintableMesh(terrainMesh);
    const result=buildIntegratedTerrainMesh({...options,...placement,widthMm:30,heightMm:30,terrainMesh,routeSegmentsMm:[[{x:-8,y:0},{x:8,y:0}]],frameWidthMm:0,baseThicknessMm:2,snowEnabled:true,snowCoveragePercent:50,snowMaxThicknessMm:1} as any);
    const outer=assertPrintableMesh({...result.mesh,positions:result.mesh.positions.map(Math.fround)});assert.equal(outer.connectedComponents,1);
    const material=validateMaterialParts({...result.mesh,positions:result.mesh.positions.map(Math.fround),materialParts:result.mesh.materialParts!.map(p=>({...p,positions:p.positions.map(Math.fround)}))})!;
    assert.ok(material.parts.some(p=>p.id==='text'));assert.ok(Math.abs(material.volumeMm3-material.outerVolumeMm3)<=material.volumeToleranceMm3);
    close(outer.volumeMm3-source.volumeMm3,result.report.expectedAddedVolumeMm3,0.02);
    const label:any=result.report.baseText;assert.equal(label.contours[0].holes.length,1);close(label.volumeMm3,5.7,0.0001);
    if(placement.shape==='circle'&&placement.baseTextAngleDeg===90){assert.ok(label.anchorMm);assert.ok(label.anchorMm.x>15);}
    if(placement.shape==='polygon')assert.equal(label.baseTextEdgeIndex,placement.baseTextEdgeIndex);
  }
});

const gpxXml='<gpx><trk><trkseg><trkpt lat="30" lon="104"/><trkpt lat="30.001" lon="104.001"/></trkseg></trk></gpx>';
test('invalid placement is rejected before any DEM fetch, including edge indices outside the chosen polygon',async()=>{
  for(const placement of [{baseTextAngleDeg:-1},{baseTextAngleDeg:361},{baseTextAngleDeg:NaN},{baseTextEdgeIndex:-1},{baseTextEdgeIndex:8},{baseTextEdgeIndex:0.5},{shape:'polygon',polygonSides:3,baseTextEdgeIndex:3}]) {
    let loaded=false;
    await assert.rejects(()=>generatePrintableTerrain({gpxXml,options:{...options,...placement} as any,loadDem:async()=>{loaded=true;return{sample:()=>100,metadata:{}};}}),{code:'CONFIG_INVALID'});
    assert.equal(loaded,false);
  }
});

test('generation passes circular positioning through to the printable model and normalized configuration',async()=>{
  const result=await generatePrintableTerrain({gpxXml,options:{...options,shape:'circle',widthMm:30,baseTextAngleDeg:360,routeEnabled:false,gridColumns:17} as any,loadDem:async()=>({sample:()=>100,metadata:{}})});
  const label:any=(result.report.integratedModel as any).baseText;
  assert.ok(label.anchorMm);assert.ok(label.anchorMm.y>15);close(label.anchorMm.x,0);assert.equal(label.baseTextAngleDeg,0);assert.equal((result.report.config as any).baseTextAngleDeg,0);
});
