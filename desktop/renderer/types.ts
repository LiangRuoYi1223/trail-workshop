export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface XY { x: number; y: number }
export interface GeoPoint { lat: number; lon: number }
export interface ModelOptions {
  shape: 'rectangle' | 'circle' | 'polygon'; widthMm: number; heightMm: number; polygonSides: number;
  cornerRadiusMm: number; bearingDeg: number; paddingFraction: number; baseThicknessMm: number;
  zExaggeration: number; gridColumns: number; smoothing: 'raw' | 'light' | 'medium' | 'heavy';
  routeWidthMm: number; routeHeightMm: number; routeColor: string; frameWidthMm: number;
  center?: GeoPoint; groundWidthM?: number;
}
export interface RouteInfo {
  id: string; fileName: string; name: string; pointCount: number; segmentCount: number;
  distanceKm: number; invalidPointCount: number; segments: GeoPoint[][]; isSample: boolean;
}
export interface DemInfo { id: string; fileName: string; bytes: number; isSample: boolean; dataset?: string }
export interface Inspection {
  selection: { center: GeoPoint; groundWidthM: number; groundHeightM: number; bearingDeg: number };
  routeSegmentsMm: XY[][]; outlineMm: XY[];
  outlineGeo: GeoPoint[];
  controlVerticesMm: XY[]; controlVerticesGeo: GeoPoint[];
  bounds: { west: number; south: number; east: number; north: number };
}
export interface Job {
  id: string; state: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  progress: number; message: string; createdAt: string; routeName: string; options: ModelOptions;
  result?: { dimensions: { x: number; y: number; z: number }; triangleCount: number; downloadName: string; stlSha256: string; demSource?: { provider: string; dataset?: string; cacheHit?: boolean; tileCount?: number } };
  error?: { code: string; message: string };
}
export interface Preview {
  mesh: { positions: number[]; indices: number[]; faceKinds?: string[] };
  report: Record<string, unknown>;
}
export interface RuntimeInfo { version: string; electron: string; node: string; platform: string; packaged: boolean; units: 'mm' }
export interface CacheInfo { path: string; elevationBytes: number; mapBytes: number }
export interface SessionPreferences { options: ModelOptions; demMode: 'auto' | 'local'; offlineOnly: boolean }
export interface SessionInfo {
  schemaVersion: 1; preferences: SessionPreferences; warnings: string[];
  recentProject?: { routeName: string; routeFileName: string; demFileName?: string; savedAt: string };
}
export interface RestoredSession extends SessionPreferences { route?: RouteInfo; dem?: DemInfo; warnings: string[] }
export interface TerrainApi {
  getRuntime(): Promise<Result<RuntimeInfo>>;
  loadSample(): Promise<Result<{ route: RouteInfo; dem: DemInfo }>>;
  chooseRoute(): Promise<Result<RouteInfo | null>>;
  chooseDem(): Promise<Result<DemInfo | null>>;
  importRouteFile(file: File): Promise<Result<RouteInfo>>;
  importDemFile(file: File): Promise<Result<DemInfo>>;
  inspect(request: { routeId: string; options: ModelOptions }): Promise<Result<Inspection>>;
  startJob(request: { routeId: string; demId?: string; demMode: 'auto' | 'local'; offlineOnly?: boolean; options: ModelOptions }): Promise<Result<Job>>;
  getCacheInfo(): Promise<Result<CacheInfo>>;
  clearCache(): Promise<Result<{ cleared: true }>>;
  getSession(): Promise<Result<SessionInfo>>;
  saveSession(request: { routeId?: string; demId?: string; demMode: 'auto' | 'local'; offlineOnly: boolean; options: ModelOptions }): Promise<Result<SessionInfo>>;
  restoreSession(): Promise<Result<RestoredSession>>;
  cancelJob(id: string): Promise<Result<Job>>;
  getJob(id: string): Promise<Result<Job>>;
  getPreview(id: string): Promise<Result<Preview>>;
  saveStl(id: string): Promise<Result<{ cancelled: boolean; path?: string; bytes?: number; sha256?: string }>>;
  onJob(callback: (job: Job) => void): () => void;
}
