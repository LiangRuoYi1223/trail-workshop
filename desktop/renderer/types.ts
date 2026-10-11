export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface XY { x: number; y: number }
export interface GeoPoint { lat: number; lon: number }
export interface ModelOptions {
  shape: 'rectangle' | 'circle' | 'polygon'; widthMm: number; heightMm: number; polygonSides: number;
  cornerRadiusMm: number; bearingDeg: number; paddingFraction: number; baseThicknessMm: number;
  zExaggeration: number; gridColumns: number; smoothing: 'raw' | 'light' | 'medium' | 'heavy';
  routeWidthMm: number; routeHeightMm: number; routeColor: string; frameWidthMm: number;
  maxColors:2|3; grassColor:string; rockColor:string;
  center?: GeoPoint; groundWidthM?: number;
}
export interface RouteInfo {
  id: string; fileName: string; name: string; pointCount: number; segmentCount: number;
  distanceKm: number; invalidPointCount: number; segments: GeoPoint[][]; isSample: boolean;
}
export interface DemInfo { id: string; fileName: string; bytes: number; isSample: boolean; dataset?: string }
export interface ImageInfo { id:string; fileName:string; bytes:number; width:number; height:number; crs:string }
export type ImageMode = 'none' | 'auto' | 'local';
export interface SurfaceImageSource {
  provider: 'Sentinel-2'; collection: 'sentinel-2-c1-l2a';
  scenes: Array<{ id: string; datetime: string; cloudCover: number }>;
  cacheHit: boolean; retrievedAt: string; attribution?: string;
  bounds: { west: number; south: number; east: number; north: number };
}
export interface AppearanceOptions { maxColors:2|3; grassColor:string; rockColor:string; routeColor:string }
export interface ModelAppearance {
  schemaVersion:1; faceClasses:Array<'grass'|'rock'|'route'>; faceMaterials:number[];
  palette:Array<{id:'grass'|'rock'|'route';name:string;color:string}>; options:AppearanceOptions;
  classification:'rgb-greenness'|'uniform'; hash:string; source?:Record<string,unknown>;
}
export interface Inspection {
  selection: { center: GeoPoint; groundWidthM: number; groundHeightM: number; bearingDeg: number };
  routeSegmentsMm: XY[][]; outlineMm: XY[];
  outlineGeo: GeoPoint[];
  controlVerticesMm: XY[]; controlVerticesGeo: GeoPoint[];
  bounds: { west: number; south: number; east: number; north: number };
}
export interface PhaseProgress {
  state: 'running' | 'complete'; progress: number; message: string;
  stage?: 'query' | 'download' | 'cloud' | 'complete';
  downloadedBytes?: number; cacheBytes?: number; requestCount?: number; coverage?: number;
}
export interface Job {
  id: string; state: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  progress: number; message: string; createdAt: string; routeName: string; options: ModelOptions;
  imageMode?: ImageMode; imageLookbackMonths?: 12 | 24;
  phase?: 'prepare' | 'acquire' | 'model' | 'verify';
  acquisition?: { image?: PhaseProgress; dem?: PhaseProgress };
  result?: { dimensions: { x: number; y: number; z: number }; triangleCount: number; downloadName: string; stlSha256: string; demSource?: { provider: string; dataset?: string; cacheHit?: boolean; tileCount?: number }; imageSource?: SurfaceImageSource };
  error?: { code: string; message: string };
}
export interface Preview {
  mesh: { positions: number[]; indices: number[]; faceKinds?: string[] };
  report: Record<string, unknown> & { imageSource?: SurfaceImageSource };
  appearance?:ModelAppearance;
}
export interface RuntimeInfo { version: string; electron: string; node: string; platform: string; packaged: boolean; units: 'mm' }
export interface CacheInfo { path: string; elevationBytes: number; mapBytes: number; imageBytes?: number }
export interface SessionPreferences { options: ModelOptions; demMode: 'auto' | 'local'; imageMode?: ImageMode; imageLookbackMonths?: 12 | 24; offlineOnly: boolean }
export interface SessionInfo {
  schemaVersion: 1; preferences: SessionPreferences; warnings: string[];
  recentProject?: { routeName: string; routeFileName: string; demFileName?: string; imageFileName?:string; imageMode?: ImageMode; imageLookbackMonths?: 12 | 24; savedAt: string };
}
export interface RestoredSession extends SessionPreferences { route?: RouteInfo; dem?: DemInfo; image?:ImageInfo; warnings: string[] }
export interface TerrainApi {
  getRuntime(): Promise<Result<RuntimeInfo>>;
  chooseRoute(): Promise<Result<RouteInfo | null>>;
  chooseDem(): Promise<Result<DemInfo | null>>;
  chooseImage(): Promise<Result<ImageInfo|null>>;
  removeImage(id:string):Promise<Result<unknown>>;
  importRouteFile(file: File): Promise<Result<RouteInfo>>;
  importDemFile(file: File): Promise<Result<DemInfo>>;
  importImageFile(file:File):Promise<Result<ImageInfo>>;
  inspect(request: { routeId: string; options: ModelOptions }): Promise<Result<Inspection>>;
  startJob(request: { routeId: string; demId?: string; imageId?:string; demMode: 'auto' | 'local'; imageMode: ImageMode; imageLookbackMonths?: 12 | 24; offlineOnly?: boolean; options: ModelOptions }): Promise<Result<Job>>;
  getCacheInfo(): Promise<Result<CacheInfo>>;
  clearCache(): Promise<Result<{ cleared: true }>>;
  getSession(): Promise<Result<SessionInfo>>;
  saveSession(request: { routeId?: string; demId?: string; imageId?:string; demMode: 'auto' | 'local'; imageMode: ImageMode; imageLookbackMonths?: 12 | 24; offlineOnly: boolean; options: ModelOptions }): Promise<Result<SessionInfo>>;
  restoreSession(): Promise<Result<RestoredSession>>;
  cancelJob(id: string): Promise<Result<Job>>;
  getJob(id: string): Promise<Result<Job>>;
  getPreview(id: string): Promise<Result<Preview>>;
  saveStl(id: string): Promise<Result<{ cancelled: boolean; path?: string; bytes?: number; sha256?: string }>>;
  saveModel(request:{id:string;format:'3mf'|'obj'|'stl';options:AppearanceOptions}):Promise<Result<{cancelled:boolean;path?:string;bytes?:number;sha256?:string;appearanceHash?:string}>>;
  onJob(callback: (job: Job) => void): () => void;
}
