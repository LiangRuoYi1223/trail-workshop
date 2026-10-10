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
  faceKinds?: Array<'terrain'|'route'|'route-wall'|'frame'|'wall'|'bottom'>;
}
export interface TerrainHeightPreview {
  cols: number; rows: number; heights: Float64Array | number[];
  minSurfaceZ: number; bottomZ: number; baseThicknessMm: number;
}
