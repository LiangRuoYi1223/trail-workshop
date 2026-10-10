import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { generateTerrain } from './generate-terrain.js';
import { generatePrintableTerrain } from './generate-printable-terrain.js';
import { loadLocalDem, loadOpenTopographyDem } from './dem/provider.js';
import { publishTerrainOutput } from './export/publish.js';
import { readMatchingDemSource } from './export/provenance.js';
import type { PrintableTerrainOptions } from './types.js';
import { TerrainError } from './errors.js';

interface JobConfig { stage?:1|2;gpx:string;output:string;dem:{file?:string;provider?:'opentopography';dataset?:string};terrain?:PrintableTerrainOptions }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parseConfig(value: unknown): JobConfig {
  if (!isRecord(value) || typeof value.gpx !== 'string' || !value.gpx.trim() || typeof value.output !== 'string' || !value.output.trim() || !isRecord(value.dem))
    throw new TerrainError('CONFIG_INVALID', '配置必须包含有效的 gpx、output 路径和 dem 对象');
  const dem = value.dem;
  if (dem.file !== undefined && (typeof dem.file !== 'string' || !dem.file.trim())) throw new TerrainError('CONFIG_INVALID', 'dem.file 必须是非空路径');
  if (dem.provider !== undefined && dem.provider !== 'opentopography') throw new TerrainError('CONFIG_INVALID', 'dem.provider 仅支持 opentopography');
  if ((dem.file === undefined) === (dem.provider === undefined)) throw new TerrainError('CONFIG_INVALID', 'dem.file 和 dem.provider 必须且只能选择一个');
  if (dem.dataset !== undefined && typeof dem.dataset !== 'string') throw new TerrainError('CONFIG_INVALID', 'dem.dataset 必须是字符串');
  if (value.terrain !== undefined && !isRecord(value.terrain)) throw new TerrainError('CONFIG_INVALID', 'terrain 必须是参数对象');
  if (value.stage !== undefined && value.stage !== 1 && value.stage !== 2) throw new TerrainError('CONFIG_INVALID','stage 必须为 1 或 2');
  return value as unknown as JobConfig;
}

try {
  const {values}=parseArgs({options:{config:{type:'string'},help:{type:'boolean'}}});
  if(values.help||!values.config) {
    console.log('用法：npm run generate -- --config fixtures/demo.json\n配置内路径均相对配置文件；个人 Key 只从 OPENTOPOGRAPHY_API_KEY 读取。');
    if(!values.help)process.exitCode=1;
  } else {
    const configPath=resolve(values.config),folder=dirname(configPath);
    let value: unknown;
    try { value=JSON.parse(await readFile(configPath,'utf8')); }
    catch (error) { if(error instanceof SyntaxError)throw new TerrainError('CONFIG_INVALID','配置不是有效的 JSON');throw error; }
    const config=parseConfig(value);
    const gpxPath=resolve(folder,config.gpx),output=resolve(folder,config.output);
    if(!output.toLowerCase().endsWith('.stl'))throw new TerrainError('CONFIG_INVALID','输出文件名必须以 .stl 结尾');
    const gpxXml=await readFile(gpxPath,'utf8');
    const generator=config.stage===2?generatePrintableTerrain:generateTerrain;
    const result=await generator({gpxXml,fileName:basename(gpxPath),options:config.terrain,
      loadDem:async(bounds,context)=> {
        if(config.dem.file) {
          const demPath=resolve(folder,config.dem.file);
          const sampler=await loadLocalDem(demPath);
          const hash=(sampler.metadata as {sha256:string}).sha256;
          const source=await readMatchingDemSource(demPath,hash);
          return {sample:sampler.sample,metadata:{...sampler.metadata,...(source?{source}:{} )}};
        }
        return loadOpenTopographyDem(bounds,{dataset:config.dem.dataset,cacheDir:resolve('data/dem-cache'),signal:context.signal});
      },
      onProgress:p=>console.error(`[${Math.round(p.progress*100)}%] ${p.message}`),
    });
    result.report.inputs={gpxFile:basename(gpxPath),gpxSha256:createHash('sha256').update(gpxXml).digest('hex')};
    const publication=await publishTerrainOutput(output,result);
    console.log(JSON.stringify({output,report:output.replace(/\.stl$/i,'.report.json'),validation:result.report.validation,...(publication.warnings.length?{warnings:publication.warnings}:{})},null,2));
  }
} catch(error) {
  let code=error instanceof Error && 'code' in error && typeof error.code==='string'?error.code:error instanceof Error && error.name==='AbortError'?'CANCELLED':'GENERATION_FAILED';
  if(code.startsWith('ERR_PARSE_ARGS'))code='CONFIG_INVALID';
  console.error(JSON.stringify({error:code,message:error instanceof Error?error.message:String(error)}));
  process.exitCode=1;
}
