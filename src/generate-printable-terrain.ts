import { performance } from 'node:perf_hooks';
import { TerrainError } from './errors.js';
import { generateTerrain, type GenerateTerrainRequest } from './generate-terrain.js';
import { buildIntegratedTerrainMesh } from './mesh/integrated-model.js';
import { assertPrintableMesh } from './mesh/validate.js';
import type { PrintableTerrainOptions, GenerationResult } from './types.js';

export interface GeneratePrintableTerrainRequest extends Omit<GenerateTerrainRequest,'options'> {options?:PrintableTerrainOptions}
export async function generatePrintableTerrain(request:GeneratePrintableTerrainRequest):Promise<GenerationResult> {
  const started=performance.now(),options=request.options ?? {};
  const routeWidth=options.routeWidthMm ?? 1,routeHeight=options.routeHeightMm ?? 1,frameWidth=options.frameWidthMm ?? 3;
  if(!Number.isFinite(routeWidth)||routeWidth<0.4||routeWidth>5)throw new TerrainError('CONFIG_INVALID','路线宽度须在 0.4–5 mm 之间');
  if(!Number.isFinite(routeHeight)||routeHeight<0.1||routeHeight>10)throw new TerrainError('CONFIG_INVALID','路线厚度须在 0.1–10 mm 之间');
  if(!Number.isFinite(frameWidth)||frameWidth<0||frameWidth>20)throw new TerrainError('CONFIG_INVALID','一体边框宽度须在 0–20 mm 之间');
  const terrain=await generateTerrain({...request,onProgress:p=>request.onProgress?.({...p,phase:p.phase==='done'?'mesh':p.phase,progress:p.progress*0.7,message:p.phase==='done'?'基础地形检查通过':p.message})});
  request.signal?.throwIfAborted();
  request.onProgress?.({phase:'route',progress:0.72,message:'生成路线并集和一体边框'});
  const integrated=buildIntegratedTerrainMesh({terrainMesh:terrain.mesh,routeSegmentsMm:terrain.routeSegmentsMm,
    routeWidthMm:routeWidth,routeHeightMm:routeHeight,frameWidthMm:frameWidth,baseThicknessMm:options.baseThicknessMm ?? 2,signal:request.signal});
  request.signal?.throwIfAborted();
  request.onProgress?.({phase:'mesh',progress:0.9,message:'检查一体实体、浮雕高度和保存精度'});
  request.signal?.throwIfAborted();
  const validation=assertPrintableMesh(integrated.mesh);
  if(validation.bounds.size.z>500)throw new TerrainError('MODEL_TOO_HIGH','加入路线后的成品高度超过 500 mm，请降低地形垂直夸张后重新生成');
  const sourceVolume=(terrain.report.validation as {volumeMm3:number}).volumeMm3;
  const volumeDifference=validation.volumeMm3-sourceVolume;
  const volumeError=Math.abs(volumeDifference-integrated.report.expectedAddedVolumeMm3);
  // Quantising XY can slightly change the source perimeter and its volume. Keep a measured, explicit bound.
  const volumeTolerance=Math.max(0.02,sourceVolume*1e-5);
  if(volumeError>volumeTolerance)throw new TerrainError('MODEL_VOLUME_MISMATCH','一体模型新增体积与路线／底座面积不一致');
  const report={...terrain.report,stage:2,modelKind:'integrated-terrain-route-and-base',
    config:{...(terrain.report.config as object),routeWidthMm:routeWidth,routeHeightMm:routeHeight,frameWidthMm:frameWidth},
    integratedModel:{...integrated.report,sourceTerrainVolumeMm3:sourceVolume,addedVolumeMm3:volumeDifference,volumeErrorMm3:volumeError,volumeToleranceMm3:volumeTolerance},
    validation,generationMs:Math.round(performance.now()-started),
    limitations:[`路线沿最终地形按模型 Z 方向高出 ${routeHeight} mm；STL 不保存颜色`,'尚未完成目标切片软件和实物打印验收']};
  request.signal?.throwIfAborted();
  request.onProgress?.({phase:'done',progress:1,message:'一体模型已生成并通过检查'});
  return {...terrain,mesh:integrated.mesh,report};
}
