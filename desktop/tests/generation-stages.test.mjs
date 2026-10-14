import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';

const project = resolve(import.meta.dirname, '../..'), parent = join(project, 'artifacts/generation-stage-tests');
const coreUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const gpx = '<gpx><trk><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(condition, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!await condition()) { assert.ok(Date.now() < until, 'Stage task did not settle'); await delay(5); }
}
class FakeWorker extends EventEmitter {
  postMessage(message) { this.request = message; }
  send(message) { this.emit('message', { ...message, jobId: this.request.jobId }); }
  kill() { queueMicrotask(() => this.emit('exit', 0)); }
}
async function fixture(t, { real = false, behavior = 'barrier', phaseTimeoutMs, jobTimeoutMs, modelOptions = {} } = {}) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')), tasks = join(root, 'tasks'), events = [], workers = [];
  const routePath = join(root, 'route.gpx'), imagePath = join(root, 'rgb.tif'), controlledCore = join(root, 'core.mjs');
  await writeFile(routePath, gpx);
  await writeFile(imagePath, Buffer.from(writeArrayBuffer(Uint8Array.from({ length: 8 * 8 * 3 }, (_, i) => i % 3 === 1 ? 150 : 40), {
    width: 8, height: 8, SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2,
    ModelPixelScale: [0.02, 0.02, 0], ModelTiepoint: [0, 0, 0, 104.20, 30.65, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1,
  })));
  await writeFile(controlledCore, `export * from ${JSON.stringify(coreUrl)};
import { loadLocalDem, loadColorGeoTiff } from ${JSON.stringify(coreUrl)};
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)}, behavior = ${JSON.stringify(behavior)};
const delay = ms => new Promise(done => setTimeout(done, ms));
const marker = name => writeFileSync(root + '/' + name, '1');
async function pending(branch, signal) {
  return new Promise((resolve, reject) => {
    const aborted = async () => {
      marker(branch + '-aborted');
      if (behavior === 'image-failure-cleanup') { await delay(100); marker(branch + '-cleaned'); }
      reject(signal.reason);
    };
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  });
}
export async function loadCopernicusDem(bounds, config) {
  if (config.offlineOnly) throw Object.assign(new Error('此取景尚无高程缓存'), { code: 'DEM_CACHE_MISS' });
  appendFileSync(root + '/dem-calls', '1'); marker('dem-start');
  config.onProgress?.({ progress: 0.4, message: '高程读取中' });
  if (behavior.startsWith('image-failure') || behavior === 'pending') return pending('dem', config.signal);
  if (behavior === 'dem-failure') { await delay(40); throw Object.assign(new Error('高程失败'), { code: 'DEM_TEST_FAILURE' }); }
  return loadLocalDem(${JSON.stringify(join(project, 'data/copernicus-longquanshan.tif'))});
}
export async function loadSentinelColorImage(bounds, config) {
  if (config.offlineOnly) throw Object.assign(new Error('此取景尚无影像缓存'), { code: 'IMAGE_CACHE_MISS' });
  marker('image-start');
  config.onProgress?.({ progress: 0.4, message: '影像读取中', stage: 'download', downloadedBytes: 4096, cacheBytes: 1024, requestCount: 2, coverage: 0.75 });
  if (behavior === 'dem-failure' || behavior === 'pending') return pending('image', config.signal);
  if (behavior.startsWith('image-failure')) { await delay(40); throw Object.assign(new Error('影像失败'), { code: 'IMAGE_TEST_FAILURE' }); }
  const until = Date.now() + 250;
  while (!existsSync(root + '/dem-start') && Date.now() < until) await delay(5);
  if (!existsSync(root + '/dem-start')) throw Object.assign(new Error('影像完成前高程未启动'), { code: 'IMAGE_START_BARRIER' });
  marker('image-complete');
  return { image: await loadColorGeoTiff(${JSON.stringify(imagePath)}), source: { provider: 'Sentinel-2', collection: 'sentinel-2-c1-l2a',
    scenes: [{ id: 'S2_stage_test', datetime: '2026-09-21T03:27:31Z', cloudCover: 1 }], cacheHit: false,
    retrievedAt: '2026-10-10T12:00:00Z', bounds } };
}
`);
  const manager = createDesktopManager({ taskRoot: tasks, coreModuleUrl: pathToFileURL(controlledCore).href,
    demCacheDir: join(root, 'dem-cache'), imageCacheDir: join(root, 'image-cache'), onJob: job => events.push(job),
    ...(phaseTimeoutMs === undefined ? {} : { phaseTimeoutMs }), ...(jobTimeoutMs === undefined ? {} : { jobTimeoutMs }),
    workerFactory: ({ workerPath }) => {
      if (!real) { const child = new FakeWorker(); workers.push(child); return child; }
      const child = fork(workerPath, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); workers.push(child);
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('exit', () => assert.equal(stderr, '', 'Worker must not leave unhandled rejections'));
      return { on: (...args) => child.on(...args), once: (...args) => child.once(...args), postMessage: value => child.send(value), kill: () => child.kill() };
    } });
  t.after(async () => {
    for (const worker of workers) worker instanceof FakeWorker ? worker.emit('exit', 0) : worker.exitCode === null && worker.kill();
    await manager.close(); assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true });
  });
  const route = await manager.addRoute(routePath);
  const start = () => manager.start({ routeId: route.id, demMode: 'auto', imageMode: 'auto', options: { gridColumns: 33, ...modelOptions } });
  return { root, tasks, manager, events, workers, start };
}
async function settled(f, id) {
  await waitFor(() => !['running', 'cancelling'].includes(f.manager.get(id).state)); return f.manager.get(id);
}
async function noResult(f, id) {
  await assert.rejects(f.manager.preview(id), { code: 'RESULT_UNAVAILABLE' });
  await assert.rejects(f.manager.artifact(id), { code: 'RESULT_UNAVAILABLE' });
  assert.deepEqual(await readdir(f.tasks), []);
}

test('DEM starts before imagery finishes and the model reuses the acquired DEM exactly once', async t => {
  const f = await fixture(t, { real: true }), job = await f.start(), result = await settled(f, job.id);
  assert.equal(result.state, 'succeeded', JSON.stringify(result.error));
  assert.equal(await readFile(join(f.root, 'dem-calls'), 'utf8'), '1');
  assert.ok(f.events.some(event => event.phase === 'acquire' && event.acquisition?.image?.state === 'running' && event.acquisition?.dem?.state === 'running'));
  const model = f.events.find(event => event.phase === 'model');
  assert.equal(model.acquisition.image.state, 'complete'); assert.equal(model.acquisition.dem.state, 'complete');
  assert.ok(f.events.some(event => event.acquisition?.image?.downloadedBytes === 4096 && event.acquisition.image.coverage === 0.75));
});

for (const failed of ['image', 'dem']) test(`${failed} acquisition failure promptly aborts its peer without a partial savable result`, async t => {
  const f = await fixture(t, { real: true, behavior: `${failed}-failure` }), job = await f.start(), result = await settled(f, job.id);
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, `${failed.toUpperCase()}_TEST_FAILURE`);
  assert.equal(await readFile(join(f.root, `${failed === 'image' ? 'dem' : 'image'}-aborted`), 'utf8'), '1');
  await noResult(f, job.id);
});

test('failure allows the aborted peer to finish cooperative asynchronous cleanup before exiting', async t => {
  const f = await fixture(t, { real: true, behavior: 'image-failure-cleanup' }), job = await f.start(), result = await settled(f, job.id);
  assert.equal(result.error.code, 'IMAGE_TEST_FAILURE');
  assert.equal(await readFile(join(f.root, 'dem-cleaned'), 'utf8'), '1'); await noResult(f, job.id);
});

test('acquisition elapsed time does not consume the modeling timeout', async t => {
  const f = await fixture(t, { phaseTimeoutMs: { prepare: 1000, acquire: 200, model: 100, verify: 100 } }), job = await f.start(), child = f.workers[0];
  child.send({ type: 'progress', phase: 'acquire', progress: 0.1, acquisition: {
    image: { state: 'running', progress: 0.1, message: '影像' }, dem: { state: 'running', progress: 0.1, message: '高程' },
  } });
  await delay(140);
  child.send({ type: 'progress', phase: 'model', progress: 0.4 });
  await delay(60); assert.equal(f.manager.get(job.id).state, 'running');
  assert.equal((await settled(f, job.id)).error.code, 'MODEL_TIMEOUT'); await noResult(f, job.id);
});

test('model timeout in automatic imagery mode has MODEL_TIMEOUT and repeated progress cannot extend it', async t => {
  const f = await fixture(t, { phaseTimeoutMs: { model: 60 } }), job = await f.start(), child = f.workers[0];
  child.send({ type: 'progress', phase: 'model', progress: 0.5 });
  await delay(40); child.send({ type: 'progress', phase: 'model', progress: 0.6 });
  const result = await settled(f, job.id); assert.equal(result.error.code, 'MODEL_TIMEOUT'); await noResult(f, job.id);
});

for (const [image, dem, code] of [['running', 'complete', 'IMAGE_TIMEOUT'], ['complete', 'running', 'DEM_TIMEOUT'], ['running', 'running', 'ACQUISITION_TIMEOUT']]) {
  test(`acquisition timeout reports ${code} according to unfinished branches`, async t => {
    const f = await fixture(t, { phaseTimeoutMs: { acquire: 40 } }), job = await f.start();
    f.workers[0].send({ type: 'progress', phase: 'acquire', progress: 0.2, acquisition: {
      image: { state: image, progress: image === 'complete' ? 1 : 0.2, message: '影像' },
      dem: { state: dem, progress: dem === 'complete' ? 1 : 0.2, message: '高程' },
    } });
    const result = await settled(f, job.id); assert.equal(result.error.code, code); await noResult(f, job.id);
  });
}

test('a completed worker that never exits is bounded by the output verification timeout', async t => {
  const f = await fixture(t, { phaseTimeoutMs: { verify: 40 } }), job = await f.start();
  f.workers[0].send({ type: 'complete' });
  const result = await settled(f, job.id); assert.equal(result.error.code, 'OUTPUT_TIMEOUT'); await noResult(f, job.id);
});

test('manager only exposes validated acquisition metrics and rejects phase rollback', async t => {
  const f = await fixture(t), job = await f.start(), child = f.workers[0];
  child.send({ type: 'progress', phase: 'acquire', progress: 0.2, acquisition: {
    image: { state: 'running', progress: 0.4, message: '影像', downloadedBytes: 4096, cacheBytes: 1024, requestCount: 2, coverage: 0.5 },
    dem: { state: 'running', progress: 0.3, message: '高程', downloadedBytes: -1, cacheBytes: Infinity, requestCount: 1.5, coverage: 2 },
  } });
  const current = f.manager.get(job.id); assert.equal(current.phase, 'acquire'); assert.equal(current.acquisition.image.requestCount, 2);
  for (const field of ['downloadedBytes', 'cacheBytes', 'requestCount', 'coverage']) assert.equal(current.acquisition.dem[field], undefined);
  child.send({ type: 'progress', phase: 'model', progress: 0.4 });
  child.send({ type: 'progress', phase: 'acquire', progress: 0.6 });
  assert.equal(f.manager.get(job.id).phase, 'model');
  f.manager.cancel(job.id); await settled(f, job.id); await noResult(f, job.id);
});

test('cancelled concurrent acquisition cannot become a savable model', async t => {
  const f = await fixture(t, { real: true, behavior: 'pending' }), job = await f.start();
  await waitFor(async () => readFile(join(f.root, 'dem-start')).then(() => true, () => false));
  f.manager.cancel(job.id); assert.equal((await settled(f, job.id)).state, 'cancelled'); await noResult(f, job.id);
});



test('unsupported base text fails before automatic acquisition starts',async t=>{
 const f=await fixture(t,{real:true,modelOptions:{baseText:String.fromCodePoint(0x10ffff)}});
 const initial=await f.start(),job=await settled(f,initial.id);
 assert.equal(job.state,'failed');assert.equal(job.error.code,'CONFIG_BASE_TEXT_GLYPH');
 await assert.rejects(readFile(join(f.root,'dem-start')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.root,'image-start')),{code:'ENOENT'});
});


test('summer diagnostics preserve valid counters but redact unsafe scene paths and invalid retry counts',async t=>{
 const f=await fixture(t),job=await f.start(),child=f.workers[0];
 child.send({type:'progress',phase:'acquire',progress:.2,acquisition:{image:{state:'running',progress:.4,message:'补齐取景',retryCount:2,downloadBudgetBytes:512*1024*1024,reservedBytes:65536,catalogRequestCount:2,rangeRequestCount:8,attemptedScenes:4,sceneContribution:64,sceneId:'S2_SUMMER_A',sceneDate:'2026-07-21'}}});
 const good=f.manager.get(job.id).acquisition.image;
 assert.equal(good.retryCount,2);assert.equal(good.downloadBudgetBytes,512*1024*1024);assert.equal(good.reservedBytes,65536);assert.equal(good.sceneContribution,64);assert.equal(good.sceneId,'S2_SUMMER_A');
 child.send({type:'progress',phase:'acquire',progress:.3,acquisition:{image:{state:'running',progress:.5,message:'补齐取景',retryCount:3,attemptedScenes:121,sceneId:'C:/private/scene',sceneDate:'https://secret.example/'}}});
 const bad=f.manager.get(job.id).acquisition.image;
 for(const field of ['retryCount','attemptedScenes','sceneId','sceneDate'])assert.equal(bad[field],undefined);
 f.manager.cancel(job.id);await settled(f,job.id);
});

test('summer diagnostics retain scene attempts beyond one summer through the five-summer limit', async t => {
  const f = await fixture(t), job = await f.start(), child = f.workers[0];
  for (const attemptedScenes of [25, 120]) {
    child.send({ type: 'progress', phase: 'acquire', progress: .3, acquisition: { image: {
      state: 'running', progress: .4, message: '读取夏季影像', attemptedScenes,
    } } });
    assert.equal(f.manager.get(job.id).acquisition.image.attemptedScenes, attemptedScenes);
  }
  child.send({ type: 'progress', phase: 'acquire', progress: .4, acquisition: { image: {
    state: 'running', progress: .5, message: '无效计数', attemptedScenes: 121,
  } } });
  assert.equal(f.manager.get(job.id).acquisition.image.attemptedScenes, undefined);
  f.manager.cancel(job.id); await settled(f, job.id);
});


test('deselected text skips missing glyph preparation and retains its saved input',async t=>{
 const f=await fixture(t,{real:true,modelOptions:{baseText:'😀',textEnabled:false,routeEnabled:false,grassEnabled:false,rockEnabled:true}});
 const initial=await f.start(),result=await settled(f,initial.id);
 assert.equal(result.state,'succeeded',JSON.stringify(result.error));
 const preview=await f.manager.preview(initial.id);
 assert.equal(preview.report.integratedModel.baseText.text,'');
 assert.equal(preview.report.integratedModel.baseText.effectiveFrameWidthMm,3);
 assert.ok(!preview.mesh.materialParts.some(part=>part.id==='text'||part.id==='route'));
 assert.equal(await readFile(join(f.root,'dem-calls'),'utf8'),'1');
});
