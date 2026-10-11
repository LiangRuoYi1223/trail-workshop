import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { saveModelStl, StlSaveError } from '../main/save-stl.mjs';

function tetrahedron() {
  const faces = [
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  ];
  const file = Buffer.alloc(84 + faces.length * 50);
  file.write('TrailPrint test tetrahedron', 0, 'ascii');
  file.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => face.flat().forEach((n, scalar) => {
    file.writeFloatLE(n, 84 + index * 50 + 12 + scalar * 4);
  }));
  return file;
}

async function fixture(t) {
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.scratch');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'trailprint-save-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('trailprint-save-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const inputDirectory = path.join(root, '应用任务');
  const exportDirectory = path.join(root, '我的 打印模型');
  await fs.mkdir(inputDirectory);
  await fs.mkdir(exportDirectory);
  const input = path.join(inputDirectory, '最终模型.stl');
  const output = path.join(exportDirectory, '龙泉山 徒步.stl');
  const contents = tetrahedron();
  await fs.writeFile(input, contents);
  return { input, output, exportDirectory, contents, sha256: createHash('sha256').update(contents).digest('hex') };
}

function fail(code = 'EACCES') {
  return Object.assign(new Error('Injected filesystem failure'), { code });
}

test('中文及空格路径仅保存一个 STL，文件与冻结预览的 SHA 一致', async t => {
  const f = await fixture(t);
  const saved = await saveModelStl(f.input, f.output, { expectedSha256: f.sha256 });
  assert.deepEqual(saved, { path: f.output, bytes: f.contents.length, sha256: f.sha256, warnings: [] });
  assert.deepEqual(await fs.readFile(f.output), f.contents);
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('未确认覆盖时保留原文件，且不创建旁文件', async t => {
  const f = await fixture(t);
  const original = Buffer.from('my existing print');
  await fs.writeFile(f.output, original);
  await assert.rejects(saveModelStl(f.input, f.output), { code: 'DESTINATION_EXISTS' });
  assert.deepEqual(await fs.readFile(f.output), original);
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('系统窗口已确认覆盖时替换打印文件并清除私有备份', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  const saved = await saveModelStl(f.input, f.output, { expectedSha256: f.sha256, overwriteApproved: true });
  assert.equal(saved.sha256, f.sha256);
  assert.deepEqual(await fs.readFile(f.output), f.contents);
  assert.deepEqual(await fs.readFile(f.input), f.contents);
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('STL 截断校验失败时不动已确认覆盖的原文件', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  await fs.writeFile(f.input, f.contents.subarray(0, f.contents.length - 1));
  await assert.rejects(saveModelStl(f.input, f.output, { overwriteApproved: true }), { code: 'SOURCE_INVALID' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'previous model');
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('模型 SHA 与冻结预览不符时不创建目标文件', async t => {
  const f = await fixture(t);
  await assert.rejects(saveModelStl(f.input, f.output, { expectedSha256: '0'.repeat(64) }), { code: 'HASH_MISMATCH' });
  assert.deepEqual(await fs.readdir(f.exportDirectory), []);
});

test('非有限三角面坐标被拒绝', async t => {
  const f = await fixture(t);
  const corrupted = Buffer.from(f.contents);
  corrupted.writeFloatLE(Number.NaN, 96);
  await fs.writeFile(f.input, corrupted);
  await assert.rejects(saveModelStl(f.input, f.output), { code: 'SOURCE_INVALID' });
  assert.deepEqual(await fs.readdir(f.exportDirectory), []);
});

test('不得把结果保存回计算任务源文件', async t => {
  const f = await fixture(t);
  await assert.rejects(saveModelStl(f.input, f.input, { overwriteApproved: true }), { code: 'SAME_PATH' });
  assert.deepEqual(await fs.readFile(f.input), f.contents);
});

test('源文件的硬链接也不作为覆盖目标', async t => {
  const f = await fixture(t);
  // Simulate the shared inode metadata so the test also runs in Windows
  // sandboxes that disallow creating hard links.
  await fs.copyFile(f.input, f.output);
  const sourceStat = await fs.lstat(f.input);
  const ops = { ...fs, lstat: file => file === f.output ? Promise.resolve(sourceStat) : fs.lstat(file) };
  await assert.rejects(saveModelStl(f.input, f.output, { overwriteApproved: true }, ops), { code: 'SAME_PATH' });
  assert.deepEqual(await fs.readFile(f.input), f.contents);
});

test('暂存写入失败不修改已有文件，并清除未完成暂存', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  const ops = { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args);
    if (!file.endsWith('.stage')) return handle;
    return { writeFile: async () => { throw fail('ENOSPC'); }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  await assert.rejects(saveModelStl(f.input, f.output, { overwriteApproved: true }, ops), { code: 'SAVE_FAILED' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'previous model');
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('发布重命名失败会恢复原文件，且不留下诊断或压缩包', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  const ops = { ...fs, rename: async (from, to) => {
    if (from.endsWith('.stage')) throw fail();
    return fs.rename(from, to);
  } };
  await assert.rejects(saveModelStl(f.input, f.output, { overwriteApproved: true }, ops), { code: 'SAVE_FAILED' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'previous model');
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('确认后被外部修改的目标会保留修改，不覆盖新文件', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  let targetReads = 0;
  const ops = { ...fs, lstat: async file => {
    if (file === f.output && ++targetReads === 2) await fs.writeFile(f.output, 'externally changed model');
    return fs.lstat(file);
  } };
  await assert.rejects(saveModelStl(f.input, f.output, { overwriteApproved: true }, ops), { code: 'DESTINATION_CHANGED' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'externally changed model');
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('生成期间出现新目标文件时不覆盖它', async t => {
  const f = await fixture(t);
  let targetReads = 0;
  const ops = { ...fs, lstat: async file => {
    if (file === f.output && ++targetReads === 2) await fs.writeFile(f.output, 'another export');
    return fs.lstat(file);
  } };
  await assert.rejects(saveModelStl(f.input, f.output, { overwriteApproved: true }, ops), { code: 'DESTINATION_CHANGED' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'another export');
  assert.deepEqual(await fs.readdir(f.exportDirectory), [path.basename(f.output)]);
});

test('打印文件成功保存后清理备份失败仅返回提示', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  const ops = { ...fs, unlink: async file => {
    if (file.endsWith('.backup')) throw fail();
    return fs.unlink(file);
  } };
  const saved = await saveModelStl(f.input, f.output, { overwriteApproved: true }, ops);
  assert.equal(saved.warnings.length, 1);
  assert.deepEqual(await fs.readFile(f.output), f.contents);
  const backup = (await fs.readdir(f.exportDirectory)).find(file => file.endsWith('.backup'));
  assert.ok(backup);
  assert.equal(await fs.readFile(path.join(f.exportDirectory, backup), 'utf8'), 'previous model');
});

test('回滚失败保留原备份并给出可恢复路径', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'previous model');
  const ops = { ...fs, rename: async (from, to) => {
    if (from.endsWith('.stage') || from.endsWith('.backup')) throw fail();
    return fs.rename(from, to);
  } };
  let reported;
  try { await saveModelStl(f.input, f.output, { overwriteApproved: true }, ops); }
  catch (error) { reported = error; }
  assert.ok(reported instanceof StlSaveError);
  assert.equal(reported.code, 'ROLLBACK_FAILED');
  assert.equal(await fs.readFile(reported.recoveryPath, 'utf8'), 'previous model');
  assert.ok((await fs.readdir(f.exportDirectory)).every(file => file.endsWith('.backup')));
});
