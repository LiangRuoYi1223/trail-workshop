import { app, BrowserWindow, ipcMain, protocol, utilityProcess } from 'electron';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';
import { saveModelFile } from '../main/save-model.mjs';

// Keep the real renderer, IPC, manager, worker, model generation and exports.
// Public acquisition is controlled offline; late failures are injected through core
// exports while keeping the renderer, manager and worker error path intact.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'artifacts', 'auto-surface-check');
const rendererArgument = process.argv.find(value => value.startsWith('--renderer='));
const rendererPath = rendererArgument ? resolve(rendererArgument.slice('--renderer='.length)) : join(root, 'desktop/dist/renderer/index.html');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, `profile-${Date.now()}`));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'terrain-map', privileges: { standard: true, secure: true } }]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const controlPath = join(output, 'provider-control.json');
const providerLog = join(output, 'provider-calls.jsonl');
let window, manager, session, lastJob, lastImage, lastStart;
const starts = [], saves = [], errors = [];

async function run() {
  await app.whenReady();
  protocol.handle('terrain-map', () => new Response(null, { status: 404 }));
  const imagePath = join(output, '验证地表.tif');
  const pixels = new Uint8Array(32 * 32 * 3);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels.set(x < 16 ? [60, 140, 50] : [145, 142, 138], (y * 32 + x) * 3);
  await writeFile(imagePath, Buffer.from(writeArrayBuffer(pixels, { width: 32, height: 32, SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2, PlanarConfiguration: 1,
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, ModelPixelScale: [.08 / 32, .08 / 32, 0], ModelTiepoint: [0, 0, 0, 104.25, 30.61, 0] })));
  await writeFile(providerLog, '');
  const control = async value => writeFile(controlPath, JSON.stringify(value));
  await control({ mode: 'fail', cacheHit: false });
  const coreUrl = pathToFileURL(join(root, 'dist/src/index.js')).href;
  const desktopErrorsUrl = pathToFileURL(join(root, 'desktop/main/files.mjs')).href;
  const providerPath = join(output, 'controlled-provider.mjs');
  await writeFile(providerPath, `export * from ${JSON.stringify(coreUrl)};
export { buildFootprintPolygonMm } from ${JSON.stringify(pathToFileURL(join(root, 'dist/src/vendor/trailprint/footprint.js')).href)};
import { loadColorGeoTiff, loadLocalDem, generatePrintableTerrain as realGenerate, publishTerrainOutput as realPublish } from ${JSON.stringify(coreUrl)};
import { DesktopError } from ${JSON.stringify(desktopErrorsUrl)};
import { readFile, appendFile } from 'node:fs/promises';
const getControl = async () => JSON.parse(await readFile(${JSON.stringify(controlPath)}, 'utf8'));
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('cancelled')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
});
export async function loadSentinelColorImage(bounds, options) {
  const control = await getControl();
  await appendFile(${JSON.stringify(providerLog)}, JSON.stringify({ bounds, mode: control.mode, lookbackMonths: options.lookbackMonths }) + '\\n');
  if (control.mode === 'fail') throw Object.assign(new Error('网络不可用，自动地表影像获取失败。请重试或切换本地导入。'), { code: 'IMAGE_NETWORK' });
  if (control.mode === 'other-error') throw Object.assign(new Error('验证输入已改变，请重新选择。'), { code: 'SESSION_INPUT_CHANGED' });
  if (control.mode === 'image-timeout') throw Object.assign(new Error('影像获取超时，请重试或切换本地导入。'), { code: 'IMAGE_TIMEOUT' });
  if (control.mode === 'slow') { options.onProgress?.({ progress: .1, message: '正在获取地表影像' }); await new Promise(resolve => setTimeout(resolve, 30000)); }
  if (control.mode === 'parallel') {
    options.onProgress?.({ stage: 'query', progress: .04, message: '正在检查候选 2 / 24', downloadedBytes: 0, cacheBytes: 0, requestCount: 1 });
    await pause(2000, options.signal);
    options.onProgress?.({ stage: 'download', progress: .4, message: '正在筛除云层', downloadedBytes: 1572864, cacheBytes: 524288, requestCount: 3, coverage: .875 });
    await pause(2500, options.signal);
    options.onProgress?.({ stage: 'complete', progress: 1, message: '影像已就绪', downloadedBytes: 1572864, cacheBytes: 524288, requestCount: 3, coverage: 1 });
  }
  return { image: await loadColorGeoTiff(${JSON.stringify(imagePath)}), source: { provider: 'Sentinel-2', collection: 'sentinel-2-c1-l2a',
    scenes: [{ id: 'S2_UI_SCENE_A', datetime: '2026-09-21T03:17:00Z', cloudCover: 4 }, { id: 'S2_UI_SCENE_B', datetime: '2026-09-26T03:18:00Z', cloudCover: 8 }],
    cacheHit: control.cacheHit, retrievedAt: '2026-10-11T12:00:00Z', attribution: 'Contains modified Copernicus Sentinel data 2026', bounds } };
}
export async function loadCopernicusDem(bounds, options) {
  options.onProgress?.({ progress: .2, message: '正在读取高程缓存', downloadedBytes: 0, cacheBytes: 1048576, coverage: .5 });
  await pause(700, options.signal);
  const dem = await loadLocalDem(${JSON.stringify(join(root, 'data/copernicus-longquanshan.tif'))});
  options.onProgress?.({ progress: 1, message: '高程已就绪', downloadedBytes: 0, cacheBytes: 2097152, coverage: 1 });
  return dem;
}
export async function generatePrintableTerrain(request) {
  const control = await getControl();
  if (control.failureCode && control.failureCode !== 'OUTPUT_TIMEOUT') throw new DesktopError(control.failureCode, '验证用生成超时，请重新生成。');
  return realGenerate(request);
}
export async function publishTerrainOutput(...args) {
  const control = await getControl();
  if (control.failureCode === 'OUTPUT_TIMEOUT') throw new DesktopError('OUTPUT_TIMEOUT', '验证用模型核验超时，请重新生成。');
  return realPublish(...args);
}
`);
  manager = createDesktopManager({ taskRoot: join(output, 'tasks'), imageCacheDir: join(output, 'image-cache'), demCacheDir: join(output, 'dem-cache'), coreModuleUrl: pathToFileURL(providerPath).href,
    workerFactory: ({ workerPath, taskDir }) => { const child = utilityProcess.fork(workerPath, [], { cwd: taskDir, stdio: 'pipe' }); child.stderr?.on('data', chunk => console.error(chunk.toString())); return child; },
    onJob: job => { lastJob = job; window?.webContents.send('terrain:job', job); } });
  session = createSessionStore({ userDataDirectory: app.getPath('userData'), manager });
  const handle = (name, operation) => ipcMain.handle(`terrain:${name}`, async (_event, ...args) => {
    try { return { ok: true, value: await operation(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code ?? 'TEST', message: error.message } }; }
  });
  handle('runtime', () => ({ version: '0.4.3', platform: 'win32', packaged: false, units: 'mm' }));
  handle('cache-info', () => ({ path: output, elevationBytes: 0, mapBytes: 0, imageBytes: 1024 * 1024 }));
  handle('session-get', () => session.getSession()); handle('session-save', request => session.saveSession(request)); handle('session-restore', () => session.restoreSession());
  handle('choose-route', () => manager.addRoute(join(root, 'fixtures/sample-trail.gpx')));
  handle('choose-dem', () => manager.addDem(join(root, 'data/copernicus-longquanshan.tif')));
  handle('choose-image', async () => lastImage = await manager.addImage(imagePath)); handle('remove-image', id => manager.removeImage(id));
  handle('inspect', request => manager.inspect(request));
  handle('start', request => { lastStart = structuredClone(request); starts.push(lastStart); return manager.start(request); });
  handle('get', id => manager.get(id)); handle('preview', id => manager.preview(id)); handle('cancel', id => manager.cancel(id));
  handle('save-model', async request => {
    const artifact = await manager.exportModel(request.id, request.format, request.options);
    const saved = await saveModelFile(artifact.bytes, join(output, `自动影像-${saves.length + 1}${artifact.extension}`), { overwriteApproved: true });
    saves.push({ format: request.format, ...saved }); return { cancelled: false, ...saved };
  });
  window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { preload: join(root, 'desktop/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
  window.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('terrain-map')) errors.push(event.message); });
  await window.loadFile(rendererPath);
  const js = async source => { try { return await window.webContents.executeJavaScript(source); } catch (error) { throw new Error(`${error.message}\nRenderer operation: ${source}\nConsole: ${JSON.stringify(errors)}`, { cause: error }); } };
  const wait = async (predicate, label) => { const until = Date.now() + 45000; while (Date.now() < until) { if (await predicate()) return; await delay(50); } throw Error(`Timed out: ${label}; ${await js("document.querySelector('.task-error')?.textContent ?? ''")}`); };
  const ready = label => js(`[...document.querySelectorAll('button')].some(el => el.textContent === ${JSON.stringify(label)} && !el.disabled)`);
  const click = label => js(`(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(label)}); if (!el || el.disabled) throw Error('Button unavailable'); el.click(); })()`);
  const select = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Select missing'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const capture = async name => { await delay(150); await writeFile(join(output, name), (await window.webContents.capturePage()).toPNG()); };
  const calls = async () => (await readFile(providerLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const footerVisible = () => js(`(() => {
    const elements = [...document.querySelectorAll('.task-footer .status-line, .task-footer .task-error, .task-footer button, .acquisition-row')];
    return elements.length > 0 && elements.every(el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; });
  })()`);
  let finishedJobId;
  const finishGeneration = async label => { await wait(() => lastJob && lastJob.id !== finishedJobId && !['running', 'cancelling'].includes(lastJob.state), label); finishedJobId = lastJob.id; };

  await wait(() => ready('导入路线'), 'startup');
  assert.deepEqual(await js("[...document.querySelector('#image-mode').options].map(option => option.textContent)"), ['不使用', '12个月', '24个月', '本地导入']);
  assert.equal(await js("document.querySelector('#image-mode')?.value ?? null"), '24', 'fresh startup preserves the existing 24-month imagery horizon');
  assert.equal(await ready('选择地表影像'), false, 'local image picker must be available only in local mode');
  await click('导入路线'); await wait(() => ready('生成模型'), 'route imported');
  await select('.dem-mode select', 'local'); await wait(() => ready('选择高程'), 'local elevation selected'); await click('选择高程'); await wait(() => ready('生成模型'), 'elevation imported');
  await js("(() => { document.querySelector('.map-basemap input').click(); const el = [...document.querySelectorAll('input')].find(input => input.labels?.[0]?.textContent === '中心纬度'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '30.568'); el.dispatchEvent(new Event('input', {bubbles:true})); })();");
  await wait(() => ready('生成模型'), 'framing complete');
  assert.equal((await calls()).length, 0, 'map framing must not acquire surface imagery');
  await click('生成模型'); await finishGeneration('controlled acquisition failure');
  assert.equal(lastStart.imageMode, 'auto'); assert.equal(lastStart.imageId, undefined); assert.equal(lastJob.state, 'failed'); assert.equal(lastJob.error.code, 'IMAGE_NETWORK');
  assert.equal(lastStart.imageLookbackMonths, 24); assert.equal((await calls()).at(-1).lookbackMonths, 24);
  await wait(async () => await ready('重试获取') && await ready('切换本地导入'), 'automatic failure actions');
  assert.equal(await ready('保存彩色 3MF'), false, 'failed imagery must not publish a saveable model');
  await capture('01-image-failure.png');
  window.setSize(960, 720); await delay(150); await capture('01b-small-window-failure.png');
  assert.equal(await js("[...document.querySelectorAll('.image-recovery-actions button')].every(el => { const rect = el.getBoundingClientRect(); return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })"), true, 'failure actions must remain visible in a small window');
  window.setSize(1280, 1000);
  await control({ mode: 'success', cacheHit: false }); await click('重试获取'); await finishGeneration('retry success');
  assert.equal(lastJob.state, 'succeeded', lastJob.error?.message); await wait(() => ready('保存彩色 3MF'), 'automatic model ready');
  const preview = await manager.preview(lastJob.id);
  assert.equal(preview.report.imageSource.provider, 'Sentinel-2'); assert.equal(preview.appearance.classification, 'rgb-greenness');
  const displayed = await js("document.querySelector('.model-image-source')?.textContent ?? ''");
  assert.match(displayed, /Sentinel-2/); assert.match(displayed, /2026-09-21/); assert.match(displayed, /2026-09-26/); assert.match(displayed, /在线获取/);
  await click('保存彩色 3MF'); await wait(() => saves.length === 1 && ready('保存彩色 3MF'), 'automatic color export');
  await js("(() => { const el = document.querySelector('#grass-color'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '#005522'); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })();");
  assert.equal(await ready('保存彩色 3MF'), true, 'palette edits must keep geometry exportable');
  assert.equal(await js("!!document.querySelector('.saved-path')"), false);
  await capture('02-auto-source.png');
  await select('#image-mode', '12'); await wait(() => ready('重新生成'), '12-month source selected');
  assert.equal(await ready('保存彩色 3MF'), false, 'changing only the date horizon invalidates the old model');
  await select('#image-mode', 'local'); await wait(() => ready('选择地表影像'), 'local surface selected');
  assert.equal(await ready('保存彩色 3MF'), false, 'source mode change must invalidate the old model');
  await click('选择地表影像'); await wait(() => !!lastImage && ready('重新生成'), 'local image retained');
  await select('#image-mode', '12'); await control({ mode: 'success', cacheHit: true }); await click('重新生成'); await finishGeneration('12-month mode ignores local image');
  assert.equal(lastStart.imageMode, 'auto'); assert.equal(lastStart.imageId, undefined); assert.equal(lastJob.state, 'succeeded', lastJob.error?.message);
  assert.equal(lastStart.imageLookbackMonths, 12); assert.equal((await calls()).at(-1).lookbackMonths, 12);
  await wait(() => ready('保存彩色 3MF'), 'cached automatic result');
  assert.match(await js("document.querySelector('.model-image-source').textContent"), /使用缓存/);
  let loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.reload(); await loaded;
  await wait(() => ready('恢复上次项目'), 'reload auto project'); await click('恢复上次项目'); await wait(() => ready('生成模型'), 'auto project restored');
  assert.equal(await js("document.querySelector('#image-mode').value"), '12'); assert.equal(await ready('选择地表影像'), false);
  await control({ mode: 'fail', cacheHit: false }); await click('生成模型'); await finishGeneration('failure before fallback'); await wait(() => ready('切换本地导入'), 'fallback action ready');
  await click('切换本地导入'); await wait(() => ready('选择地表影像'), 'explicit local fallback');
  assert.equal(await js("document.querySelector('#image-mode').value"), 'local'); assert.equal(await ready('重试获取'), false);
  await click('选择地表影像'); await wait(() => ready('生成模型'), 'fallback image imported'); await click('生成模型'); await finishGeneration('local fallback generated');
  assert.equal(lastStart.imageMode, 'local'); assert.equal(lastStart.imageId, lastImage.id); assert.equal(lastJob.state, 'succeeded', lastJob.error?.message);
  await wait(() => ready('保存彩色 3MF'), 'fallback model ready'); await capture('03-local-fallback.png');
  loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.reload(); await loaded;
  await wait(() => ready('恢复上次项目'), 'reload local project'); await click('恢复上次项目'); await wait(async () => await ready('生成模型') && await js("!!document.querySelector('.image-detail')"), 'local project restored');
  assert.equal(await js("document.querySelector('#image-mode').value"), 'local');
  await select('#image-mode', 'none'); await control({ mode: 'fail', cacheHit: false });
  const beforeNone = (await calls()).length;
  await wait(() => ready('生成模型'), 'no imagery selected');
  assert.equal(await ready('选择地表影像'), false); assert.equal(await js("!!document.querySelector('.image-detail')"), false);
  await click('生成模型'); await finishGeneration('uniform model without imagery');
  assert.equal(lastStart.imageMode, 'none'); assert.equal(lastStart.imageId, undefined); assert.equal(lastJob.state, 'succeeded', lastJob.error?.message);
  assert.equal((await calls()).length, beforeNone, 'no-imagery mode must not acquire online imagery');
  const uniform = await manager.preview(lastJob.id);
  assert.equal(uniform.appearance.classification, 'uniform'); assert.equal(uniform.report.imageSource, undefined);
  await wait(() => ready('保存彩色 3MF'), 'uniform model export ready');
  await js("document.querySelector('.surface-section').scrollIntoView({ block: 'start' })"); await capture('07-no-imagery.png');
  loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.reload(); await loaded;
  await wait(() => ready('恢复上次项目'), 'reload no-imagery project'); await click('恢复上次项目'); await wait(() => ready('生成模型'), 'no-imagery project restored');
  assert.equal(await js("document.querySelector('#image-mode').value"), 'none');
  await select('#image-mode', '24'); await control({ mode: 'slow', cacheHit: false }); const beforeCancel = (await calls()).length;
  await wait(() => ready('生成模型'), 'ready for cancellation check');
  await click('生成模型'); await wait(async () => (await calls()).length > beforeCancel && await ready('取消生成'), 'acquisition cancellable'); await click('取消生成'); await finishGeneration('cancel imagery');
  assert.equal(lastJob.state, 'cancelled'); assert.equal(await ready('重试获取'), false); assert.equal(await ready('保存彩色 3MF'), false);
  await control({ mode: 'other-error', cacheHit: false }); await wait(() => ready('生成模型'), 'generate after cancel'); await click('生成模型'); await finishGeneration('unrelated error preserved');
  assert.equal(lastJob.error.code, 'SESSION_INPUT_CHANGED'); assert.equal(await ready('重试获取'), false, 'unrelated errors must not be presented as satellite failures');
  for (const failureCode of ['MODEL_TIMEOUT', 'OUTPUT_TIMEOUT', 'JOB_TIMEOUT', 'ACQUISITION_TIMEOUT']) {
    await control({ mode: 'success', cacheHit: true, failureCode }); await wait(() => ready('生成模型'), `ready for ${failureCode}`);
    await click('生成模型'); await finishGeneration(failureCode);
    assert.equal(lastJob.error.code, failureCode);
    await wait(async () => (await js("document.querySelector('.task-error')?.textContent ?? ''")).includes('超时'), `${failureCode} displayed`);
    const status = await js("document.querySelector('.status-line [role=status]').textContent");
    assert.doesNotMatch(status, /影像.*未完成|本地影像/, `${failureCode} must not pretend imagery failed`);
    assert.equal(await ready('重试获取'), false); assert.equal(await ready('切换本地导入'), false);
    assert.equal(await ready('保存彩色 3MF'), false);
    assert.equal(await ready('重试获取影像与高程'), failureCode === 'ACQUISITION_TIMEOUT');
    if (failureCode === 'ACQUISITION_TIMEOUT') assert.match(status, /影像.*高程|高程.*影像/);
    window.setSize(960, 720); await delay(150); assert.equal(await footerVisible(), true, `${failureCode} footer and primary actions fit 960x720`);
    await capture(`04-${failureCode.toLowerCase()}.png`); window.setSize(1280, 1000);
  }
  await control({ mode: 'image-timeout', cacheHit: false }); await click('生成模型'); await finishGeneration('image-specific timeout');
  assert.equal(lastJob.error.code, 'IMAGE_TIMEOUT'); await wait(async () => await ready('重试获取') && await ready('切换本地导入'), 'image timeout recovery');
  window.setSize(960, 720); await delay(150); assert.equal(await footerVisible(), true, 'image-specific recovery fits 960x720'); await capture('05-image-timeout.png');
  await select('.dem-mode select', 'auto'); await control({ mode: 'parallel', cacheHit: false }); await wait(() => ready('生成模型'), 'parallel acquisition ready'); await click('生成模型');
  await wait(async () => await js("document.querySelectorAll('.acquisition-row').length === 2 && document.querySelector('[data-branch=image] .branch-message')?.textContent.includes('2 / 24')"), 'parallel candidate state');
  assert.equal(await js("document.querySelector('[data-branch=image] .branch-coverage').textContent"), '覆盖待确认', 'candidate progress is not coverage');
  await wait(async () => await js("document.querySelector('[data-branch=dem] .branch-state')?.textContent === '已就绪'"), 'DEM finishes while image searches');
  assert.equal(await js("document.querySelector('[data-branch=image] .branch-state').textContent"), '获取中');
  const initialElapsed = await js("document.querySelector('.elapsed-time').textContent"); await delay(1100);
  assert.notEqual(await js("document.querySelector('.elapsed-time').textContent"), initialElapsed, 'elapsed time advances without requiring a fresh provider event');
  await wait(async () => await js("document.querySelector('[data-branch=image] .branch-coverage')?.textContent === '覆盖 87.5%'"), 'measured coverage visible');
  assert.match(await js("document.querySelector('[data-branch=image] .branch-data').textContent"), /已下载 1.5 MB.*缓存复用 512 KB/);
  assert.match(await js("document.querySelector('[data-branch=dem] .branch-data').textContent"), /已下载 0 B.*缓存复用 2 MB/);
  assert.equal(await footerVisible(), true, 'parallel progress and main actions fit 960x720'); assert.equal(await ready('保存彩色 3MF'), false);
  await capture('06-parallel-progress.png'); await finishGeneration('parallel acquisition success');
  assert.equal(lastJob.state, 'succeeded', lastJob.error?.message); await wait(() => ready('保存彩色 3MF'), 'parallel model ready');
  assert.deepEqual(errors, []);
  const report = { passed: true, defaultAuto: true, acquisitionOnlyOnGenerate: true, retry: true, sourceDatesAndCache: true, finiteColorExport: true, paletteKeepsModel: true, modeInvalidatesModel: true, automaticIgnoresLocalId: true, localFallback: true, autoAndLocalRecovery: true, cancellation: true, unrelatedErrorPreserved: true, nonImageTimeoutsPreserved: true, acquisitionTimeoutRecovery: true, imageTimeoutRecovery: true, parallelProgress: true, realCoverage: true, elapsedTimer: true, smallWindowFooter: true, starts, saves, providerCalls: await calls(), validation: preview.report.validation, errors };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
run().then(async () => { await session?.close(); await manager?.close(); window?.destroy(); app.exit(0); }).catch(async error => {
  console.error(error); await mkdir(output, { recursive: true }); await writeFile(join(output, 'failure.txt'), error.stack ?? String(error));
  if (window && !window.isDestroyed()) await writeFile(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
  await session?.close(); await manager?.close(); window?.destroy(); app.exit(1);
});
