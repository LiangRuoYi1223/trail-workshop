import type { GeoPoint, Inspection, ModelOptions, XY } from './types.js';
const R = 6378137, RAD = Math.PI / 180;
const project = (point: GeoPoint): XY => ({ x: R * point.lon * RAD, y: R * Math.log(Math.tan(Math.PI / 4 + point.lat * RAD / 2)) });
const unproject = (point: XY): GeoPoint => ({ lon: point.x / R / RAD, lat: (2 * Math.atan(Math.exp(point.y / R)) - Math.PI / 2) / RAD });
export function geoToSelectionMm(point: GeoPoint, selection: Inspection['selection'], widthMm: number): XY {
  const origin = project(selection.center), p = project(point), scale = Math.cos(selection.center.lat * RAD) * widthMm / selection.groundWidthM;
  const a = selection.bearingDeg * RAD, x = (p.x - origin.x) * scale, y = (p.y - origin.y) * scale;
  return { x: Math.cos(a) * x - Math.sin(a) * y, y: Math.sin(a) * x + Math.cos(a) * y };
}
export function selectionMmToGeo(point: XY, selection: Inspection['selection'], widthMm: number): GeoPoint {
  const origin = project(selection.center), scale = selection.groundWidthM / widthMm / Math.cos(selection.center.lat * RAD), a = selection.bearingDeg * RAD;
  return unproject({ x: origin.x + (Math.cos(a) * point.x + Math.sin(a) * point.y) * scale,
    y: origin.y + (-Math.sin(a) * point.x + Math.cos(a) * point.y) * scale });
}
export function optionsFromVertex(point: XY, vertex: XY, selection: Inspection['selection'], options: ModelOptions): ModelOptions {
  const ratio = Math.hypot(point.x,point.y) / Math.hypot(vertex.x,vertex.y);
  const groundWidthM = selection.groundWidthM * ratio, groundHeightM = selection.groundHeightM * ratio;
  if (!Number.isFinite(ratio) || Math.min(groundWidthM,groundHeightM)<1 || Math.max(groundWidthM,groundHeightM)>100000)
    throw new Error('取景尺寸须在 1 m–100 km 内，请缩小顶点调整幅度。');
  return { ...options, center:selection.center, groundWidthM, bearingDeg:selection.bearingDeg };
}
export function rotationBearing(startBearing: number, startAngle: number, angle: number): number {
  const delta = Math.atan2(Math.sin(angle-startAngle),Math.cos(angle-startAngle))/RAD;
  return ((startBearing+delta+180)%360+360)%360-180;
}
