import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';
import { checkRuntime } from '../main/runtime-check.mjs';

const project = resolve(import.meta.dirname, '../..'), parent = join(project, 'artifacts/desktop-auto-surface-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const gpx = '<gpx><trk><name>自动地表测试</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
const options = { gridColumns: 33, maxColors: 3, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
const scene = { id: 'S2A_48RWT_20260921_0_L2A', datetime: '2026-09-21T03:27:31Z', cloudCover: 1.5 };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(condition) {
  const until = Date.now() + 30000;
  while (!await condition()) { assert.ok(Date.now() < until, 'Automatic imagery task did not settle'); await delay(10); }
}
class FakeWorker extends EventEmitter {
  postMessage(message) { this.request = message; }
  kill() { queueMicrotask(() => this.emit('exit', 0)); }
}
function rgbTiff() {
  const rgb = Uint8Array.from(Array.from({ length: 64 }, (_, i) => i % 8 < 4 ? [30, 160, 40] : [150, 145, 140]).flat());
  return Buffer.from(writeArrayBuffer(rgb, { width: 8, height: 8, SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2,
    ModelPixelScale: [0.02, 0.02, 0], ModelTiepoint: [0, 0, 0, 104.20, 30.65, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1 }));
}
function zipEntries(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), length = bytes.readUInt32LE(offset + 18);
    const names = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28), start = offset + 30 + names + extra;
    const content = bytes.subarray(start, start + length);
    files.set(bytes.toString('utf8', offset + 30, offset + 30 + names), method === 8 ? inflateRawSync(content) : content);
    offset = start + length;
  }
  return files;
}
async function fixture(t, { realWorker = false, cache = true, provider = 'success', timeout = 30000, workerTransform = value => value } = {}) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')), profile = join(root, 'profile');
  const routePath = join(root, '路线.gpx'), imagePath = join(root, '本地地表.tif'), marker = join(root, 'provider.json');
  await Promise.all([mkdir(profile), writeFile(routePath, gpx), writeFile(imagePath, rgbTiff())]);
  // Only the network boundary is controlled; classification, generation, publication and export remain real.
  const controlledCore = join(root, 'network-fixture.mjs');
  await writeFile(controlledCore, `export * from ${JSON.stringify(coreModuleUrl)};
import { loadColorGeoTiff } from ${JSON.stringify(coreModuleUrl)};
import { writeFile } from 'node:fs/promises';
export async function loadSentinelColorImage(bounds, config) {
  await writeFile(${JSON.stringify(marker)}, JSON.stringify({ bounds, cacheDir: config.cacheDir, offlineOnly: config.offlineOnly, lookbackMonths: config.lookbackMonths, signal: config.signal instanceof AbortSignal }));
  config.onProgress?.({ progress: 0.4, message: '正在筛除云层并获取 Sentinel-2 影像' });
  if (${JSON.stringify(provider)} === 'failure') throw Object.assign(new Error('取景内影像云层遮挡，请重试或切换本地导入'), { code: 'IMAGE_CLOUD_COVERAGE' });
  if (${JSON.stringify(provider)} === 'other-error') throw Object.assign(new Error('上次高程文件已改变，请重新选择'), { code: 'SESSION_INPUT_CHANGED' });
  if (${JSON.stringify(provider)} === 'slow') await new Promise(done => setTimeout(done, 5000));
  return { image: await loadColorGeoTiff(${JSON.stringify(imagePath)}), source: { provider: 'Sentinel-2', collection: 'sentinel-2-c1-l2a', scenes: [${JSON.stringify(scene)}], attribution: 'Contains modified Copernicus Sentinel data 2026', cacheHit: config.offlineOnly === true, retrievedAt: '2026-10-10T12:00:00Z', bounds: ${JSON.stringify(provider)} === 'wrong-bounds' ? { ...bounds, west: bounds.west - 1 } : bounds } };
}
`);
  const workers = [], managers = [], stores = [];
  const fresh = () => {
    const manager = createDesktopManager({ taskRoot: join(root, `tasks-${managers.length}`),
      coreModuleUrl: pathToFileURL(controlledCore).href, jobTimeoutMs: timeout,
      ...(cache ? { imageCacheDir: join(profile, 'surface-cache') } : {}),
      workerFactory: ({ workerPath }) => {
        if (!realWorker) { const child = new FakeWorker(); workers.push(child); return child; }
        const child = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(child);
        return { on: (...args) => child.on(...args), once: (...args) => child.once(...args), postMessage: value => child.send(workerTransform(value)), kill: () => child.kill() };
      } });
    const store = createSessionStore({ userDataDirectory: profile, manager });
    managers.push(manager); stores.push(store); return { manager, store };
  };
  t.after(async () => {
    for (const worker of workers) { if (worker instanceof FakeWorker) worker.emit('exit', 0); else if (worker.exitCode === null) worker.kill(); }
    await Promise.all(stores.map(store => store.close())); await Promise.all(managers.map(manager => manager.close()));
    assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true });
  });
  const first = fresh(), route = await first.manager.addRoute(routePath);
  const dem = await first.manager.addDem(join(project, 'data/copernicus-longquanshan.tif'));
  return { root, profile, marker, imagePath, route, dem, workers, fresh, ...first,
    request: { routeId: route.id, demId: dem.id, demMode: 'local', options } };
}
async function settled(manager, id) {
  await waitFor(() => !['running', 'cancelling'].includes(manager.get(id).state)); return manager.get(id);
}

test('automatic imagery uses main-computed bounds and cache while ignoring any local image id', async t => {
  const f = await fixture(t), inspection = await f.manager.inspect({ routeId: f.route.id, options });
  const job = await f.manager.start({ ...f.request, imageMode: 'auto', imageId: 'stale-local-image',
    imageCacheDir: 'renderer-path', bounds: { west: -10, south: -10, east: 10, north: 10 }, imageUrl: 'https://example.org/image' });
  assert.equal(job.imageMode, 'auto'); assert.equal(job.imageId, undefined);
  assert.equal(job.imageLookbackMonths, 24);
  const request = f.workers[0].request;
  assert.equal(request.imageMode, 'auto'); assert.equal(request.imageCacheDir, join(f.profile, 'surface-cache'));
  assert.equal(request.imageLookbackMonths, 24);
  assert.deepEqual(request.bounds, inspection.bounds); assert.equal(request.imagePath, undefined); assert.equal(request.imageSha256, undefined);
  assert.equal(request.imageUrl, undefined); assert.equal(request.options.maxColors, undefined);
  assert.equal(request.appearanceOptions.maxColors, 3);
});

test('automatic imagery without a configured cache fails before starting a worker', async t => {
  const f = await fixture(t, { cache: false });
  await assert.rejects(f.manager.start({ ...f.request, imageMode: 'auto' }), error => error.code === 'IMAGE_CACHE_UNAVAILABLE' && /重试|本地/.test(error.message));
  assert.equal(f.workers.length, 0);
});

test('undefined imagery mode keeps legacy local and uniform requests without network acquisition', async t => {
  const f = await fixture(t), job = await f.manager.start(f.request);
  assert.equal(job.imageMode, 'local'); assert.equal(f.workers[0].request.imageMode, 'local');
  assert.equal(f.workers[0].request.imageCacheDir, undefined);
});

test('invalid imagery mode or cache configuration is rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.start({ ...f.request, imageMode: 'remote' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => createDesktopManager({ taskRoot: f.root, coreModuleUrl, imageCacheDir: '', workerFactory() {} }), { code: 'CONFIG_INVALID' });
});

for (const imageLookbackMonths of [12, 24]) {
  test(`${imageLookbackMonths}-month automatic imagery reaches the real worker provider`, async t => {
    const f = await fixture(t, { realWorker: true });
    const job = await f.manager.start({ ...f.request, imageMode: 'auto', imageLookbackMonths });
    assert.equal(job.imageLookbackMonths, imageLookbackMonths);
    const completed = await settled(f.manager, job.id);
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed.error));
    assert.equal(JSON.parse(await readFile(f.marker, 'utf8')).lookbackMonths, imageLookbackMonths);
  });
}

test('unsupported supplied imagery periods fail before launching a worker', async t => {
  const f = await fixture(t);
  for (const imageMode of ['auto', 'local', 'none']) {
    for (const imageLookbackMonths of [0, 6, 36, '12', null]) {
      await assert.rejects(f.manager.start({ ...f.request, imageMode, imageLookbackMonths }), { code: 'CONFIG_INVALID' });
    }
  }
  assert.equal(f.workers.length, 0);
});

test('real automatic worker independently rejects an unsupported period before acquisition', async t => {
  const f = await fixture(t, { realWorker: true, workerTransform: value => ({ ...value, imageLookbackMonths: 36 }) });
  const job = await f.manager.start({ ...f.request, imageMode: 'auto' }), failed = await settled(f.manager, job.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'IMAGE_REQUEST_INVALID');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('real legacy automatic worker defaults an omitted period to 24 months', async t => {
  const f = await fixture(t, { realWorker: true, workerTransform: value => {
    const { imageLookbackMonths, ...legacy } = value; return legacy;
  } });
  const job = await f.manager.start({ ...f.request, imageMode: 'auto' }), completed = await settled(f.manager, job.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.error));
  assert.equal(JSON.parse(await readFile(f.marker, 'utf8')).lookbackMonths, 24);
});

test('none imagery generates uniform appearance without cache or stale local sources', async t => {
  const f = await fixture(t, { realWorker: true, cache: false, workerTransform: value => ({ ...value,
    imagePath: join(parent, 'missing-stale-image.tif'), imageSha256: 'stale' }) });
  const job = await f.manager.start({ ...f.request, imageMode: 'none', imageId: 'stale-image', imageLookbackMonths: 12 });
  assert.equal(job.imageMode, 'none'); assert.equal(job.imageId, undefined); assert.equal(job.imageLookbackMonths, 12);
  const completed = await settled(f.manager, job.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.error));
  const preview = await f.manager.preview(job.id);
  assert.equal(preview.appearance.classification, 'uniform'); assert.equal(preview.report.imageSource, undefined);
  assert.equal(completed.result.imageSource, undefined); assert.equal(completed.acquisition.image, undefined);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  for (const format of ['3mf', 'obj']) {
    const exported = await f.manager.exportModel(job.id, format);
    const manifest = JSON.parse(zipEntries(exported.bytes).get(format === '3mf' ? 'Metadata/manifest.json' : 'manifest.json'));
    assert.equal(manifest.metadata.imageSource, undefined); assert.equal(manifest.appearance.classification, 'uniform');
  }
});

test('real automatic worker publishes provenance and keeps it in recolored 3MF and OBJ manifests', async t => {
  const f = await fixture(t, { realWorker: true }), image = await f.manager.addImage(f.imagePath);
  const job = await f.manager.start({ ...f.request, imageMode: 'auto', imageId: image.id, offlineOnly: true });
  const completed = await settled(f.manager, job.id); assert.equal(completed.state, 'succeeded', JSON.stringify(completed.error));
  const preview = await f.manager.preview(job.id), source = completed.result.imageSource;
  assert.equal(preview.appearance.classification, 'rgb-greenness'); assert.equal(preview.appearance.palette.length, 3);
  assert.ok(source, 'Successful automatic imagery must disclose its source');
  assert.deepEqual(source.scenes, [scene]); assert.equal(source.provider, 'Sentinel-2'); assert.equal(source.cacheHit, false);
  assert.equal(source.attribution, 'Contains modified Copernicus Sentinel data 2026');
  assert.deepEqual(preview.report.imageSource, source);
  const acquisition = JSON.parse(await readFile(f.marker, 'utf8'));
  assert.equal(acquisition.cacheDir, join(f.profile, 'surface-cache')); assert.equal(acquisition.offlineOnly, false);
  assert.equal(acquisition.signal, true); assert.deepEqual(acquisition.bounds, source.bounds);
  for (const format of ['3mf', 'obj']) {
    const exported = await f.manager.exportModel(job.id, format, { ...options, maxColors: 2, routeColor: '#ff6600' });
    const files = zipEntries(exported.bytes), manifest = JSON.parse(files.get(format === '3mf' ? 'Metadata/manifest.json' : 'manifest.json'));
    assert.deepEqual(manifest.metadata.imageSource, source); assert.equal(manifest.appearance.palette.length, 2);
  }
  assert.deepEqual((await f.manager.preview(job.id)).appearance, preview.appearance);
});

test('automatic worker source for a different footprint is never accepted as a successful model', async t => {
  const f = await fixture(t, { realWorker: true, provider: 'wrong-bounds' });
  const job = await f.manager.start({ ...f.request, imageMode: 'auto' }), result = await settled(f.manager, job.id);
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'OUTPUT_INVALID');
  await assert.rejects(f.manager.preview(job.id), { code: 'RESULT_UNAVAILABLE' });
  assert.deepEqual(await readdir(join(f.root, 'tasks-0')), []);
});

test('automatic acquisition failure leaves no partial result and allows retry in local mode', async t => {
  const f = await fixture(t, { realWorker: true, provider: 'failure' });
  const job = await f.manager.start({ ...f.request, imageMode: 'auto' }), failed = await settled(f.manager, job.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'IMAGE_CLOUD_COVERAGE'); assert.match(failed.error.message, /重试.*本地/);
  await assert.rejects(f.manager.preview(job.id), { code: 'RESULT_UNAVAILABLE' });
  assert.deepEqual(await readdir(join(f.root, 'tasks-0')), []);
  const retry = await f.manager.start({ ...f.request, imageMode: 'local' });
  assert.equal((await settled(f.manager, retry.id)).state, 'succeeded');
  assert.equal((await f.manager.preview(retry.id)).appearance.classification, 'uniform');
});

test('unrelated validated source errors keep their code rather than suggesting automatic imagery fallback', async t => {
  const f = await fixture(t, { realWorker: true, provider: 'other-error' });
  const job = await f.manager.start({ ...f.request, imageMode: 'auto' }), failed = await settled(f.manager, job.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'SESSION_INPUT_CHANGED');
  assert.match(failed.error.message, /高程.*改变/); assert.ok(!failed.error.message.includes('RGB'));
});

for (const action of ['cancel', 'timeout']) {
  test(`${action} during imagery acquisition cannot publish a model and removes the task directory`, async t => {
    const f = await fixture(t, { realWorker: true, provider: 'slow', timeout: action === 'timeout' ? 1200 : 30000 });
    const job = await f.manager.start({ ...f.request, imageMode: 'auto' });
    await waitFor(async () => readFile(f.marker).then(() => true, () => false));
    if (action === 'cancel') f.manager.cancel(job.id);
    const result = await settled(f.manager, job.id);
    assert.equal(result.state, action === 'cancel' ? 'cancelled' : 'failed');
    if (action === 'timeout') assert.equal(result.error.code, 'JOB_TIMEOUT');
    await assert.rejects(f.manager.preview(job.id), { code: 'RESULT_UNAVAILABLE' });
    assert.deepEqual(await readdir(join(f.root, 'tasks-0')), []);
  });
}

test('fresh sessions default to automatic imagery and save its mode without stale local descriptors', async t => {
  const f = await fixture(t); assert.equal((await f.store.getSession()).preferences.imageMode, 'auto');
  assert.equal((await f.store.getSession()).preferences.imageLookbackMonths, 24);
  await f.store.saveSession({ ...f.request, imageMode: 'auto', imageId: 'stale-id', offlineOnly: false });
  const stored = JSON.parse(await readFile(join(f.profile, 'session-v1.json'), 'utf8'));
  assert.equal(stored.preferences.imageMode, 'auto'); assert.equal(stored.recentProject.imageMode, 'auto'); assert.equal(stored.recentProject.image, undefined);
  assert.equal(stored.preferences.imageLookbackMonths, 24); assert.equal(stored.recentProject.imageLookbackMonths, 24);
  const restored = await f.fresh().store.restoreSession(); assert.equal(restored.imageMode, 'auto'); assert.equal(restored.image, undefined); assert.ok(restored.route);
  assert.equal((await f.fresh().store.getSession()).recentProject.imageMode, 'auto');
});

for (const [imageMode, imageLookbackMonths] of [['auto', 12], ['auto', 24], ['none', 12], ['none', 24]]) {
  test(`${imageMode} imagery and ${imageLookbackMonths}-month period survive startup and project recovery`, async t => {
    const f = await fixture(t);
    await f.store.saveSession({ ...f.request, imageMode, imageLookbackMonths, imageId: 'stale-id', offlineOnly: false });
    const stored = JSON.parse(await readFile(join(f.profile, 'session-v1.json'), 'utf8'));
    for (const settings of [stored.preferences, stored.recentProject]) {
      assert.equal(settings.imageMode, imageMode); assert.equal(settings.imageLookbackMonths, imageLookbackMonths);
    }
    assert.equal(stored.recentProject.image, undefined);
    const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
    assert.equal(startup.preferences.imageLookbackMonths, imageLookbackMonths);
    assert.equal(startup.recentProject.imageMode, imageMode); assert.equal(startup.recentProject.imageLookbackMonths, imageLookbackMonths);
    assert.equal(restored.imageMode, imageMode); assert.equal(restored.imageLookbackMonths, imageLookbackMonths);
    assert.equal(restored.image, undefined); assert.ok(restored.route); assert.deepEqual(restored.warnings, []);
  });
}

test('none imagery ignores stale descriptors in a saved project', async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, imageMode: 'none', imageLookbackMonths: 12, offlineOnly: false });
  const sessionPath = join(f.profile, 'session-v1.json'), stored = JSON.parse(await readFile(sessionPath, 'utf8'));
  stored.recentProject.image = { path: 'missing-and-invalid.tif' }; await writeFile(sessionPath, JSON.stringify(stored));
  const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
  assert.equal(startup.recentProject.imageFileName, undefined); assert.equal(startup.recentProject.imageMode, 'none');
  assert.equal(restored.image, undefined); assert.ok(restored.route); assert.deepEqual(restored.warnings, []);
});

test('invalid supplied session periods do not replace the last saved project', async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, imageMode: 'auto', offlineOnly: false });
  const sessionPath = join(f.profile, 'session-v1.json'), before = await readFile(sessionPath);
  for (const imageLookbackMonths of [0, 6, 36, '12', null]) {
    await assert.rejects(f.store.saveSession({ ...f.request, imageMode: 'auto', imageLookbackMonths, offlineOnly: false }), { code: 'CONFIG_INVALID' });
  }
  assert.deepEqual(await readFile(sessionPath), before);
});

for (const field of ['preferences', 'recentProject']) {
  test(`unsupported saved period invalidates ${field} while preserving the other record`, async t => {
    const f = await fixture(t);
    await f.store.saveSession({ ...f.request, imageMode: 'auto', imageLookbackMonths: 12, offlineOnly: false });
    const sessionPath = join(f.profile, 'session-v1.json'), stored = JSON.parse(await readFile(sessionPath, 'utf8'));
    stored[field].imageLookbackMonths = 36; await writeFile(sessionPath, JSON.stringify(stored));
    const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
    assert.ok(startup.warnings.length > 0);
    assert.equal(startup.preferences.imageLookbackMonths, field === 'preferences' ? 24 : 12);
    assert.equal(restored.imageLookbackMonths, 12);
    assert.equal(Boolean(restored.route), field === 'preferences');
    if (field === 'preferences') assert.equal(startup.recentProject.imageLookbackMonths, 12);
    else assert.equal(startup.recentProject, undefined);
  });
}

test('local imagery mode survives session recovery and legacy image descriptors infer local mode', async t => {
  const f = await fixture(t), image = await f.manager.addImage(f.imagePath);
  await f.store.saveSession({ ...f.request, imageMode: 'local', imageId: image.id, offlineOnly: true });
  const restored = await f.fresh().store.restoreSession(); assert.equal(restored.imageMode, 'local'); assert.ok(restored.image);
  const sessionPath = join(f.profile, 'session-v1.json'), stored = JSON.parse(await readFile(sessionPath, 'utf8'));
  delete stored.preferences.imageMode; delete stored.recentProject.imageMode;
  delete stored.preferences.imageLookbackMonths; delete stored.recentProject.imageLookbackMonths; await writeFile(sessionPath, JSON.stringify(stored));
  const legacy = f.fresh(); assert.equal((await legacy.store.getSession()).preferences.imageMode, 'local');
  const recovered = await legacy.store.restoreSession(); assert.equal(recovered.imageMode, 'local'); assert.ok(recovered.image);
  assert.equal(recovered.imageLookbackMonths, 24);
});

test('legacy no-image sessions infer automatic imagery without changing saved files', async t => {
  const f = await fixture(t); await f.store.saveSession({ ...f.request, offlineOnly: false });
  const sessionPath = join(f.profile, 'session-v1.json'), stored = JSON.parse(await readFile(sessionPath, 'utf8'));
  delete stored.preferences.imageMode; delete stored.recentProject.imageMode;
  delete stored.preferences.imageLookbackMonths; delete stored.recentProject.imageLookbackMonths; await writeFile(sessionPath, JSON.stringify(stored));
  const before = await readFile(sessionPath), next = f.fresh(), restored = await next.store.restoreSession();
  assert.equal(restored.imageMode, 'auto'); assert.equal(restored.image, undefined); assert.deepEqual(await readFile(sessionPath), before);
  assert.equal(restored.imageLookbackMonths, 24);
});

test('packaged runtime automatic-image check records scene dates and byte-identical offline reuse', async t => {
  const f = await fixture(t, { realWorker: true });
  const runStart = f.manager.start;
  // Runtime geometry is deliberately smaller while every model and export check remains real.
  f.manager.start = request => runStart({ ...request, options: { ...request.options, gridColumns: 33 } });
  const report = await checkRuntime({ app: { isPackaged: true, getAppPath: () => project }, manager: f.manager,
    routePath: join(f.root, '路线.gpx'), demPath: join(project, 'data/copernicus-longquanshan.tif'),
    destination: join(f.root, 'runtime-evidence'), imageMode: 'auto' });
  assert.equal(report.passed, true); assert.ok(report.automaticSurface, 'Auto runtime check needs dedicated provenance and cache evidence');
  assert.equal(report.automaticSurface.source.provider, 'Sentinel-2'); assert.deepEqual(report.automaticSurface.source.scenes, [scene]);
  assert.equal(report.automaticSurface.offlineSource.cacheHit, true);
  assert.equal(report.automaticSurface.byteIdentical, true); assert.equal(report.automaticSurface.appearanceIdentical, true);
  assert.equal(report.color.classification, 'rgb-greenness');
  const stored = JSON.parse(await readFile(join(f.root, 'runtime-evidence/runtime-check.json'), 'utf8'));
  assert.deepEqual(stored.automaticSurface, report.automaticSurface);
});

test('packaged runtime none-image check ignores supplied imagery and exports uniform source-free models', async t => {
  const f = await fixture(t, { realWorker: true, cache: false });
  const runStart = f.manager.start;
  f.manager.start = request => runStart({ ...request, options: { ...request.options, gridColumns: 33 } });
  const report = await checkRuntime({ app: { isPackaged: true, getAppPath: () => project }, manager: f.manager,
    routePath: join(f.root, '路线.gpx'), demPath: join(project, 'data/copernicus-longquanshan.tif'),
    imagePath: join(f.root, 'missing-ignored-image.tif'), destination: join(f.root, 'runtime-none-evidence'), imageMode: 'none' });
  assert.equal(report.passed, true); assert.equal(report.inputs.imageMode, 'none'); assert.equal(report.inputs.imagePath, undefined);
  assert.equal(report.color.classification, 'uniform'); assert.equal(report.color.imageSha256, undefined);
  assert.equal(report.job.imageMode, 'none'); assert.equal(report.job.result.imageSource, undefined);
  assert.equal(report.automaticSurface, undefined); await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  assert.equal(report.color.formats.length, 2);
  for (const exported of report.color.formats) {
    const files = zipEntries(await readFile(exported.path));
    const manifest = JSON.parse(files.get(exported.format === '3mf' ? 'Metadata/manifest.json' : 'manifest.json'));
    assert.equal(manifest.appearance.classification, 'uniform'); assert.equal(manifest.appearance.source, undefined);
    assert.equal(manifest.metadata.imageSource, undefined);
  }
  const stored = JSON.parse(await readFile(join(f.root, 'runtime-none-evidence/runtime-check.json'), 'utf8'));
  assert.equal(stored.inputs.imageMode, 'none'); assert.equal(stored.inputs.imagePath, undefined); assert.equal(stored.color.classification, 'uniform');
});
