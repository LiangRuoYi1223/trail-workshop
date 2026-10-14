import type { BaseTextPreview, BaseTextPreviewGeometry, GeoPoint, ModelOptions, TextContour, XY } from './types.js';

export function clampTextEdgeIndex(index:number|undefined, sides:number):number {
  return Math.max(0, Math.min(sides - 1, Number.isInteger(index) ? index! : 0));
}

export function validateTextPlacement(options:Pick<ModelOptions,'shape'|'polygonSides'|'baseTextAngleDeg'|'baseTextEdgeIndex'>):string {
  const angle = options.baseTextAngleDeg ?? 180, edge = options.baseTextEdgeIndex ?? 0;
  if (!Number.isFinite(angle) || angle < 0 || angle > 360) return '文字周向角度需在 0–360° 之间。';
  if (!Number.isInteger(edge) || edge < 0 || edge > 7) return '文字所在边需为 0–7 的整数。';
  if (options.shape === 'polygon' && edge >= options.polygonSides) return `请选择第 1–${options.polygonSides} 边放置文字。`;
  return '';
}

export function hasTextPreviewGeometry(preview:BaseTextPreview|undefined):preview is BaseTextPreviewGeometry {
  return !!preview && !preview.error && 'contoursMm' in preview;
}

export function contourSvgPath(contour:TextContour<XY>):string {
  return [contour.outer, ...contour.holes].filter(ring=>ring.length).map(ring=>
    `M${ring.map(point=>`${point.x},${-point.y}`).join('L')}Z`).join('');
}

export function textPreviewPoints(preview:BaseTextPreview|undefined):GeoPoint[] {
  if (!hasTextPreviewGeometry(preview)) return [];
  return [...preview.outlineGeo, ...preview.contoursGeo.flatMap(contour=>[...contour.outer,...contour.holes.flat()])];
}

export function textAngleFromPoint(point:XY):number {
  return (Math.atan2(point.x,point.y)*180/Math.PI+360)%360;
}

export function rotateTextPoint(point:XY, clockwiseDeg:number):XY {
  const angle=clockwiseDeg*Math.PI/180, cos=Math.cos(angle), sin=Math.sin(angle);
  return {x:cos*point.x+sin*point.y,y:-sin*point.x+cos*point.y};
}
