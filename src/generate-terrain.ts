import { performance } from 'node:perf_hooks';
import { parseGpxXml } from './gpx/parse-gpx.js';
import { createTerrainFrame } from './geo/frame.js';
import { TerrainError } from './errors.js';
import { buildHeightfieldTerrainMesh, estimateTriangleCount, MAX_MESH_TRIANGLES } from './vendor/trailprint/heightfield-mesh.js';
import { fillDemHoles, applyTerrainSmoothing } from './vendor/trailprint/smoothing.js';
import { createTerrainSampleDomain, fillRequiredDemHoles, sampleDomainSurface } from './geo/sample-domain.js';
import { assertPrintableMesh } from './mesh/validate.js';
import type { DemSampler, TerrainOptions, GenerationProgress, GenerationResult } from './types.js';

export interface GenerateTerrainRequest {
  gpxXml: string; fileName?: string; options?: TerrainOptions;
  loadDem: (bounds: {west:number;south:number;east:number;north:number}, context: {signal?: AbortSignal}) => Promise<DemSampler>;
  onProgress?: (progress: GenerationProgress) => void;
  signal?: AbortSignal;
}
export async function generateTerrain(request: GenerateTerrainRequest): Promise<GenerationResult> {
  const started=performance.now(),options=request.options ?? {};
  const progress=(phase:GenerationProgress['phase'],value:number,message:string)=>{
    request.signal?.throwIfAborted(); request.onProgress?.({phase,progress:value,message});
  };
  progress('gpx',0,'解析 GPX');
  const route=parseGpxXml(request.gpxXml,{fileName:request.fileName});
  if(!route.segments.some(s=>s.points.length>=2))throw new TerrainError('GPX_TOO_SHORT','轨迹需要至少一个含两个有效点的连续段');
  if(route.crossesAntimeridian)throw new TerrainError('GEO_UNSUPPORTED','阶段 1 暂不支持跨日期变更线的路线');
  progress('frame',0.1,'确定独立于下载范围的模型尺度');
  const frame=createTerrainFrame(route.segments.flatMap(s=>s.points),options);
  const gridSize=options.gridColumns ?? 129;
  const base=options.baseThicknessMm ?? 2,zExaggeration=options.zExaggeration ?? 2;
  const smoothing=options.smoothing ?? 'raw',maxMissing=options.maxMissingFraction ?? 0.01;
  if(!Number.isInteger(gridSize)||gridSize<17||gridSize>513)throw new TerrainError('CONFIG_INVALID','采样网格最长方向点数须为 17–513 的整数');
  if(!Number.isFinite(base)||base<0.5||base>30)throw new TerrainError('CONFIG_INVALID','基础底厚须为 0.5–30 mm');
  if(!Number.isFinite(zExaggeration)||zExaggeration<=0||zExaggeration>20)throw new TerrainError('CONFIG_INVALID','地形垂直夸张须大于 0 且不超过 20');
  if(!['raw','light','medium','heavy'].includes(smoothing))throw new TerrainError('CONFIG_INVALID','无效的平滑级别');
  if(!Number.isFinite(maxMissing)||maxMissing<0||maxMissing>0.05)throw new TerrainError('CONFIG_INVALID','缺值容许比例须在 0–5% 之间');
  const longest=Math.max(frame.crop.widthMm,frame.crop.heightMm);
  const cols=Math.max(3,Math.round((gridSize-1)*frame.crop.widthMm/longest)+1);
  const rows=Math.max(3,Math.round((gridSize-1)*frame.crop.heightMm/longest)+1);
  if(estimateTriangleCount(frame.crop,cols,rows)>MAX_MESH_TRIANGLES)
    throw new TerrainError('MESH_TOO_COMPLEX','模型网格超过阶段 1 的三角面预算，请减少采样网格点数');
  // The plain rectangle keeps the existing arithmetic and topology. Other
  // shapes need a real surface template, not an inside-grid-point shortcut.
  const plainRectangle=frame.crop.shape==='rectangle' && (frame.crop.cornerRadiusMm ?? 0)<=1e-6;
  const domain=plainRectangle?undefined:createTerrainSampleDomain(frame.crop,cols,rows,smoothing);
  const required=domain?.required ?? new Uint8Array(cols*rows).fill(1);
  const requiredCount=domain?.requiredCount ?? cols*rows;
  progress('dem',0.2,'读取 GeoTIFF 高程');
  const dem=await request.loadDem(frame.bounds,{signal:request.signal});
  request.signal?.throwIfAborted();
  const elevations=new Float64Array(cols*rows);
  elevations.fill(NaN);
  let missing=0;
  for(let row=0;row<rows;row++) {
    request.signal?.throwIfAborted();
    for(let col=0;col<cols;col++) {
      if(!required[row*cols+col])continue;
      const x=(col/(cols-1)-0.5)*frame.crop.widthMm,y=(row/(rows-1)-0.5)*frame.crop.heightMm;
      const geo=frame.mmToGeo(x,y),value=dem.sample(geo.lat,geo.lon);
      if(value===null||!Number.isFinite(value)){elevations[row*cols+col]=NaN;missing++;}
      else elevations[row*cols+col]=value;
    }
  }
  if(missing===requiredCount||missing/requiredCount>maxMissing)
    throw new TerrainError('DEM_COVERAGE_MISSING',`成品所需采样有 ${(missing/requiredCount*100).toFixed(2)}% 高程缺失，超过允许值；请检查 DEM 覆盖范围或缩小取景`);
  progress('process',0.55,'处理少量缺值并转换毫米高度');
  if(missing) {
    if(domain)fillRequiredDemHoles(elevations,required,cols,rows);
    else fillDemHoles(elevations,cols,rows);
  }
  const processed=applyTerrainSmoothing(elevations,cols,rows,smoothing);
  const surfaceElevations=domain?sampleDomainSurface(domain,processed):processed;
  let min=Infinity,max=-Infinity;
  for(const value of surfaceElevations){min=Math.min(min,value);max=Math.max(max,value);}
  const scale=frame.mmPerMeter*zExaggeration;
  const heightsMm=Float64Array.from(processed,value=>plainRectangle
    ?(value-min)*frame.mmPerMeter*zExaggeration
    :(value-min)*scale);
  const surfaceRelief=(max-min)*scale;
  if(!Number.isFinite(surfaceRelief)||surfaceRelief+base>500)throw new TerrainError('MODEL_TOO_HIGH','模型高度超过 500 mm，请降低垂直夸张；程序不会静默压缩高度');
  progress('mesh',0.75,'构造无槽闭合山体');
  const mesh=domain?.template ?? buildHeightfieldTerrainMesh(frame.crop,heightsMm,cols,rows,base);
  if(domain) {
    for(let i=2;i<mesh.positions.length;i+=3)mesh.positions[i]=0;
    for(let index=0;index<domain.surfaceSamples.length;index++)
      mesh.positions[domain.surfaceSamples[index].vertexIndex*3+2]=base+(surfaceElevations[index]-min)*scale;
    mesh.minSurfaceZ=base;
  } else {
    for(let i=2;i<mesh.positions.length;i+=3)mesh.positions[i]+=base;
    mesh.minSurfaceZ+=base;
  }
  mesh.bottomZ=0;
  let minimumSurfaceZ=Infinity,maximumSurfaceZ=-Infinity;
  for(let i=2;i<mesh.positions.length;i+=3) {
    const z=mesh.positions[i];
    if(z>0){minimumSurfaceZ=Math.min(minimumSurfaceZ,z);maximumSurfaceZ=Math.max(maximumSurfaceZ,z);}
  }
  // Record the geometry actually emitted, including tiny interpolation roundoff.
  if(!domain){max=min+(maximumSurfaceZ-base)/scale;min+=(minimumSurfaceZ-base)/scale;}
  mesh.minSurfaceZ=minimumSurfaceZ;
  const relief=maximumSurfaceZ-minimumSurfaceZ;
  const validation=assertPrintableMesh(mesh);
  const routeSegmentsMm=route.segments.map(s=>s.points.map(p=>frame.geoToMm(p)));
  const report={
    schemaVersion:1,stage:1,unit:'mm',modelKind:'closed-terrain-without-route-relief',
    route:{name:route.name,pointCount:route.pointCount,segmentCount:route.segmentCount,distanceKm:route.distanceKm,invalidPointCount:route.invalidPointCount},
    config:{shape:frame.crop.shape,widthMm:frame.crop.widthMm,heightMm:frame.crop.heightMm,cornerRadiusMm:frame.crop.cornerRadiusMm,polygonSides:frame.crop.polygonSides,bearingDeg:frame.crop.bearingDeg,paddingFraction:options.paddingFraction ?? 0.1,baseThicknessMm:base,zExaggeration,smoothing,gridColumns:gridSize,maxMissingFraction:maxMissing},
    selection:{center:{lat:frame.crop.centerLat,lon:frame.crop.centerLon},bearingDeg:frame.crop.bearingDeg,groundWidthM:frame.groundWidthM,groundHeightM:frame.groundHeightM,downloadBounds:frame.bounds,mmPerMeter:frame.mmPerMeter,projection:'Web Mercator with fixed center-latitude compensation; local approximation'},
    dem:dem.metadata,
    elevation:{minimumM:min,maximumM:max,reliefMm:relief,missingSamples:missing,missingFraction:missing/requiredCount,filledSamples:missing,heightCompressionApplied:false,
      sampleDomain:{gridSamples:cols*rows,surfaceSupportSamples:domain?.surfaceSupportCount ?? cols*rows,requiredSamples:requiredCount,smoothingHaloSamples:requiredCount-(domain?.surfaceSupportCount ?? cols*rows),excludedSamples:cols*rows-requiredCount}},
    heightfield:{cols,rows,rowDirection:'south-to-north in model coordinates'},
    validation,generationMs:Math.round(performance.now()-started),
    limitations:['阶段 1 为无槽山体，尚未加入 1 mm 路线浮雕及一体边框','网格拓扑检查不等于实物打印或切片验收'],
  };
  progress('done',1,'地形已生成并通过网格检查');
  return {mesh,heightfield:{cols,rows,heightsMm,minimumElevationM:min,maximumElevationM:max},routeSegmentsMm,report};
}
