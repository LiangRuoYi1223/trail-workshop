export type FaceClass = 'grass' | 'rock' | 'route';
export interface AppearanceOptions {
  maxColors: 2 | 3;
  grassColor: string;
  rockColor: string;
  routeColor: string;
}
export interface PaletteEntry { id: FaceClass; name: string; color: string }
export interface ColorImageMetadata {
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  /** WGS84 geographic bounds, including for a projected input raster. */
  bounds: { west: number; south: number; east: number; north: number };
  crs: 'EPSG:4326' | 'EPSG:3857';
  pixelIsArea: boolean;
  nodata?: number;
}
export interface ColorImage {
  metadata: ColorImageMetadata;
  sample(lat: number, lon: number): { r: number; g: number; b: number } | null;
}
export interface AppearanceMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  faceKinds?: ReadonlyArray<'terrain' | 'route' | 'route-wall' | 'frame' | 'wall' | 'bottom'>;
}
export interface AppearanceSelection {
  center: { lat: number; lon: number };
  bearingDeg: number;
  mmPerMeter: number;
}
export interface ModelAppearance {
  schemaVersion: 1;
  faceClasses: FaceClass[];
  faceMaterials: number[];
  palette: PaletteEntry[];
  options: AppearanceOptions;
  source?: ColorImageMetadata;
  /** RGB appearance classification is not precise land-cover identification. */
  classification: 'rgb-greenness' | 'uniform';
  hash: string;
}
