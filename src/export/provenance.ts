import { readFile } from 'node:fs/promises';
import { TerrainError } from '../errors.js';

export async function readMatchingDemSource(demPath: string, hash: string): Promise<Record<string, unknown> | undefined> {
  const sourcePath = demPath.replace(/\.(?:tiff?|geotiff)$/i, '.source.json');
  if (sourcePath === demPath) return undefined;
  let text: string;
  try { text = await readFile(sourcePath, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let source: unknown;
  try { source = JSON.parse(text); }
  catch { throw new TerrainError('DEM_SOURCE_INVALID', 'DEM 来源记录不是有效的 JSON'); }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TerrainError('DEM_SOURCE_INVALID', 'DEM 来源记录格式无效');
  const record = source as Record<string, unknown>;
  if (record.sha256 !== hash) throw new TerrainError('DEM_SOURCE_MISMATCH', 'DEM 来源记录与当前高程文件的校验值不一致');
  const result: Record<string, unknown> = { sha256: hash };
  for (const key of ['dataset', 'sourceUrl', 'registry', 'attribution', 'accessedAt']) if (typeof record[key] === 'string') result[key] = record[key];
  for (const key of ['requestedBounds', 'sourceWindow']) if (record[key] !== undefined) result[key] = record[key];
  return result;
}
