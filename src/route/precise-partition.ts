import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping';
import { SCALE, type PolygonRegion } from './corridor.js';

/** Keep rational shared intersections as doubles; rounding each triangle's cuts creates slivers. */
export function precisePartition(subject:PolygonRegion[],clip:PolygonRegion[],operation:'intersection'|'difference'):PolygonRegion[] {
  // Operate in model millimetres, rather than large lattice coordinates. This
  // avoids artificial near-collinearity failures on the source's tiny edge faces.
  const geometry=(regions:PolygonRegion[]):MultiPolygon=>regions.map(r=>[r.outer,...r.holes].map(path=>path.map(p=>[p.X/SCALE,p.Y/SCALE] as [number,number])));
  if(!subject.length)return [];
  if(!clip.length)return operation==='intersection'?[]:subject;
  const result=polygonClipping[operation](geometry(subject),geometry(clip));
  const points=(ring:Ring)=>ring.slice(0,-1).map(([X,Y])=>({X:X*SCALE,Y:Y*SCALE}));
  return result.map(p=>({outer:points(p[0]),holes:p.slice(1).map(points)}));
}
