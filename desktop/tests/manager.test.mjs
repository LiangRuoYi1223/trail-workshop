import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createDesktopManager } from '../main/manager.mjs';

const project = resolve(import.meta.dirname, '../..');
const testParent = join(project, 'outputs', 'desktop-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const gpx = '<gpx><trk><name>测试山路</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
const delay = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async condition => {
  const expires = Date.now() + 10000;
  while (!condition()) { if (Date.now() > expires) throw new Error('Test task did not settle'); await delay(5); }
};
class FakeWorker extends EventEmitter {
  constructor(manualExit) { super(); this.manualExit = manualExit; this.kills = 0; }
  postMessage(message) { this.request = message; }
  kill() { this.kills++; if (!this.manualExit) queueMicrotask(() => this.emit('exit', 0)); }
  send(message) { this.emit('message', { ...message, jobId: this.request.jobId }); }
}
async function fixture(t, { timeout = 1000, manualExit = false, factory, cache = true, coreOverride } = {}) {
  await mkdir(testParent, { recursive: true });
  const root = await mkdtemp(join(testParent, 'terrain-desktop-manager-'));
  const routePath = join(root, '中文路线.gpx'), demPath = join(root, '高程.tif'), children = [], events = [];
  await Promise.all([writeFile(routePath, gpx), writeFile(demPath, Buffer.from('mock DEM'))]);
  let coreUrl = coreModuleUrl;
  if (coreOverride) {
    const mockPath = join(root, 'test-core.mjs');
    await writeFile(mockPath, `export * from ${JSON.stringify(coreModuleUrl)};\n${coreOverride(root)}`);
    coreUrl = pathToFileURL(mockPath).href;
  }
  const manager = createDesktopManager({ taskRoot: join(root, 'tasks'), coreModuleUrl: coreUrl, jobTimeoutMs: timeout,
    ...(cache ? { demCacheDir: join(root, 'elevation-cache') } : {}),
    workerFactory: factory ?? (() => { const child = new FakeWorker(manualExit); children.push(child); return child; }),
    onJob: job => events.push(job) });
  t.after(async () => {
    children.forEach(child => child.emit('exit', 0));
    await manager.close();
    const target = resolve(root);
    assert.equal(dirname(target), testParent); assert.ok(basename(target).startsWith('terrain-desktop-manager-'));
    await rm(target, { recursive: true, force: true });
  });
  const route = await manager.addRoute(routePath), dem = await manager.addDem(demPath);
  return { root, manager, route, dem, routePath, demPath, children, events, start: options => manager.start({ routeId: route.id, demId: dem.id, options }) };
}
async function writeOutput(taskDir, { corrupt = false, dem } = {}) {
  const positions = [0, 0, 0, 1.123456789, 0, 0, 0, 1, 0, 0, 0, 1];
  const indices = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
  const stl = Buffer.alloc(284); stl.writeUInt32LE(4, 80);
  for (let t = 0; t < 4; t++) for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) stl.writeFloatLE(positions[indices[t * 3 + v] * 3 + a], 84 + t * 50 + 12 + v * 12 + a * 4);
  const sha = createHash('sha256').update(stl).digest('hex');
  const report = { stage: 2, output: { bytes: stl.length, sha256: corrupt ? '0'.repeat(64) : sha },
    validation: { triangleCount: 4, connectedComponents: 1, boundaryEdges: 0, nonManifoldEdges: 0 }, ...(dem ? { dem } : {}) };
  const preview = { stage: 2, unit: 'mm', mesh: { positions, indices, faceKinds: ['wall', 'terrain', 'route', 'bottom'] } };
  await Promise.all([writeFile(join(taskDir, 'model.stl'), stl), writeFile(join(taskDir, 'model.report.json'), JSON.stringify(report)), writeFile(join(taskDir, 'model.preview.json'), JSON.stringify(preview))]);
}

test('route information uses opaque ids, preserves segment breaks and does not expose paths', async t => {
  const f = await fixture(t);
  assert.equal(f.route.name, '测试山路'); assert.equal(f.route.pointCount, 2); assert.equal(f.route.fileName, '中文路线.gpx');
  assert.ok(!JSON.stringify(f.route).includes(f.root)); assert.ok(!JSON.stringify(f.dem).includes(f.root));
  const split = join(f.root, '多段.gpx');
  await writeFile(split, '<gpx><trk><trkseg><trkpt lat="30" lon="104"/><trkpt lat="30.01" lon="104.01"/></trkseg><trkseg><trkpt lat="30.03" lon="104.03"/><trkpt lat="30.04" lon="104.04"/></trkseg></trk></gpx>');
  const route = await f.manager.addRoute(split);
  assert.equal(route.segmentCount, 2); assert.deepEqual(route.segments.map(segment => segment.length), [2, 2]);
});

test('invalid file types, missing inputs and malformed XML return clear typed errors', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.addRoute(f.demPath), { code: 'INPUT_INVALID' });
  await assert.rejects(f.manager.addDem(join(f.root, 'missing.tif')), { code: 'INPUT_READ_FAILED' });
  await writeFile(f.routePath, '<gpx><trk>');
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'GPX_INVALID_XML' });
  await writeFile(f.routePath, '<!DOCTYPE gpx [<!ENTITY x "x">]><gpx/>');
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'GPX_UNSUPPORTED_DTD' });
});

test('GPX resource limits reject files over 2 MB and tracks over 50,000 source points', async t => {
  const f = await fixture(t);
  await writeFile(f.routePath, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'INPUT_TOO_LARGE' });
  await writeFile(f.routePath, `<gpx><trk><trkseg>${'<trkpt lat="30" lon="104"/>'.repeat(50001)}</trkseg></trk></gpx>`);
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'GPX_TOO_COMPLEX' });
});

test('inspection shares core projection and produces usable circle, rectangle and polygon outlines', async t => {
  const f = await fixture(t);
  const { createTerrainFrame } = await import(coreModuleUrl);
  for (const shape of ['rectangle', 'circle', 'polygon']) {
    const options = { shape, widthMm: 120, heightMm: 80, bearingDeg: 23 };
    const inspected = await f.manager.inspect({ routeId: f.route.id, options });
    const frame = createTerrainFrame(f.route.segments.flat(), options);
    assert.equal(inspected.routeSegmentsMm.length, 1); assert.ok(inspected.outlineMm.length >= 4);
    assert.ok(inspected.selection.groundWidthM > 0); assert.equal(inspected.selection.bearingDeg, 23);
    assert.ok(inspected.routeSegmentsMm.flat().every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.deepEqual(inspected.bounds, frame.bounds);
    assert.deepEqual(inspected.outlineGeo, inspected.outlineMm.map(point => frame.mmToGeo(point.x, point.y)));
    assert.ok(inspected.outlineGeo.every(point => point.lat >= frame.bounds.south && point.lat <= frame.bounds.north
      && point.lon >= frame.bounds.west && point.lon <= frame.bounds.east));
  }
});

test('automatic mode starts without local DEM and freezes the inspected geographic request', async t => {
  const f = await fixture(t);
  const options = { center: { lat: 30.565, lon: 104.29 }, groundWidthM: 4000, bearingDeg: 31 };
  const inspected = await f.manager.inspect({ routeId: f.route.id, options });
  const request = { routeId: f.route.id, options, offlineOnly: true };
  const job = await f.manager.start(request);
  options.center.lon = 105; options.groundWidthM = 9000; request.offlineOnly = false; request.demMode = 'local';
  const message = f.children[0].request;
  assert.equal(job.demMode, 'auto'); assert.equal(job.offlineOnly, true);
  assert.equal(message.demMode, 'auto'); assert.equal(message.offlineOnly, true);
  assert.equal(message.demCacheDir, join(f.root, 'elevation-cache')); assert.equal(message.demPath, undefined);
  assert.equal(message.options.center.lon, 104.29); assert.equal(message.options.groundWidthM, 4000);
  assert.deepEqual(message.bounds, inspected.bounds);
  assert.ok(Object.isFrozen(message.bounds)); assert.ok(Object.isFrozen(message.options));
  assert.ok(!JSON.stringify(job).includes(f.root));
});

test('automatic mode requires a configured cache and invalid source settings never launch', async t => {
  const f = await fixture(t, { cache: false });
  await assert.rejects(f.manager.start({ routeId: f.route.id, options: {} }), { code: 'DEM_CACHE_UNAVAILABLE' });
  for (const request of [{ demMode: 'remote' }, { demMode: null }, { demMode: '' }, { offlineOnly: 'true' }, { offlineOnly: 1 }, { offlineOnly: null }]) {
    await assert.rejects(f.manager.start({ routeId: f.route.id, options: {}, ...request }), { code: 'CONFIG_INVALID' });
  }
  await assert.rejects(f.manager.start({ routeId: f.route.id, demMode: 'local', options: {} }), { code: 'DEM_NOT_FOUND' });
  assert.equal(f.children.length, 0);
  assert.equal((await f.start({})).demMode, 'local');
});

test('two simultaneous starts still reserve exactly one worker', async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([
    f.manager.start({ routeId: f.route.id, options: {} }),
    f.manager.start({ routeId: f.route.id, options: {} }),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'JOB_BUSY');
  assert.equal(f.children.length, 1);
});

test('automatic high-elevation failures retain actionable Chinese errors and release on exit', async t => {
  const f = await fixture(t, { manualExit: true });
  const job = await f.manager.start({ routeId: f.route.id, offlineOnly: true, options: {} });
  const child = f.children[0];
  child.send({ type: 'failure', error: { code: 'DEM_CACHE_MISS', message: '离线缓存未覆盖当前取景，请联网获取高程后重试' } });
  await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.deepEqual(f.manager.get(job.id).error, { code: 'DEM_CACHE_MISS', message: '离线缓存未覆盖当前取景，请联网获取高程后重试' });
  assert.equal((await f.start({})).state, 'running');
});

test('verified automatic source summary includes cache state and excludes URLs, file paths and extra fields', async t => {
  const f = await fixture(t), job = await f.manager.start({ routeId: f.route.id, options: {} });
  const child = f.children[0];
  await writeOutput(child.request.taskDir, { dem: { provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)',
    cacheHit: true, tileCount: 2, sourceUrls: ['https://example.com/a'], path: f.root, key: 'private' } });
  child.send({ type: 'complete' }); child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  assert.deepEqual(f.manager.get(job.id).result.demSource, { provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)', cacheHit: true, tileCount: 2 });
  assert.ok(!JSON.stringify(f.manager.get(job.id)).includes('private'));
  assert.ok(!JSON.stringify(f.manager.get(job.id)).includes('https://'));
});

test('options reject unknown fields, unsupported scales and invalid values before launching a worker', async t => {
  const f = await fixture(t);
  for (const options of [{ widthMm: 0 }, { gridColumns: 258 }, { gridColumns: 128.5 }, { routeWidthMm: 0.1 }, { center: { lat: 91, lon: 0 } }, { output: 'secret' }, { shape: 'triangle' }, { smoothing: 'magic' }, { shape: 'circle', cornerRadiusMm: 1 }]) {
    await assert.rejects(f.start(options), { code: 'CONFIG_INVALID' });
  }
  assert.equal(f.children.length, 0);
});

test('one task freezes caller parameters and blocks a second task until actual worker exit', async t => {
  const f = await fixture(t, { manualExit: true });
  const options = { widthMm: 100, center: { lat: 30.565, lon: 104.29 } };
  const job = await f.start(options); options.widthMm = 200; options.center.lon = 105;
  assert.equal(f.manager.get(job.id).options.widthMm, 100); assert.equal(f.children[0].request.options.center.lon, 104.29);
  await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  f.manager.cancel(job.id); assert.equal(f.manager.get(job.id).state, 'cancelling');
  await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  f.children[0].emit('exit', 0);
  await waitFor(() => f.manager.get(job.id).state === 'cancelled');
  const second = await f.start({}); assert.equal(second.state, 'running');
});

test('completion verifies binary STL, returns matching Float32 preview and a path-free job result', async t => {
  const f = await fixture(t);
  const job = await f.start({}); const child = f.children[0];
  await writeOutput(child.request.taskDir);
  child.send({ type: 'progress', progress: 1, message: 'core finished' });
  assert.equal(f.manager.get(job.id).progress, 0.99);
  child.send({ type: 'complete', path: join(f.root, 'untrusted.stl') });
  assert.equal(f.manager.get(job.id).state, 'running'); child.emit('exit', 0);
  await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  const final = f.manager.get(job.id), preview = await f.manager.preview(job.id), artifact = await f.manager.artifact(job.id);
  assert.equal(preview.mesh.positions[3], Math.fround(1.123456789)); assert.equal(final.result.triangleCount, 4);
  assert.equal(final.result.dimensions.x, Math.fround(1.123456789)); assert.equal(artifact.stlSha256, final.result.stlSha256);
  assert.ok(artifact.path.endsWith('model.stl')); assert.ok(!JSON.stringify(final).includes(f.root));
  await writeFile(artifact.path, 'changed'); await assert.rejects(f.manager.artifact(job.id), { code: 'OUTPUT_MISMATCH' });
});

test('cancellation ignores late completion, removes owned files and allows retry', async t => {
  const f = await fixture(t, { manualExit: true }); const job = await f.start({}), child = f.children[0];
  await writeOutput(child.request.taskDir); f.manager.cancel(job.id); child.send({ type: 'complete' }); child.emit('exit', 0);
  await waitFor(() => f.manager.get(job.id).state === 'cancelled');
  assert.equal(f.manager.get(job.id).result, undefined);
  assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
  await assert.rejects(f.manager.preview(job.id), { code: 'RESULT_UNAVAILABLE' });
  assert.equal((await f.start({})).state, 'running');
});

test('timeout kills the worker, awaits exit and exposes an actionable failure', async t => {
  const f = await fixture(t, { timeout: 15, manualExit: true }); const job = await f.start({}), child = f.children[0];
  await waitFor(() => child.kills === 1); await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.equal(f.manager.get(job.id).error.code, 'JOB_TIMEOUT'); assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});

test('unexpected worker exit fails cleanly instead of reporting success', async t => {
  const f = await fixture(t), job = await f.start({}); f.children[0].emit('exit', 9);
  await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.equal(f.manager.get(job.id).error.code, 'WORKER_CRASHED'); assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});

test('missing or corrupt results are rejected and task directories are cleaned', async t => {
  const f = await fixture(t);
  for (const corrupt of [undefined, true]) {
    const job = await f.start({}), child = f.children.at(-1);
    if (corrupt) await writeOutput(child.request.taskDir, { corrupt });
    child.send({ type: 'complete' }); child.emit('exit', 0);
    await waitFor(() => f.manager.get(job.id).state === 'failed');
    assert.ok(['OUTPUT_READ_FAILED', 'OUTPUT_INVALID'].includes(f.manager.get(job.id).error.code));
  }
  assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});

test('close cancels active computation and waits for process exit', async t => {
  const f = await fixture(t, { manualExit: true }), job = await f.start({}); let resolved = false;
  const closing = f.manager.close().then(() => { resolved = true; });
  await delay(5); assert.equal(resolved, false); assert.equal(f.children[0].kills, 1);
  f.children[0].emit('exit', 0); await closing; assert.equal(f.manager.get(job.id).state, 'cancelled');
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'APP_CLOSED' });
});

test('successful task storage is bounded and closing removes only app-owned temporary results', async t => {
  const f = await fixture(t), ids = [];
  const unrelated = join(f.root, '保留我的文件.txt'); await writeFile(unrelated, 'keep');
  for (let i = 0; i < 4; i++) {
    const job = await f.start({}), child = f.children.at(-1); ids.push(job.id);
    await writeOutput(child.request.taskDir); child.send({ type: 'complete' }); child.emit('exit', 0);
    await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  }
  await waitFor(() => { try { f.manager.get(ids[0]); return false; } catch (error) { return error.code === 'JOB_NOT_FOUND'; } });
  assert.equal((await readdir(join(f.root, 'tasks'))).length, 3);
  await f.manager.close(); assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});

test('real isolated Node process generates the approved sample and verifies matching preview/STL', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const route = await f.manager.addRoute(join(project, 'fixtures/sample-trail.gpx'), { isSample: true });
  const dem = await f.manager.addDem(join(project, 'data/copernicus-longquanshan.tif'), { isSample: true, dataset: 'Copernicus DSM GLO-30' });
  const job = await f.manager.start({ routeId: route.id, demId: dem.id, options: { gridColumns: 65 } });
  await waitFor(() => ['succeeded', 'failed'].includes(f.manager.get(job.id).state));
  const final = f.manager.get(job.id); assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.equal(final.result.dimensions.x, 126); assert.equal(final.result.dimensions.y, 86);
  const preview = await f.manager.preview(job.id); assert.equal(preview.report.dem.source.sha256, preview.report.dem.sha256);
  assert.ok(preview.mesh.faceKinds.includes('route')); assert.ok(preview.mesh.faceKinds.includes('frame'));
  const artifact = await f.manager.artifact(job.id); assert.equal((await readFile(artifact.path)).length, artifact.bytes);
  assert.ok(f.events.some(event => event.progress > 0 && event.progress < 1));
});

test('isolated automatic worker uses frozen bounds, reports measured DEM progress and returns a matching STL', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, coreOverride: root => `
    import { writeFile } from 'node:fs/promises';
    import { loadLocalDem } from ${JSON.stringify(coreModuleUrl)};
    export async function loadCopernicusDem(bounds, options) {
      await writeFile(${JSON.stringify(join(root, 'provider-request.json'))}, JSON.stringify({bounds, cacheDir: options.cacheDir, offlineOnly: options.offlineOnly}));
      options.onProgress({progress: 0.25, message: '已读取 1/4 高程范围'});
      options.onProgress({progress: 0.75, message: '已读取 3/4 高程范围'});
      const dem = await loadLocalDem(${JSON.stringify(join(project, 'data/copernicus-longquanshan.tif'))});
      dem.metadata = {...dem.metadata, provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)', cacheHit: false, tileCount: 1};
      options.onProgress({progress: 1, message: '高程验证完成'});
      return dem;
    }
  `, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const route = await f.manager.addRoute(join(project, 'fixtures/sample-trail.gpx'));
  const options = { gridColumns: 65 }, inspected = await f.manager.inspect({ routeId: route.id, options });
  const job = await f.manager.start({ routeId: route.id, options, offlineOnly: true });
  await waitFor(() => ['succeeded', 'failed'].includes(f.manager.get(job.id).state));
  const final = f.manager.get(job.id); assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'provider-request.json'), 'utf8')),
    { bounds: inspected.bounds, cacheDir: join(f.root, 'elevation-cache'), offlineOnly: true });
  for (const expected of [0.195, 0.305, 0.36]) assert.ok(f.events.some(event => Math.abs(event.progress - expected) < 1e-12));
  assert.deepEqual(final.result.demSource, { provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)', cacheHit: false, tileCount: 1 });
  assert.equal(final.result.dimensions.x, 126); assert.equal(final.result.dimensions.y, 86);
  assert.ok((await f.manager.preview(job.id)).mesh.faceKinds.includes('route'));
  assert.equal((await f.manager.artifact(job.id)).stlSha256, final.result.stlSha256);
});

test('automatic worker refuses a core footprint that differs from the frozen manager selection', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, coreOverride: () => `
    export async function generatePrintableTerrain(request) { return request.loadDem({west: 0, south: 0, east: 1, north: 1}, {}); }
    export async function loadCopernicusDem() { throw new Error('provider must not be reached'); }
  `, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const job = await f.manager.start({ routeId: f.route.id, options: {} });
  await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.equal(f.manager.get(job.id).error.code, 'DEM_REQUEST_INVALID');
  assert.match(f.manager.get(job.id).error.message, /取景校验失败/);
  assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});
