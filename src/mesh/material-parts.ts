import { TerrainError } from '../errors.js';
import { MAX_MESH_TRIANGLES } from '../vendor/trailprint/heightfield-mesh.js';
import type { MaterialPart, TerrainMeshPayload } from '../vendor/trailprint/types.js';

type Kind=NonNullable<TerrainMeshPayload['faceKinds']>[number];
export interface MaterialSurfaceVertex {x:number;y:number;terrainZ:number;surfaceZ:number}
export interface MaterialSurfaceTriangle {ids:[number,number,number];kind:'terrain'|'route'|'frame'}

/** Each material owns an interval of Z; interfaces share the identical planar tessellation. */
export function buildMaterialParts(points:MaterialSurfaceVertex[],triangles:MaterialSurfaceTriangle[],routeHeight:number,base:number,signal?:AbortSignal):MaterialPart[] {
  const parts:MaterialPart[]=[];let budget=0;
  function solid(id:MaterialPart['id'],faces:MaterialSurfaceTriangle[],lower:(v:number,t:MaterialSurfaceTriangle)=>number,upper:(v:number,t:MaterialSurfaceTriangle)=>number) {
    if(!faces.length)return;
    const positions:number[]=[],indices:number[]=[],faceKinds:Kind[]=[],map=new Map<string,number>();
    const adjacency=new Map<string,Array<{a:number;b:number;t:MaterialSurfaceTriangle}>>(),levels=new Map<number,Set<number>>();
    const vertex=(xy:number,z:number)=>{const key=`${xy},${Math.round(z*1e6)}`;let found=map.get(key);if(found!==undefined)return found;found=positions.length/3;positions.push(points[xy].x,points[xy].y,z);map.set(key,found);return found;};
    const face=(a:number,b:number,c:number,kind:Kind)=>{if(a===b||a===c||b===c)return;indices.push(a,b,c);faceKinds.push(kind);if(++budget>MAX_MESH_TRIANGLES*3)throw new TerrainError('MESH_TOO_COMPLEX','实体材料网格超过三角面预算，请降低采样');};
    const topKind=(t:MaterialSurfaceTriangle):Kind=>id==='terrain'?(t.kind==='frame'?'frame':'terrain'):id;
    const wallKind:Kind=id==='terrain'?'wall':id==='snow'?'snow-wall':'route-wall';
    for(const [i,t] of faces.entries()) {
      if(i%256===0)signal?.throwIfAborted();const [a,b,c]=t.ids;
      face(vertex(a,upper(a,t)),vertex(b,upper(b,t)),vertex(c,upper(c,t)),topKind(t));
      face(vertex(a,lower(a,t)),vertex(c,lower(c,t)),vertex(b,lower(b,t)),id==='terrain'?'bottom':id);
      for(const v of t.ids){const set=levels.get(v)??new Set<number>();set.add(lower(v,t));set.add(upper(v,t));levels.set(v,set);}
      for(const [a,b] of [[t.ids[0],t.ids[1]],[t.ids[1],t.ids[2]],[t.ids[2],t.ids[0]]]){const key=a<b?`${a},${b}`:`${b},${a}`,values=adjacency.get(key)??[];values.push({a,b,t});adjacency.set(key,values);}
    }
    function wall(a:number,b:number,la:number,lb:number,ha:number,hb:number) {
      if(ha-la<1e-8&&hb-lb<1e-8)return;
      const internalA=Array.from(levels.get(a)??[]).filter(z=>z>la+1e-6&&z<ha-1e-6).sort((a,b)=>b-a);
      const internalB=Array.from(levels.get(b)??[]).filter(z=>z>lb+1e-6&&z<hb-1e-6).sort((a,b)=>a-b);
      if(!internalA.length&&!internalB.length){face(vertex(a,la),vertex(b,lb),vertex(b,hb),wallKind);face(vertex(a,la),vertex(b,hb),vertex(a,ha),wallKind);return;}
      const ring=[vertex(a,la),vertex(b,lb),...internalB.map(z=>vertex(b,z)),vertex(b,hb),vertex(a,ha),...internalA.map(z=>vertex(a,z))].filter((v,i,ring)=>v!==ring[(i+ring.length-1)%ring.length]);
      const index=positions.length/3;positions.push((points[a].x+points[b].x)/2,(points[a].y+points[b].y)/2,(la+lb+ha+hb)/4);
      for(let i=0;i<ring.length;i++)face(index,ring[i],ring[(i+1)%ring.length],wallKind);
    }
    for(const values of adjacency.values()) {
      if(values.length>2)throw new TerrainError('MESH_INVALID','实体材料二维分区重叠');
      const first=values[0];if(values.length===1){wall(first.a,first.b,lower(first.a,first.t),lower(first.b,first.t),upper(first.a,first.t),upper(first.b,first.t));continue;}
      const second=values[1];if(first.a!==second.b||first.b!==second.a)throw new TerrainError('MESH_INVALID','实体材料边界朝向不匹配');
      const difference=upper(first.a,first.t)+upper(first.b,first.t)-upper(first.a,second.t)-upper(first.b,second.t);
      if(Math.abs(difference)>1e-8){const high=difference>0?first:second,low=difference>0?second:first;wall(high.a,high.b,upper(high.a,low.t),upper(high.b,low.t),upper(high.a,high.t),upper(high.b,high.t));}
    }
    parts.push({id,positions,indices,faceKinds});
  }
  solid('terrain',triangles,()=>0,(v,t)=>t.kind==='frame'?base:points[v].terrainZ);
  solid('snow',triangles.filter(t=>t.kind!=='frame'&&t.ids.some(v=>points[v].surfaceZ-points[v].terrainZ>1e-8)),v=>points[v].terrainZ,v=>points[v].surfaceZ);
  solid('route',triangles.filter(t=>t.kind==='route'),v=>points[v].surfaceZ,v=>points[v].surfaceZ+routeHeight);
  return parts;
}
