import ClipperLib from 'clipper-lib';
import earcut, { deviation } from 'earcut';
import { TerrainError } from '../errors.js';
import { checkIntegratedSurfaceHeights } from './surface-check.js';
import { buildSnowSurface } from './snow-surface.js';
import { buildMaterialParts } from './material-parts.js';
import { buildRouteCorridor, regionsAreaMm2, toIntPoint, SCALE, type IntPoint, type PolygonRegion } from '../route/corridor.js';
import { precisePartition } from '../route/precise-partition.js';
import { MAX_MESH_TRIANGLES } from '../vendor/trailprint/heightfield-mesh.js';
import type { TerrainMeshPayload } from '../vendor/trailprint/types.js';

type Kind=NonNullable<TerrainMeshPayload['faceKinds']>[number];
type TopKind='terrain'|'route'|'frame';
type Triangle={ids:[number,number,number];kind:TopKind};
interface XY extends IntPoint {baseZ:number;terrainZ:number}
export interface IntegratedMeshRequest {
  terrainMesh:TerrainMeshPayload;
  routeSegmentsMm:Array<Array<{x:number;y:number}>>;
  routeWidthMm?:number; routeHeightMm?:number; frameWidthMm?:number; baseThicknessMm?:number;
  snowEnabled?:boolean; snowCoveragePercent?:number; snowMaxThicknessMm?:number; zExaggeration?:number;
  signal?:AbortSignal;
}

/** A partition of the source surface, one raised region, and an integral flat ledge. No internal skins. */
export function buildIntegratedTerrainMesh(input:IntegratedMeshRequest) {
  const routeWidth=input.routeWidthMm ?? 1,routeHeight=input.routeHeightMm ?? 1,frameWidth=input.frameWidthMm ?? 3,base=input.baseThicknessMm ?? 2;
  if(!Number.isFinite(routeWidth)||routeWidth<0.4||routeWidth>5)throw new TerrainError('CONFIG_INVALID','路线宽度须在 0.4–5 mm 之间');
  if(!Number.isFinite(routeHeight)||routeHeight<0.1||routeHeight>10)throw new TerrainError('CONFIG_INVALID','路线厚度须在 0.1–10 mm 之间');
  if(!Number.isFinite(frameWidth)||frameWidth<0||frameWidth>20)throw new TerrainError('CONFIG_INVALID','一体边框宽度须在 0–20 mm 之间');
  if(!Number.isFinite(base)||base<0.5||base>30)throw new TerrainError('CONFIG_INVALID','基础底厚须在 0.5–30 mm 之间');
  const snowCoverage=input.snowCoveragePercent??30,snowThickness=input.snowMaxThicknessMm??1,zExaggeration=input.zExaggeration??1;
  if(input.snowEnabled!==undefined&&typeof input.snowEnabled!=='boolean')throw new TerrainError('CONFIG_INVALID','积雪开关须为布尔值');
  if(!Number.isFinite(snowCoverage)||snowCoverage<0||snowCoverage>100)throw new TerrainError('CONFIG_INVALID','积雪覆盖率须在 0–100% 之间');
  if(!Number.isFinite(snowThickness)||snowThickness<0.1||snowThickness>10)throw new TerrainError('CONFIG_INVALID','最大积雪厚度须在 0.1–10 mm 之间');
  if(!Number.isFinite(zExaggeration)||zExaggeration<=0)throw new TerrainError('CONFIG_INVALID','垂直夸张须为正数');
  input.signal?.throwIfAborted();
  const snow=input.snowEnabled&&snowCoverage>0?buildSnowSurface(input.terrainMesh,snowCoverage,snowThickness,zExaggeration,input.signal,base):undefined;
  const source=snow?.mesh??input.terrainMesh;
  const tops:Array<[number,number,number]>=[],perimeter=new Map<string,{a:number;b:number}>();
  const point=(index:number)=>({x:source.positions[index*3],y:source.positions[index*3+1]});
  const z=(index:number)=>source.positions[index*3+2];
  const cross=(a:{X:number;Y:number},b:{X:number;Y:number},c:{X:number;Y:number})=>(b.X-a.X)*(c.Y-a.Y)-(b.Y-a.Y)*(c.X-a.X);
  for(let i=0;i<source.indices.length;i+=3) {
    const ids=source.indices.slice(i,i+3) as [number,number,number],a=point(ids[0]),b=point(ids[1]),c=point(ids[2]);
    if((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)<=0)continue;
    tops.push(ids);
    for(const [a,b] of [[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[0]]]) {
      const key=a<b?`${a},${b}`:`${b},${a}`;
      if(perimeter.has(key))perimeter.delete(key);else perimeter.set(key,{a,b});
    }
  }
  const next=new Map(Array.from(perimeter.values(),e=>[e.a,e.b]));
  const start=next.keys().next().value as number|undefined;
  if(start===undefined)throw new TerrainError('MESH_INVALID','地形没有可用的顶面轮廓');
  const outline:Array<{x:number;y:number}>=[];let current=start;
  do {outline.push(point(current));const n=next.get(current);if(n===undefined)throw new TerrainError('MESH_INVALID','地形顶面边界不连续');current=n;if(outline.length>next.size)throw new TerrainError('MESH_INVALID','地形顶面边界不能闭合');}while(current!==start);
  if(outline.length!==next.size)throw new TerrainError('MESH_INVALID','当前仅支持一个连通地形轮廓');
  const buffered=buildRouteCorridor(input.routeSegmentsMm,outline,{widthMm:routeWidth});
  // Preserve the source surface exactly; re-quantising its straight borders can
  // create micrometre wedges that collapse when STL coordinates return to Float32.
  const sourcePoint=(p:{x:number;y:number}):IntPoint=>({X:p.x*SCALE,Y:p.y*SCALE});
  const inner=outline.map(sourcePoint);
  const regions=precisePartition(buffered.bufferedRegions,[{outer:inner,holes:[]}],'intersection');
  const corridor={...buffered,regions,paths:regions.flatMap(r=>[r.outer,...r.holes]),areaMm2:regionsAreaMm2(regions)};
  if(!corridor.paths.length)throw new TerrainError('ROUTE_OUTSIDE_SELECTION','选区内没有可生成浮雕的连续路线，请调整取景');
  let frameRegions:PolygonRegion[]=[],outerPaths:IntPoint[][]=[inner];
  if(frameWidth>0) {
    const offset=new ClipperLib.ClipperOffset(2,0.01*SCALE);
    // Float32 terrain tangencies can become micrometre zigzags after integer rounding.
    // Clean only the offset seed; the ring difference still shares the original inner boundary.
    const frameOutline=snow?.outline??outline;
    const frameInner=snow?frameOutline.map(sourcePoint):inner;
    const offsetSeed=ClipperLib.Clipper.CleanPolygon(frameOutline.map(toIntPoint),4);
    offset.AddPath(offsetSeed,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
    const expanded:IntPoint[][]=[];offset.Execute(expanded,frameWidth*SCALE);outerPaths=expanded;
    frameRegions=precisePartition(expanded.map(outer=>({outer,holes:[]})),[{outer:frameInner,holes:[]}],'difference');
  }
  const frameArea=regionsAreaMm2(frameRegions);
  const xy:XY[]=[],xyMap=new Map<string,number>(),raw:Triangle[]=[];
  function xyVertex(p:IntPoint,baseZ:number,terrainZ=baseZ):number {
    // Match floating shared intersections without re-rounding geometry to an integer lattice.
    const key=`${Math.round(p.X*1000)},${Math.round(p.Y*1000)}`;const found=xyMap.get(key);if(found!==undefined)return found;
    const index=xy.length;xy.push({...p,baseZ:Math.max(base,baseZ),terrainZ:Math.max(base,terrainZ)});xyMap.set(key,index);return index;
  }
  function addRaw(ids:[number,number,number],kind:TopKind) {
    const area=cross(xy[ids[0]],xy[ids[1]],xy[ids[2]]);
    // Snow clips can create resolvable positive facets below the legacy area
    // floor. Keep them so an interior seam cannot become a through-hole wall.
    if(snow?area===0:Math.abs(area)<1)return;
    if(snow&&kind==='frame') {
      const exported=ids.map(id=>({X:Math.fround(xy[id].X/SCALE),Y:Math.fround(xy[id].Y/SCALE)}));
      // Flat frame rings can contain a collinear Float32 midpoint whose tiny
      // arithmetic perturbation makes earcut emit a phantom face. Keep its XY
      // point for global edge noding, but not the zero-area flat triangle.
      if(Math.abs(cross(exported[0],exported[1],exported[2]))<=1e-12)return;
    }
    raw.push({ids:area>0?ids:[ids[0],ids[2],ids[1]],kind});
    if(raw.length*2>MAX_MESH_TRIANGLES)throw new TerrainError('MESH_TOO_COMPLEX','浮雕网格超过三角面预算，请降低采样或减少路线点数');
  }
  function triangulate(regions:PolygonRegion[],kind:TopKind,height:(p:IntPoint)=>number,terrainHeight=height) {
    for(const region of regions) {
      const coords:number[]=[],ids:number[]=[],holes:number[]=[];
      for(const [ringIndex,ring] of [region.outer,...region.holes].entries()) {
        if(ringIndex)holes.push(ids.length);
        for(const p of ring){coords.push(p.X,p.Y);ids.push(xyVertex(p,height(p),terrainHeight(p)));}
      }
      const triangles=earcut(coords,holes,2);
      if(deviation(coords,holes,2,triangles)>1e-6)throw new TerrainError('MESH_TRIANGULATION_FAILED','路线分区三角化面积不一致');
      for(let i=0;i<triangles.length;i+=3)addRaw([ids[triangles[i]],ids[triangles[i+1]],ids[triangles[i+2]]],kind);
    }
  }
  const step=Math.max(0.5,Math.max(...outline.map(p=>Math.abs(p.x)*2),...outline.map(p=>Math.abs(p.y)*2))/(Math.max(source.gridCols,source.gridRows)-1))*SCALE;
  const edgeBins=new Set<string>();
  const keysFor=(xmin:number,ymin:number,xmax:number,ymax:number)=>{
    const keys:string[]=[];
    for(let y=Math.floor(ymin/step);y<=Math.floor(ymax/step);y++)for(let x=Math.floor(xmin/step);x<=Math.floor(xmax/step);x++)keys.push(`${x},${y}`);
    return keys;
  };
  for(const path of corridor.paths)for(let i=0;i<path.length;i++) {
    const a=path[i],b=path[(i+1)%path.length];
    for(const key of keysFor(Math.min(a.X,b.X),Math.min(a.Y,b.Y),Math.max(a.X,b.X),Math.max(a.Y,b.Y)))edgeBins.add(key);
  }
  const inRoute=(p:IntPoint)=>corridor.regions.some(region=>ClipperLib.Clipper.PointInPolygon(p,region.outer)!==0&&!region.holes.some(h=>ClipperLib.Clipper.PointInPolygon(p,h)===1));
  let affectedSourceTriangles=0;
  for(const [face,indices] of tops.entries()) {
    if(face%256===0)input.signal?.throwIfAborted();
    const tri=indices.map(index=>sourcePoint(point(index))),heights=indices.map(z),terrainHeights=indices.map(index=>snow?.terrainHeights[index]??z(index));
    const denominator=cross(tri[0],tri[1],tri[2]);
    if(denominator<=0)throw new TerrainError('MESH_NUMERIC_UNSTABLE','地形三角面小于路线构造精度');
    const height=(p:IntPoint)=>{
      const u=cross(tri[0],p,tri[2])/denominator,v=cross(tri[0],tri[1],p)/denominator;
      return heights[0]+u*(heights[1]-heights[0])+v*(heights[2]-heights[0]);
    };
    const terrainHeight=(p:IntPoint)=>{
      const u=cross(tri[0],p,tri[2])/denominator,v=cross(tri[0],tri[1],p)/denominator;
      return terrainHeights[0]+u*(terrainHeights[1]-terrainHeights[0])+v*(terrainHeights[2]-terrainHeights[0]);
    };
    const crossesBoundary=keysFor(Math.min(...tri.map(p=>p.X)),Math.min(...tri.map(p=>p.Y)),Math.max(...tri.map(p=>p.X)),Math.max(...tri.map(p=>p.Y))).some(key=>edgeBins.has(key));
    if(!crossesBoundary) {
      const center={X:(tri[0].X+tri[1].X+tri[2].X)/3,Y:(tri[0].Y+tri[1].Y+tri[2].Y)/3};
      addRaw(tri.map((p,i)=>xyVertex(p,heights[i],terrainHeights[i])) as [number,number,number],inRoute(center)?'route':'terrain');
    } else {
      affectedSourceTriangles++;
      triangulate(precisePartition([{outer:tri,holes:[]}],buffered.bufferedRegions,'intersection'),'route',height,terrainHeight);
      triangulate(precisePartition([{outer:tri,holes:[]}],buffered.bufferedRegions,'difference'),'terrain',height,terrainHeight);
    }
  }
  triangulate(frameRegions,'frame',()=>base);

  // Earcut may remove collinear input points. Inject every shared split point before closing walls.
  const bins=new Map<string,number[]>();
  for(const [index,p] of xy.entries()){const key=`${Math.floor(p.X/step)},${Math.floor(p.Y/step)}`;const list=bins.get(key)??[];list.push(index);bins.set(key,list);}
  const splitCache=new Map<string,number[]>();
  const oppositeVertices=new Map<string,Set<number>>();
  for(const {ids:[a,b,c]} of raw)for(const [from,to,opposite] of [[a,b,c],[b,c,a],[c,a,b]]) {
    const key=from<to?`${from},${to}`:`${to},${from}`,values=oppositeVertices.get(key)??new Set<number>();
    values.add(opposite);oppositeVertices.set(key,values);
  }
  function splitEdge(a:number,b:number):number[] {
    const reverse=a>b,key=reverse?`${b},${a}`:`${a},${b}`;
    let found=splitCache.get(key);
    if(!found) {
      const p=xy[reverse?b:a],q=xy[reverse?a:b],dx=q.X-p.X,dy=q.Y-p.Y,length2=dx*dx+dy*dy;
      const candidates:Array<{index:number;t:number}>=[];
      for(const cell of keysFor(Math.min(p.X,q.X)-2,Math.min(p.Y,q.Y)-2,Math.max(p.X,q.X)+2,Math.max(p.Y,q.Y)+2))for(const index of bins.get(cell)??[]) {
        if(index===a||index===b||oppositeVertices.get(key)?.has(index))continue;const r=xy[index],t=((r.X-p.X)*dx+(r.Y-p.Y)*dy)/length2;
        // Only actual collinear vertices may split an edge. A nearby point on another
        // contour is a distinct edge, even when the wedge is below a micrometre wide.
        if(t>1e-10&&t<1-1e-10&&Math.abs(dx*(r.Y-p.Y)-dy*(r.X-p.X))<=(snow?1e-7:1e-5)*Math.sqrt(length2))candidates.push({index,t});
      }
      candidates.sort((a,b)=>a.t-b.t);found=[reverse?b:a,...candidates.map(c=>c.index),reverse?a:b];splitCache.set(key,found);
    }
    return reverse?found.slice().reverse():found;
  }
  const noded:Triangle[]=[];
  for(const [face,triangle] of raw.entries()) {
    if(face%256===0)input.signal?.throwIfAborted();
    // A very thin valid source wedge can put its third vertex inside the edge tolerance.
    // It is still a corner of this face, never a subdivision of its opposite edge.
    const [a,b,c]=triangle.ids;
    let ab=splitEdge(a,b).filter(id=>id!==c),bc=splitEdge(b,c).filter(id=>id!==a),ca=splitEdge(c,a).filter(id=>id!==b);
    if(snow) {
      // A Float32 crop chord can form a valid very thin triangle. A contour point
      // on one edge may fall inside the collinearity tolerance of its opposite
      // edge too. Assign it to the geometrically closest edge, once per face.
      const edges=[ab,bc,ca],ends=[[a,b],[b,c],[c,a]],owners=new Map<number,number[]>();
      for(let edge=0;edge<3;edge++)for(const id of edges[edge].slice(1,-1)){const list=owners.get(id)??[];list.push(edge);owners.set(id,list);}
      for(const [id,candidates] of owners)if(candidates.length>1) {
        const distance=(edge:number)=>{const [from,to]=ends[edge];return Math.abs(cross(xy[from],xy[to],xy[id]))/Math.hypot(xy[to].X-xy[from].X,xy[to].Y-xy[from].Y);};
        candidates.sort((x,y)=>distance(x)-distance(y));
        for(const edge of candidates.slice(1))edges[edge]=edges[edge].filter(value=>value!==id);
      }
      [ab,bc,ca]=edges;
    }
    if(ab.length===2&&bc.length===2&&ca.length===2){noded.push(triangle);continue;}
    const ring=[...ab.slice(0,-1),...bc.slice(0,-1),...ca.slice(0,-1)];
    const center=xyVertex({X:(xy[a].X+xy[b].X+xy[c].X)/3,Y:(xy[a].Y+xy[b].Y+xy[c].Y)/3},(xy[a].baseZ+xy[b].baseZ+xy[c].baseZ)/3,(xy[a].terrainZ+xy[b].terrainZ+xy[c].terrainZ)/3);
    for(let i=0;i<ring.length;i++) {
      const ids:[number,number,number]=[center,ring[i],ring[(i+1)%ring.length]];
      if(cross(xy[ids[0]],xy[ids[1]],xy[ids[2]])>0)noded.push({ids,kind:triangle.kind});
      else throw new TerrainError('MESH_NUMERIC_UNSTABLE',`路线边界过近导致网格无法可靠构造（分区 ${face}），请减少过密路线点或调整线宽`);
    }
  }
  const positions:number[]=[],meshIndices:number[]=[],faceKinds:Kind[]=[],vertexMap=new Map<string,number>();
  const vertex=(id:number,height:number)=>{
    const p=xy[id],key=`${id},${Math.round(height*1e6)}`;const found=vertexMap.get(key);if(found!==undefined)return found;
    const index=positions.length/3;positions.push(p.X/SCALE,p.Y/SCALE,height);vertexMap.set(key,index);return index;
  };
  const face=(a:number,b:number,c:number,kind:Kind)=>{if(a===b||b===c||c===a)return;meshIndices.push(a,b,c);faceKinds.push(kind);if(faceKinds.length>MAX_MESH_TRIANGLES)throw new TerrainError('MESH_TOO_COMPLEX','一体模型超过 50 万三角面预算');};
  const heightFor=(id:number,kind:TopKind)=>kind==='frame'?base:xy[id].baseZ+(kind==='route'?routeHeight:0);
  const adjacency=new Map<string,Array<{a:number;b:number;kind:TopKind}>>();
  const levels=new Map<number,Set<number>>();
  const routeVertices=new Set<number>();let routeArea=0,terrainArea=0;
  for(const triangle of noded) {
    const [a,b,c]=triangle.ids,kind=triangle.kind;
    for(const id of triangle.ids) {
      const values=levels.get(id)??new Set<number>([0]);values.add(heightFor(id,kind));
      // A route-only boundary vertex still needs the bare DEM elevation so
      // exterior/frame walls can share a material seam below the relief.
      if(kind==='route')values.add(xy[id].baseZ);
      if(snow&&kind!=='frame')values.add(xy[id].terrainZ);
      levels.set(id,values);
    }
    const emittedKind:Kind=snow&&kind==='terrain'&&triangle.ids.some(id=>xy[id].baseZ-xy[id].terrainZ>1e-8)?'snow':kind;
    face(vertex(a,heightFor(a,kind)),vertex(b,heightFor(b,kind)),vertex(c,heightFor(c,kind)),emittedKind);
    face(vertex(a,0),vertex(c,0),vertex(b,0),'bottom');
    const area=cross(xy[a],xy[b],xy[c])/2/SCALE/SCALE;
    if(kind==='route'){routeArea+=area;for(const id of triangle.ids)routeVertices.add(id);}else if(kind==='terrain')terrainArea+=area;
    for(const [from,to] of [[a,b],[b,c],[c,a]]){const key=from<to?`${from},${to}`:`${to},${from}`;const list=adjacency.get(key)??[];list.push({a:from,b:to,kind});adjacency.set(key,list);}
  }
  for(const neighbours of adjacency.values()) {
    if(neighbours.length>2)throw new TerrainError('MESH_INVALID','二维分区边界重复或重叠');
    const first=neighbours[0];let high=first,low:typeof first|undefined;
    if(neighbours.length===2) {
      const second=neighbours[1];
      if(first.a!==second.b||first.b!==second.a)throw new TerrainError('MESH_INVALID','二维分区边界朝向不匹配');
      const difference=heightFor(first.a,first.kind)+heightFor(first.b,first.kind)-heightFor(first.a,second.kind)-heightFor(first.b,second.kind);
      if(Math.abs(difference)<1e-8)continue;
      if(difference<0){high=second;low=first;}else low=second;
    }
    const {a,b}=high,ha=heightFor(a,high.kind),hb=heightFor(b,high.kind),la=low?heightFor(a,low.kind):0,lb=low?heightFor(b,low.kind):0;
    const kind:Kind=low&&((high.kind==='route'&&low.kind==='terrain')||(high.kind==='terrain'&&low.kind==='route'))?'route-wall':'wall';
    const wallBand=(la:number,lb:number,ha:number,hb:number,kind:Kind)=> {
      if(ha-la<1e-8&&hb-lb<1e-8)return;
      const levelsA=Array.from(levels.get(a)??[]).filter(z=>z>la+1e-6&&z<ha-1e-6).sort((a,b)=>b-a);
      const levelsB=Array.from(levels.get(b)??[]).filter(z=>z>lb+1e-6&&z<hb-1e-6).sort((a,b)=>a-b);
      if(!levelsA.length&&!levelsB.length) {
        face(vertex(a,la),vertex(b,lb),vertex(b,hb),kind);face(vertex(a,la),vertex(b,hb),vertex(a,ha),kind);
      } else {
        const ring=[vertex(a,la),vertex(b,lb),...levelsB.map(z=>vertex(b,z)),vertex(b,hb),vertex(a,ha),...levelsA.map(z=>vertex(a,z))];
        const cleaned=ring.filter((v,i)=>v!==ring[(i+ring.length-1)%ring.length]);
        const centerXY=xyVertex({X:(xy[a].X+xy[b].X)/2,Y:(xy[a].Y+xy[b].Y)/2},base);
        const center=vertex(centerXY,(la+lb+ha+hb)/4);
        for(let i=0;i<cleaned.length;i++)face(center,cleaned[i],cleaned[(i+1)%cleaned.length],kind);
      }
    };
    if(high.kind==='route'&&(!low||low.kind==='frame')) {
      // Split the visible wall at the original terrain plane, not at the
      // ledge/base height. Only the raised route strip receives route color.
      if(snow){wallBand(la,lb,xy[a].terrainZ,xy[b].terrainZ,'wall');wallBand(xy[a].terrainZ,xy[b].terrainZ,xy[a].baseZ,xy[b].baseZ,'snow-wall');}
      else wallBand(la,lb,xy[a].baseZ,xy[b].baseZ,'wall');
      wallBand(xy[a].baseZ,xy[b].baseZ,ha,hb,'route-wall');
    } else if(snow&&high.kind==='terrain'&&(!low||low.kind==='frame')) {
      wallBand(la,lb,xy[a].terrainZ,xy[b].terrainZ,'wall');wallBand(xy[a].terrainZ,xy[b].terrainZ,ha,hb,'snow-wall');
    } else {
      wallBand(la,lb,ha,hb,kind);
    }
  }
  const corridorPerimeter=corridor.paths.reduce((sum,path)=>sum+path.reduce((s,p,i)=>{const q=path[(i+1)%path.length];return s+Math.hypot(q.X-p.X,q.Y-p.Y)/SCALE;},0),0);
  const areaTolerance=Math.max(1e-5,corridorPerimeter/SCALE*4);
  if(Math.abs(routeArea-corridor.areaMm2)>areaTolerance)throw new TerrainError('MESH_AREA_MISMATCH',`路线分区面积与走廊并集不一致（${routeArea} / ${corridor.areaMm2} mm²）`);
  const mesh:TerrainMeshPayload={positions,indices:meshIndices,faceKinds,minSurfaceZ:base,bottomZ:0,gridCols:source.gridCols,gridRows:source.gridRows};
  const surfaceCheck=checkIntegratedSurfaceHeights(source,snow?{...mesh,faceKinds:faceKinds.map(kind=>kind==='snow'?'terrain':kind)}:mesh,routeHeight);
  if(snow) {
    mesh.materialParts=buildMaterialParts(xy.map(p=>({x:p.X/SCALE,y:p.Y/SCALE,terrainZ:p.terrainZ,surfaceZ:p.baseZ})),noded,routeHeight,base,input.signal);
    let snowArea=0,snowVolume=0;
    for(const triangle of noded)if(triangle.kind!=='frame'&&triangle.ids.some(id=>xy[id].baseZ-xy[id].terrainZ>1e-8)) {
      const [a,b,c]=triangle.ids,area=cross(xy[a],xy[b],xy[c])/2/SCALE/SCALE;
      snowArea+=area;snowVolume+=area*triangle.ids.reduce((sum,id)=>sum+xy[id].baseZ-xy[id].terrainZ,0)/3;
    }
    snow.report.areaMm2=snowArea;snow.report.actualCoveragePercent=snowArea/(terrainArea+routeArea)*100;snow.report.volumeMm3=snowVolume;
  }
  return {mesh,report:{algorithm:'source-triangle-partition-with-shared-boundary-noding',coordinateToleranceMm:1/SCALE,affectedSourceTriangles,
    surfaceCheck,route:{heightMm:routeHeight,widthMm:routeWidth,areaMm2:routeArea,corridorAreaMm2:corridor.areaMm2,areaErrorMm2:Math.abs(routeArea-corridor.areaMm2),areaToleranceMm2:areaTolerance,topVertexCount:routeVertices.size,maxHeightErrorMm:surfaceCheck.routeErrorMm,maxStlHeightErrorMm:surfaceCheck.routeStlErrorMm,segmentCount:corridor.effectiveSegmentCount,arcToleranceMm:corridor.arcToleranceMm},
    frame:{widthMm:frameWidth,areaMm2:frameArea,topZMm:base,style:frameWidth?'flat-integral-ledge':'none'},terrainAreaMm2:terrainArea+routeArea,
    expectedAddedVolumeMm3:routeArea*routeHeight+frameArea*base+(snow?.report.volumeMm3??0),snow:snow?.report??(input.snowEnabled?{enabled:true as const,requestedCoveragePercent:snowCoverage,actualCoveragePercent:0,coverageTolerancePercent:0.02,areaMm2:0,volumeMm3:0,maxThicknessMm:snowThickness,actualMaxThicknessMm:0,altitudeThresholdMm:source.minSurfaceZ,transitionElevationMm:0,transitionDistanceMm:0}:undefined),outerPathsMm:outerPaths.map(path=>path.map(p=>({x:p.X/SCALE,y:p.Y/SCALE})))}};
}
