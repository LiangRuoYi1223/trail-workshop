import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { TerrainError } from '../errors.js';
import type { GenerationResult } from '../types.js';
import { writeBinaryStl } from '../vendor/trailprint/stl-writer.js';
import type { ModelAppearance } from '../appearance/types.js';
import { validateModelAppearance } from '../appearance/palette.js';

type PublishResult = GenerationResult & { appearance?: ModelAppearance };

/** Exclusive cross-process output lock, staged bundle and rollback for ordinary I/O failures. */
export async function publishTerrainOutput(output: string, result: PublishResult): Promise<{warnings:string[]}> {
  const target = resolve(output), parent = dirname(target);
  if (!target.toLowerCase().endsWith('.stl')) throw new TerrainError('CONFIG_INVALID', '输出文件名必须以 .stl 结尾');
  await mkdir(parent, { recursive: true });
  const lockPath = target + '.lock', warnings:string[] = [];
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new TerrainError('OUTPUT_BUSY', '该输出文件正在生成或有未清理的锁文件，请使用另一个文件名');
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()})+'\n');
    await publishLocked(target, result, warnings);
    return {warnings};
  } finally {
    await lock.close().catch(()=>warnings.push(`输出锁关闭失败：${lockPath}`));
    await rm(lockPath,{force:true}).catch(()=>warnings.push(`输出锁清理失败：${lockPath}`));
  }
}

async function publishLocked(target:string, result:PublishResult, warnings:string[]):Promise<void> {
  const parent=dirname(target);
  const targets = [target, target.replace(/\.stl$/i, '.report.json'), target.replace(/\.stl$/i, '.preview.json')];
  const exists: boolean[] = [];
  for (const path of targets) {
    try {
      const entry = await lstat(path);
      if (!entry.isFile()) throw new TerrainError('OUTPUT_INVALID', `输出位置必须是普通文件：${basename(path)}`);
      exists.push(true);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists.push(false);
      else throw error;
    }
  }
  const stage = await mkdtemp(join(parent, '.terrain-export-'));
  const staged = targets.map(path => join(stage, basename(path)));
  const backups = targets.map((_, index) => join(stage, `previous-${index}`));
  const backed: number[] = [], published: number[] = [];
  let preserveStage = false;
  try {
    if (result.appearance) {
      validateModelAppearance(result.appearance, result.mesh.indices.length / 3);
      result.report.appearanceHash = result.appearance.hash;
    }
    await writeBinaryStl(staged[0], result.mesh, 'Chuanheng_Terrain');
    const stl = await readFile(staged[0]);
    result.report.output = { file: basename(target), bytes: stl.byteLength, sha256: createHash('sha256').update(stl).digest('hex') };
    await writeFile(staged[1], JSON.stringify(result.report, null, 2) + '\n');
    await writeFile(staged[2], JSON.stringify({stage:result.report.stage, unit:'mm', mesh:result.mesh, routeSegmentsMm:result.routeSegmentsMm, crop:result.report.selection,report:result.report,
      ...(result.appearance ? { appearance: result.appearance } : {})}) + '\n');
    for (let i = 0; i < targets.length; i++) if (exists[i]) {
      await rename(targets[i], backups[i]);
      backed.push(i);
    }
    for (const i of [1, 2, 0]) {
      await rename(staged[i], targets[i]);
      published.push(i);
    }
  } catch (error) {
    try {
      for (const i of published) await rm(targets[i], { force: true });
      for (const i of backed) await rename(backups[i], targets[i]);
    } catch {
      preserveStage = true;
      throw new TerrainError('EXPORT_RECOVERY_REQUIRED', `输出恢复失败，原文件保存在 ${stage}，请保留该目录`);
    }
    throw error;
  } finally {
    if (!preserveStage) {
      const resolvedStage = resolve(stage);
      if (dirname(resolvedStage) !== parent || !basename(resolvedStage).startsWith('.terrain-export-')) throw new TerrainError('OUTPUT_INVALID', '临时输出目录检查失败');
      // Successful publication remains successful if deleting old backups is temporarily blocked.
      await rm(resolvedStage, { recursive: true, force: true }).catch(()=>warnings.push(`临时输出清理失败，请保留或稍后清理：${resolvedStage}`));
    }
  }
}
