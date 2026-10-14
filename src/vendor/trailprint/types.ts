export type BaseShape = 'circle' | 'rectangle' | 'polygon';
export type TerrainSmoothing = 'raw' | 'light' | 'medium' | 'heavy';
export interface MapCropConfig {
  shape: BaseShape; lengthMm: number; widthMm: number;
  polygonSides: number; polygonSideLengthMm: number;
}
export interface TerrainCropRegion {
  shape: BaseShape; centerLat: number; centerLon: number; bearingDeg: number;
  minLat: number; maxLat: number; minLon: number; maxLon: number;
  widthMm: number; heightMm: number; radiusMm?: number;
  polygonSides?: number; cornerRadiusMm?: number;
}
export interface TerrainMeshPayload {
  positions: number[]; indices: number[]; minSurfaceZ: number;
  bottomZ: number; gridCols: number; gridRows: number;
  faceKinds?: Array<'terrain'|'route'|'route-wall'|'snow'|'snow-wall'|'frame'|'wall'|'bottom'|'base'|'text'|'text-wall'>;
  materialParts?: MaterialPart[];
}
/** Closed material volumes in the same millimetre coordinate system as the external surface. */
export interface MaterialPart {
  id: 'terrain'|'snow'|'route'|'base'|'text';
  positions: number[];
  indices: number[];
  faceKinds?: TerrainMeshPayload['faceKinds'];
  faceClasses?: Array<'grass'|'rock'|'snow'|'route'|'base'|'text'>;
}
export interface TerrainHeightPreview {
  cols: number; rows: number; heights: Float64Array | number[];
  minSurfaceZ: number; bottomZ: number; baseThicknessMm: number;
}
