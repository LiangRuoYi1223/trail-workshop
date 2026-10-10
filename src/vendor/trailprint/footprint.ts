// Adapted from TrailPrint-3D f8909ba; MIT (c) 2026 baozj. See THIRD_PARTY_NOTICES.md.
import type { TerrainCropRegion } from './types.js';
import { roundedRectanglePolygon, roundedRegularPolygon } from './rounded-footprint.js';
export function regularPolygonVertexAngleRad(index: number, sides: number): number {
  return index / sides * Math.PI * 2 - Math.PI / 2 + Math.PI / sides;
}
export function regularPolygonCircumradiusMm(sideLengthMm: number, sides: number): number {
  return sideLengthMm / (2 * Math.sin(Math.PI / Math.max(3, sides)));
}
export function buildFootprintPolygonMm(crop: TerrainCropRegion): Array<{x:number;y:number}> | null {
  if (crop.shape === 'rectangle') return roundedRectanglePolygon(crop.widthMm/2, crop.heightMm/2, crop.cornerRadiusMm ?? 0);
  if (crop.shape === 'polygon') return roundedRegularPolygon(crop.polygonSides ?? 6, crop.radiusMm ?? crop.widthMm/2, crop.cornerRadiusMm ?? 0);
  return null;
}
