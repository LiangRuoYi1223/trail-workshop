import type { BaseShape, TerrainSmoothing, TerrainMeshPayload } from './vendor/trailprint/types.js';
export interface GeoPoint { lat: number; lon: number }
export interface Bounds { west: number; south: number; east: number; north: number }
export interface TerrainOptions {
  shape?: BaseShape; widthMm?: number; heightMm?: number; polygonSides?: number;
  cornerRadiusMm?: number; bearingDeg?: number; paddingFraction?: number;
  center?: GeoPoint; groundWidthM?: number;
  baseThicknessMm?: number; zExaggeration?: number; gridColumns?: number;
  smoothing?: TerrainSmoothing; maxMissingFraction?: number;
}
export interface DemSampler {
  sample(lat: number, lon: number): number | null;
  metadata: object;
}
export interface PrintableTerrainOptions extends TerrainOptions {
  routeWidthMm?: number; routeHeightMm?: number; frameWidthMm?: number;
  snowEnabled?: boolean; snowCoveragePercent?: number; snowMaxThicknessMm?: number;
}
export interface GenerationProgress { phase: 'gpx'|'frame'|'dem'|'process'|'mesh'|'route'|'done'; progress: number; message: string }
export interface GenerationResult {
  mesh: TerrainMeshPayload;
  heightfield: { cols: number; rows: number; heightsMm: Float64Array; minimumElevationM: number; maximumElevationM: number };
  routeSegmentsMm: Array<Array<{x:number;y:number}>>;
  report: Record<string, unknown>;
}
