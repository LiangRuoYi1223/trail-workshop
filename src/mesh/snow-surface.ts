import { TerrainError } from '../errors.js';
import { MAX_MESH_TRIANGLES } from '../vendor/trailprint/heightfield-mesh.js';
import type { TerrainMeshPayload } from '../vendor/trailprint/types.js';

interface Point {x:number;y:number;z:number;score:number;retention:number}
type Face = [number,number,number];
export interface SnowReport {
  enabled:true;
  requestedCoveragePercent:number;
  actualCoveragePercent:number;
  coverageTolerancePercent:number;
  areaMm2:number;
  volumeMm3:number;
  maxThicknessMm:number;
  actualMaxThicknessMm:number;
  altitudeThresholdMm:number;
  transitionElevationMm:number;
  transitionDistanceMm:number;
}
export interface SnowSurface {
  mesh:TerrainMeshPayload;
  outline:Array<{x:number;y:number}>;
  terrainHeights:number[];
  report:SnowReport;
}
const area=(p:Point[])=>Math.abs(p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a.x*b.y-a.y*b.x;},0))/2;

/** A scalar-plane clip retains interpolated DEM elevations and shared edge intersections. */
function clip(points:Point[],threshold:number,above:boolean):Point[] {
  const out:Point[]=[];
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length],insideA=above?a.score>=threshold:a.score<=threshold,insideB=above?b.score>=threshold:b.score<=threshold;
    if(insideA)out.push(a);
    if(insideA!==insideB) {
      const t=(threshold-a.score)/(b.score-a.score);
      out.push({x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y),z:a.z+t*(b.z-a.z),score:threshold,retention:a.retention+t*(b.retention-a.retention)});
    }
  }
  return out.filter((p,i)=>Math.hypot(p.x-out[(i+out.length-1)%out.length].x,p.y-out[(i+out.length-1)%out.length].y)>1e-9);
}

/** Select altitude by exact projected triangle area, then emit a continuous piecewise-linear snow surface. */
export function buildSnowSurface(source:TerrainMeshPayload,coverage:number,maxThickness:number,zExaggeration=1,signal?:AbortSignal,base=source.minSurfaceZ):SnowSurface {
  signal?.throwIfAborted();
  // A smaller uncovered sliver cannot be resolved reliably; the measured report
  // exposes this at most 0.01 percentage-point approximation explicitly.
  const fullyCovered=coverage>=99.99;
  const noneCovered=coverage<=0.01;
  // A microscopic DEM/base seam cannot survive STL coordinates and fixed welding.
  // Flatten only that seam, before all three material intervals are constructed.
  const points:Point[]=Array.from({length:source.positions.length/3},(_,i)=>{const original=source.positions[i*3+2],z=Math.abs(original-base)<=Math.max(3e-6,Math.abs(base)*2e-7)?base:original;return {x:source.positions[i*3],y:source.positions[i*3+1],z,score:z,retention:1};});
  const faces:Face[]=[],slopeSum=new Float64Array(points.length),weightSum=new Float64Array(points.length);
  const perimeter=new Map<string,{a:number;b:number}>();
  let totalArea=0,minZ=Infinity,maxZ=-Infinity,minY=Infinity,maxY=-Infinity;
  for(let i=0;i<source.indices.length;i+=3) {
    const ids=source.indices.slice(i,i+3) as Face,[a,b,c]=ids.map(id=>points[id]);
    const cross=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);if(cross<=0)continue;
    faces.push(ids);totalArea+=cross/2;
    for(const [from,to] of [[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[0]]]){const key=from<to?`${from},${to}`:`${to},${from}`;if(perimeter.has(key))perimeter.delete(key);else perimeter.set(key,{a:from,b:to});}
    const gx=((b.z-a.z)*(c.y-a.y)-(c.z-a.z)*(b.y-a.y))/cross/zExaggeration;
    const gy=((b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z))/cross/zExaggeration;
    const slope2=gx*gx+gy*gy;
    for(const id of ids){slopeSum[id]+=slope2*cross;weightSum[id]+=cross;const p=points[id];minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
  }
  if(!faces.length||totalArea<=0)throw new TerrainError('MESH_INVALID','地形没有可用的积雪顶面');
  const next=new Map(Array.from(perimeter.values(),edge=>[edge.a,edge.b])),outline:Array<{x:number;y:number}>=[];
  const start=next.keys().next().value as number;let cursor=start;
  do {outline.push({x:points[cursor].x,y:points[cursor].y});const successor=next.get(cursor);if(successor===undefined||outline.length>next.size)throw new TerrainError('MESH_INVALID','积雪地形边界不能闭合');cursor=successor;}while(cursor!==start);
  if(outline.length!==next.size)throw new TerrainError('MESH_INVALID','积雪地形只能有一个外轮廓');
  for(let i=0;i<points.length;i++)if(weightSum[i])points[i].retention=1/(1+slopeSum[i]/weightSum[i]/0.65**2);
  const coveredArea=(threshold:number)=>faces.reduce((sum,ids)=>sum+area(clip(ids.map(id=>points[id]),threshold,true)),0);
  const target=totalArea*coverage/100;
  function quantile() {
    let lo=Infinity,hi=-Infinity;for(const ids of faces)for(const id of ids){lo=Math.min(lo,points[id].score);hi=Math.max(hi,points[id].score);}
    if(hi===lo)return lo;
    for(let i=0;i<44;i++){const middle=(lo+hi)/2;if(coveredArea(middle)>target)lo=middle;else hi=middle;}
    return (lo+hi)/2;
  }
  let threshold=fullyCovered?minZ:noneCovered?maxZ:quantile();
  // Equal-altitude plateaus have no natural ordering. A tiny northward tie-break
  // gives them deterministic partial coverage without discarding whole DEM cells.
  if(!fullyCovered&&!noneCovered&&Math.abs(coveredArea(threshold)-target)>totalArea*1e-5) {
    const tie=Math.max((maxZ-minZ)*0.02,0.01);
    for(const p of points)p.score=p.z+tie*(p.y-minY)/Math.max(maxY-minY,1);
    threshold=quantile();
  }
  let scoreMax=-Infinity;for(let i=0;i<points.length;i++)if(weightSum[i])scoreMax=Math.max(scoreMax,points[i].score);
  // A contour exactly through a DEM saddle can make snow islands touch along
  // a zero-thickness edge. Move only numerically coincident levels, within the
  // declared coverage tolerance, to produce resolvable closed material islands.
  const levelTolerance=Math.max((scoreMax-minZ)*1e-4,1e-5);
  if(!fullyCovered&&!noneCovered) {
    let nearest: number|undefined;
    for(let i=0;i<points.length;i++)if(weightSum[i]&&Math.abs(points[i].score-threshold)<levelTolerance&&(nearest===undefined||Math.abs(points[i].score-threshold)<Math.abs(nearest-threshold)))nearest=points[i].score;
    if(nearest!==undefined) {
      for(let epsilon=levelTolerance;epsilon>=levelTolerance/1024;epsilon/=2) {
        const candidate=nearest+epsilon;
        if(Math.abs(coveredArea(candidate)-target)<=totalArea*0.00015){threshold=candidate;break;}
      }
    }
  }
  let transition=Math.max(Math.min((maxZ-minZ)*0.08,(scoreMax-threshold)*0.3),(scoreMax-threshold)*0.12,1e-12);
  for(let i=0;i<points.length;i++)if(weightSum[i]&&Math.abs(points[i].score-threshold-transition)<levelTolerance){transition=points[i].score+levelTolerance-threshold;break;}
  const taperDistance=Math.max(0.5,Math.min(3,maxThickness*2));
  const contours:Array<[Point,Point]>=[],contourBins=new Map<string,number[]>();
  const binSize=Math.max(taperDistance,Math.max(maxY-minY,1)/Math.max(source.gridRows-1,1));
  function cells(xmin:number,ymin:number,xmax:number,ymax:number) {
    const keys:string[]=[];for(let y=Math.floor(ymin/binSize);y<=Math.floor(ymax/binSize);y++)for(let x=Math.floor(xmin/binSize);x<=Math.floor(xmax/binSize);x++)keys.push(`${x},${y}`);return keys;
  }
  if(!fullyCovered&&!noneCovered)for(const [i,ids] of faces.entries()) {
    if(i%256===0)signal?.throwIfAborted();const wet=clip(ids.map(id=>points[id]),threshold,true),line=wet.filter(p=>p.score===threshold);
    if(line.length!==2||Math.hypot(line[0].x-line[1].x,line[0].y-line[1].y)<1e-9)continue;
    const [a,b]=line,id=contours.length;contours.push([a,b]);
    for(const key of cells(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.max(a.x,b.x),Math.max(a.y,b.y))){const values=contourBins.get(key)??[];values.push(id);contourBins.set(key,values);}
  }
  function distanceRamp(p:Point) {
    if(fullyCovered)return 1;if(noneCovered||p.score<=threshold)return 0;
    let distance2=taperDistance*taperDistance;const visited=new Set<number>();
    for(const cell of cells(p.x-taperDistance,p.y-taperDistance,p.x+taperDistance,p.y+taperDistance))for(const id of contourBins.get(cell)??[]) {
      if(visited.has(id))continue;visited.add(id);const [a,b]=contours[id],dx=b.x-a.x,dy=b.y-a.y,length2=dx*dx+dy*dy;
      const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length2)),x=p.x-a.x-t*dx,y=p.y-a.y-t*dy;
      distance2=Math.min(distance2,x*x+y*y);
    }
    return Math.sqrt(distance2)/taperDistance;
  }
  const positions:number[]=[],indices:number[]=[],terrainHeights:number[]=[],faceKinds:NonNullable<TerrainMeshPayload['faceKinds']>=[],map=new Map<string,number>();
  let actualArea=0,volume=0,actualMax=0;
  function vertex(p:Point) {
    const key=`${Math.round(p.x*1e9)},${Math.round(p.y*1e9)}`;const found=map.get(key);if(found!==undefined)return found;
    const ramp=distanceRamp(p);
    const thickness=maxThickness*ramp*p.retention,index=positions.length/3;
    positions.push(p.x,p.y,p.z+thickness);terrainHeights.push(p.z);map.set(key,index);actualMax=Math.max(actualMax,thickness);return index;
  }
  function emit(polygon:Point[],wet:boolean) {
    if(polygon.length<3||area(polygon)<1e-10)return;
    const ids=polygon.map(vertex);
    for(let i=1;i<ids.length-1;i++) {
      const face=[ids[0],ids[i],ids[i+1]],p=face.map(id=>positions.slice(id*3,id*3+3));
      const projected=((p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]))/2;
      if(projected<=1e-10)continue;
      indices.push(...face);faceKinds.push(wet?'snow':'terrain');
      if(wet){actualArea+=projected;volume+=projected*face.reduce((sum,id)=>sum+positions[id*3+2]-terrainHeights[id],0)/3;}
      if(indices.length/3>MAX_MESH_TRIANGLES/2)throw new TerrainError('MESH_TOO_COMPLEX','积雪分区超过三角面预算，请降低采样');
    }
  }
  for(const [i,ids] of faces.entries()) {
    if(i%256===0)signal?.throwIfAborted();const triangle=ids.map(id=>points[id]);
    if(fullyCovered){emit(triangle,true);continue;}
    if(noneCovered){emit(triangle,false);continue;}
    emit(clip(triangle,threshold,false),false);
    const wet=clip(triangle,threshold,true);
    emit(clip(wet,threshold+transition,false),true);emit(clip(wet,threshold+transition,true),true);
  }
  return {mesh:{...source,positions,indices,faceKinds,materialParts:undefined},outline,terrainHeights,report:{enabled:true,requestedCoveragePercent:coverage,actualCoveragePercent:actualArea/totalArea*100,coverageTolerancePercent:0.02,areaMm2:actualArea,volumeMm3:volume,maxThicknessMm:maxThickness,actualMaxThicknessMm:actualMax,altitudeThresholdMm:threshold,transitionElevationMm:transition,transitionDistanceMm:taperDistance}};
}
