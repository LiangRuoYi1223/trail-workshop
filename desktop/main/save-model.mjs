import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StlSaveError } from './save-stl.mjs';

const failure = (code, message, cause) => new StlSaveError(code, message, { cause });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function optionalStat(file, ops) {
  try { return await ops.lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Task cleanup must never remove the user's purported saved copy. */
export function assertPermanentSaveTarget(targetPath, temporaryDirectory) {
  const relative=path.relative(path.resolve(temporaryDirectory),path.resolve(targetPath));
  if(relative==='' || (!relative.startsWith(`..${path.sep}`) && relative!=='..' && !path.isAbsolute(relative))) {
    throw failure('SAME_PATH','请选择生成任务目录以外的保存位置。');
  }
}

/** Frozen main-process bytes; target must come from the native save dialog. */
export async function saveModelFile(bytes, targetPath, options = {}, fsOps = fs) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 100 * 1024 * 1024) {
    throw failure('SOURCE_INVALID', '打印文件无效或超过大小上限，请降低精度后重新生成。');
  }
  if (typeof targetPath !== 'string' || targetPath.includes('\0') || !path.isAbsolute(targetPath)) {
    throw failure('INVALID_PATH', '请选择完整的打印文件保存位置。');
  }
  if(options.sourcePath!==undefined && (typeof options.sourcePath!=='string'||options.sourcePath.includes('\0')||!path.isAbsolute(options.sourcePath))) {
    throw failure('SOURCE_INVALID','生成模型源文件无效，请重新生成。');
  }
  if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) {
    throw failure('INVALID_HASH', '模型校验信息无效，请重新生成模型。');
  }
  const contents = Buffer.from(bytes), target = path.resolve(targetPath), directory = path.dirname(target);
  const source=options.sourcePath===undefined?undefined:path.resolve(options.sourcePath);
  if(source!==undefined&&samePath(source,target))throw failure('SAME_PATH','请选择生成任务目录以外的保存位置。');
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (options.expectedSha256 !== undefined && options.expectedSha256.toLowerCase() !== sha256) {
    throw failure('HASH_MISMATCH', '打印文件与当前预览不一致，请重新生成后再保存。');
  }
  let parent, original;
  const checkDirectory = async () => {
    const entry = await fsOps.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await fsOps.realpath(directory), directory)
      || (parent && (entry.dev !== parent.dev || entry.ino !== parent.ino))) {
      throw failure('DESTINATION_CHANGED', '保存文件夹已发生变化，请重新选择保存位置。');
    }
    return entry;
  };
  try {
    parent = await checkDirectory();
    original = await optionalStat(target, fsOps);
    if (original && (!original.isFile() || original.isSymbolicLink())) throw failure('DESTINATION_INVALID', '保存位置不是普通文件，请选择其他文件名或文件夹。');
    if(source!==undefined) {
      const sourceEntry=await fsOps.lstat(source);
      if(!sourceEntry.isFile()||sourceEntry.isSymbolicLink())throw failure('SOURCE_INVALID','生成模型源文件无效，请重新生成。');
      if(original&&(original.dev===sourceEntry.dev&&original.ino===sourceEntry.ino))throw failure('SAME_PATH','请选择生成任务目录以外的保存位置。');
    }
    if (original && options.overwriteApproved !== true) throw failure('DESTINATION_EXISTS', '此文件已经存在，请通过保存窗口确认覆盖或更换文件名。');
  } catch (error) {
    if (error instanceof StlSaveError) throw error;
    throw failure('SAVE_FAILED', '无法读取保存文件夹，请选择其他文件夹。', error);
  }
  const nonce = randomUUID(), stem = path.basename(target);
  const staged = path.join(directory, `.${stem}.${nonce}.stage`), backup = path.join(directory, `.${stem}.${nonce}.backup`);
  let stageOwned = false, backupOwned = false, originalMoved = false, published = false;
  const warnings = [];
  const removeOwned = async file => {
    try { await checkDirectory(); await fsOps.unlink(file); return true; }
    catch (error) { return error.code === 'ENOENT'; }
  };
  try {
    await checkDirectory();
    const output = await fsOps.open(staged, 'wx', 0o600); stageOwned = true;
    try { await output.writeFile(contents); await output.sync(); } finally { await output.close(); }
    await checkDirectory();
    const current = await optionalStat(target, fsOps);
    if (original ? !current || !sameIdentity(original, current) : current !== undefined) {
      throw failure('DESTINATION_CHANGED', '保存位置已发生变化，请重新选择保存位置。');
    }
    if (original) {
      const reserve = await fsOps.open(backup, 'wx', 0o600); backupOwned = true; await reserve.close();
      await checkDirectory(); await fsOps.rename(target, backup); originalMoved = true;
      const moved = await fsOps.lstat(backup);
      if (moved.dev !== original.dev || moved.ino !== original.ino || moved.size !== original.size || moved.mtimeMs !== original.mtimeMs) {
        throw failure('DESTINATION_CHANGED', '保存位置已被其他程序修改，请重新选择保存位置。');
      }
    }
    await checkDirectory();
    if (await optionalStat(target, fsOps)) throw failure('DESTINATION_CHANGED', '保存位置已被其他程序占用，请重新选择保存位置。');
    await fsOps.rename(staged, target); stageOwned = false; published = true;
  } catch (error) {
    if (originalMoved && !published) {
      try {
        await checkDirectory();
        if (await optionalStat(target, fsOps)) throw new Error('Destination occupied during rollback');
        await fsOps.rename(backup, target); backupOwned = false; originalMoved = false;
      } catch (rollbackError) {
        if (stageOwned) await removeOwned(staged);
        throw new StlSaveError('ROLLBACK_FAILED', '保存未完成，原文件的备份已保留；请选择其他文件夹并保留恢复文件。', { cause: rollbackError, recoveryPath: backup });
      }
    }
    if (stageOwned) await removeOwned(staged);
    if (backupOwned && !originalMoved) await removeOwned(backup);
    if (error instanceof StlSaveError) throw error;
    throw failure('SAVE_FAILED', '无法保存打印文件，请检查文件夹可写性，或选择其他文件夹。', error);
  }
  if (backupOwned && !await removeOwned(backup)) warnings.push('打印文件已保存，但旧文件备份暂时无法清理。');
  return { path: target, bytes: contents.length, sha256, warnings };
}
