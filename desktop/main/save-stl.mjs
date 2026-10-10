import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Errors are safe to show in the desktop UI; filesystem details stay in cause. */
export class StlSaveError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'StlSaveError';
    this.code = code;
    if (options.recoveryPath) this.recoveryPath = options.recoveryPath;
  }
}

const failure = (code, message, cause) => new StlSaveError(code, message, { cause });
const comparablePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function statIfExists(file, ops) {
  try { return await ops.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function removeOwned(file, ops) {
  try { await ops.unlink(file); return true; }
  catch (error) { return error.code === 'ENOENT'; }
}

/**
 * Save one frozen, binary STL chosen by the main process's native Save As dialog.
 * fsOps is an injection seam for failure tests; it must never cross renderer IPC.
 */
export async function saveModelStl(sourcePath, targetPath, options = {}, fsOps = fs) {
  if (typeof sourcePath !== 'string' || typeof targetPath !== 'string'
      || !path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath)) {
    throw failure('INVALID_PATH', '请选择完整的打印文件保存位置。');
  }
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (comparablePath(source) === comparablePath(target)) {
    throw failure('SAME_PATH', '请选择生成任务目录以外的保存位置。');
  }
  if (options.expectedSha256 !== undefined
      && !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) {
    throw failure('INVALID_HASH', '模型校验信息无效，请重新生成模型。');
  }

  let contents;
  let original;
  try {
    original = await statIfExists(target, fsOps);
    if (original && (!original.isFile() || original.isSymbolicLink())) {
      throw failure('DESTINATION_INVALID', '保存位置不是普通文件，请选择其他文件名或文件夹。');
    }
    if (original && options.overwriteApproved !== true) {
      throw failure('DESTINATION_EXISTS', '此文件已经存在，请通过保存窗口确认覆盖或更换文件名。');
    }
    if (original) {
      const [realSource, realTarget] = await Promise.all([
        fsOps.realpath(source), fsOps.realpath(target),
      ]);
      if (comparablePath(realSource) === comparablePath(realTarget)) {
        throw failure('SAME_PATH', '请选择生成任务目录以外的保存位置。');
      }
    }
    const input = await fsOps.open(source, 'r');
    try {
      const sourceStat = await input.stat();
      if (original && sourceStat.dev === original.dev && sourceStat.ino === original.ino) {
        throw failure('SAME_PATH', '请选择生成任务目录以外的保存位置。');
      }
      if (!sourceStat.isFile() || sourceStat.size < 134 || sourceStat.size > 25_000_084) {
        throw failure('SOURCE_INVALID', '生成的打印文件无效或超出模型上限，请重新生成。');
      }
      contents = await input.readFile();
    } finally { await input.close(); }
  } catch (error) {
    if (error instanceof StlSaveError) throw error;
    throw failure('SAVE_FAILED', '无法读取模型或保存文件夹，请重新生成模型或选择其他文件夹。', error);
  }

  const triangles = contents.readUInt32LE(80);
  if (triangles === 0 || triangles > 500_000 || contents.length !== 84 + triangles * 50) {
    throw failure('SOURCE_INVALID', '生成的文件不是完整的二进制 STL，请重新生成模型。');
  }
  for (let face = 0; face < triangles; face++) {
    for (let scalar = 0; scalar < 12; scalar++) {
      if (!Number.isFinite(contents.readFloatLE(84 + face * 50 + scalar * 4))) {
        throw failure('SOURCE_INVALID', '模型包含无效坐标，请重新生成模型。');
      }
    }
  }
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256.toLowerCase()) {
    throw failure('HASH_MISMATCH', '模型文件与当前预览不一致，请重新生成后再保存。');
  }

  const nonce = randomUUID();
  const directory = path.dirname(target);
  const stem = path.basename(target);
  const staged = path.join(directory, `.${stem}.${nonce}.stage`);
  const backup = path.join(directory, `.${stem}.${nonce}.backup`);
  let stageOwned = false;
  let backupOwned = false;
  let originalMoved = false;
  let published = false;
  const warnings = [];
  try {
    const output = await fsOps.open(staged, 'wx', 0o600);
    stageOwned = true;
    try { await output.writeFile(contents); await output.sync(); }
    finally { await output.close(); }

    // Recheck the dialog-selected destination immediately before publishing.
    const current = await statIfExists(target, fsOps);
    if (original ? !current || !sameIdentity(original, current) : current !== undefined) {
      throw failure('DESTINATION_CHANGED', '保存位置在生成期间已发生变化，请重新选择保存位置。');
    }
    if (original) {
      // Reserve our private backup name so no existing file is replaced.
      const reserve = await fsOps.open(backup, 'wx', 0o600);
      backupOwned = true;
      await reserve.close();
      await fsOps.rename(target, backup);
      originalMoved = true;
      const moved = await fsOps.lstat(backup);
      // Rename changes ctime on some platforms; identity, size and mtime remain.
      if (moved.dev !== original.dev || moved.ino !== original.ino
          || moved.size !== original.size || moved.mtimeMs !== original.mtimeMs) {
        throw failure('DESTINATION_CHANGED', '保存位置已被其他程序修改，请重新选择保存位置。');
      }
    }
    if (await statIfExists(target, fsOps)) {
      throw failure('DESTINATION_CHANGED', '保存位置已被其他程序占用，请重新选择保存位置。');
    }
    await fsOps.rename(staged, target);
    stageOwned = false;
    published = true;
  } catch (error) {
    if (originalMoved && !published) {
      try {
        if (await statIfExists(target, fsOps)) throw new Error('Destination occupied during rollback');
        await fsOps.rename(backup, target);
        backupOwned = false;
        originalMoved = false;
      } catch (rollbackError) {
        if (stageOwned) await removeOwned(staged, fsOps);
        throw new StlSaveError('ROLLBACK_FAILED', '保存未完成，原文件的备份已保留；请选择其他文件夹并保留恢复文件。',
          { cause: rollbackError, recoveryPath: backup });
      }
    }
    if (stageOwned) await removeOwned(staged, fsOps);
    if (backupOwned && !originalMoved) await removeOwned(backup, fsOps);
    if (error instanceof StlSaveError) throw error;
    throw failure('SAVE_FAILED', '无法保存打印文件，请检查文件夹可写性，或选择其他文件夹。', error);
  }
  if (backupOwned && !await removeOwned(backup, fsOps)) {
    warnings.push('打印文件已保存，但旧文件备份暂时无法清理。');
  }
  return { path: target, bytes: contents.length, sha256, warnings };
}
