import { TerrainError } from '../errors.js';
import type { TerrainMeshPayload } from '../vendor/trailprint/types.js';

/** Independently sample the original emitted triangle planes at the final XY coordinates. */
export function checkIntegratedSurfaceHeights(source:TerrainMeshPayload,mesh:TerrainMeshPayload) {
  const cells=new Map<string,number[]>(),points=source.positions;
  let radius=0;for(let i=0;i<points.length;i+=3)radius=Math.max(radius,Math.abs(points[i]),Math.abs(points[i+1]));
  const step=Math.max(0.5,radius*2/(Math.max(source.gridCols,source.gridRows)-1));
  const plane=(face:number)=>source.indices.slice(face*3,face*3+3).map(index=>points.slice(index*3,index*3+3));
  for(let face=0;face<source.indices.length/3;face++) {
    const [a,b,c]=plane(face),area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    if(area<=0)continue;
    for(let y=Math.floor((Math.min(a[1],b[1],c[1])-0.00005)/step);y<=Math.floor((Math.max(a[1],b[1],c[1])+0.00005)/step);y++)
      for(let x=Math.floor((Math.min(a[0],b[0],c[0])-0.00005)/step);x<=Math.floor((Math.max(a[0],b[0],c[0])+0.00005)/step);x++) {
        const key=`${x},${y}`,list=cells.get(key)??[];list.push(face);cells.set(key,list);
      }
  }
  function surfaceAt(x:number,y:number) {
    let bestDistance=Infinity,bestHeight=NaN;
    for(const face of cells.get(`${Math.floor(x/step)},${Math.floor(y/step)}`)??[]) {
      const [a,b,c]=plane(face),area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const u=((x-a[0])*(c[1]-a[1])-(y-a[1])*(c[0]-a[0]))/area;
      const v=((b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]))/area;
      const score=Math.min(1-u-v,u,v);
      const distance=Math.max(0,-(1-u-v)*area/Math.hypot(c[0]-b[0],c[1]-b[1]),-u*area/Math.hypot(c[0]-a[0],c[1]-a[1]),-v*area/Math.hypot(b[0]-a[0],b[1]-a[1]));
      if(distance<bestDistance){bestDistance=distance;bestHeight=a[2]+u*(b[2]-a[2])+v*(c[2]-a[2]);}
      if(score>=-1e-10)return a[2]+u*(b[2]-a[2])+v*(c[2]-a[2]);
    }
    // XY clipping and STL Float32 can put an outer point a few micrometres beyond its source plane.
    if(bestDistance<=0.00005&&Number.isFinite(bestHeight))return bestHeight;
    throw new TerrainError('MODEL_SURFACE_MISMATCH','最终地表顶点不能对应到原地形三角面');
  }
  let routeError=0,routeStlError=0,terrainError=0,terrainStlError=0;
  const routeVertices=new Set<number>(),terrainVertices=new Set<number>();
  for(let face=0;face<mesh.indices.length/3;face++) {
    const kind=mesh.faceKinds?.[face];if(kind!=='route'&&kind!=='terrain')continue;
    const set=kind==='route'?routeVertices:terrainVertices;
    for(let k=0;k<3;k++)set.add(mesh.indices[face*3+k]);
  }
  for(const [kind,vertices] of [['route',routeVertices],['terrain',terrainVertices]] as const)for(const vertex of vertices) {
    const [x,y,z]=mesh.positions.slice(vertex*3,vertex*3+3),expected=kind==='route'?1:0;
    const error=Math.abs(z-surfaceAt(x,y)-expected);
    const stlError=Math.abs(Math.fround(z)-surfaceAt(Math.fround(x),Math.fround(y))-expected);
    if(kind==='route'){routeError=Math.max(routeError,error);routeStlError=Math.max(routeStlError,stlError);}
    else{terrainError=Math.max(terrainError,error);terrainStlError=Math.max(terrainStlError,stlError);}
  }
  const max=Math.max(routeError,routeStlError,terrainError,terrainStlError);
  if(max>0.001)throw new TerrainError('MODEL_SURFACE_MISMATCH',`地表或 1 mm 路线高度残差 ${max.toFixed(6)} mm 超过 0.001 mm 容差`);
  return {routeErrorMm:routeError,routeStlErrorMm:routeStlError,terrainErrorMm:terrainError,terrainStlErrorMm:terrainStlError,toleranceMm:0.001,routeVertexCount:routeVertices.size,terrainVertexCount:terrainVertices.size};
}
