import type { Bounds } from '../types.js';
import type { ColorImage } from './types.js';

export interface SentinelSceneSource { id:string; datetime:string; cloudCover:number }
export interface SurfaceImageSource {
  provider:'Sentinel-2'; collection:'sentinel-2-c1-l2a';
  scenes:SentinelSceneSource[]; cacheHit:boolean; retrievedAt:string;
  bounds:Bounds; attribution:string;
}
export interface SentinelImageOptions {
  cacheDir:string; signal?:AbortSignal; offlineOnly?:boolean;
  /** 12 selects the latest June-August season, 24 the latest two; default is 24. */
  lookbackMonths?:12|24;
  onProgress?:(event:{progress:number;message:string;stage?:'query'|'download'|'cloud'|'complete';
    downloadedBytes?:number;cacheBytes?:number;requestCount?:number;catalogRequestCount?:number;rangeRequestCount?:number;
    retryCount?:number;downloadBudgetBytes?:number;reservedBytes?:number;coverage?:number;
    sceneId?:string;sceneDate?:string;sceneContribution?:number;attemptedScenes?:number})=>void;
  /** Transport and clock injection keep HTTP/COG integration tests deterministic. */
  fetch?:typeof globalThis.fetch; now?:()=>Date; timeoutMs?:number;
}
export interface SentinelColorImage { image:ColorImage; source:SurfaceImageSource }
