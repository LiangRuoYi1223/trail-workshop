import { app, BrowserWindow, ipcMain, protocol, utilityProcess } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';
import { saveModelFile } from '../main/save-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'artifacts/snow-ui-check');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, `profile-${Date.now()}`));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'terrain-map', privileges: { standard: true, secure: true } }]);
const delay = ms => new Promise(done => setTimeout(done, ms));
let window, manager, session, lastJob;
const exports = [], errors = [];
async function run() {
  await app.whenReady();
  protocol.handle('terrain-map', () => new Response(null, { status: 404 }));
  const routePath = join(output, '雪面路线.gpx'), imagePath = join(output, '地表.tif');
  await writeFile(routePath, '<gpx><trk><name>积雪验证路线</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.565" lon="104.29"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>');
  const pixels = Uint8Array.from(Array.from({ length: 32 * 32 }, (_, i) => i % 32 < 16 ? [30, 160, 40] : [150, 145, 140]).flat());
  await writeFile(imagePath, Buffer.from(writeArrayBuffer(pixels, { width: 32, height: 32, SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2,
    ModelPixelScale: [0.005, 0.005, 0], ModelTiepoint: [0, 0, 0, 104.20, 30.65, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1 })));
  manager = createDesktopManager({ taskRoot: join(output, `tasks-${Date.now()}`), coreModuleUrl: pathToFileURL(join(root, 'dist/src/index.js')).href,
    workerFactory: ({ workerPath, taskDir }) => utilityProcess.fork(workerPath, [], { cwd: taskDir, stdio: 'pipe' }),
    onJob: job => { lastJob = job; window?.webContents.send('terrain:job', job); } });
  session = createSessionStore({ userDataDirectory: app.getPath('userData'), manager });
  await session.saveSession({ demMode: 'local', imageMode: 'local', offlineOnly: false, options: { gridColumns: 65 } });
  const handle = (name, operation) => ipcMain.handle(`terrain:${name}`, async (_event, ...args) => {
    try { return { ok: true, value: await operation(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code ?? 'CHECK', message: error.message } }; }
  });
  handle('runtime', () => ({ version: '0.4.3', platform: 'win32', packaged: false, units: 'mm' }));
  handle('cache-info', () => ({ path: output, elevationBytes: 0, mapBytes: 0 }));
  handle('session-get', () => session.getSession()); handle('session-save', request => session.saveSession(request));
  handle('session-restore', () => session.restoreSession());
  handle('choose-route', () => manager.addRoute(routePath));
  handle('choose-dem', () => manager.addDem(join(root, 'data/copernicus-longquanshan.tif')));
  handle('choose-image', () => manager.addImage(imagePath)); handle('remove-image', id => manager.removeImage(id));
  handle('inspect', request => manager.inspect(request)); handle('start', request => manager.start(request));
  handle('get', id => manager.get(id)); handle('preview', id => manager.preview(id)); handle('cancel', id => manager.cancel(id));
  handle('save-model', async request => {
    const artifact = await manager.exportModel(request.id, request.format, request.options);
    const saved = await saveModelFile(artifact.bytes, join(output, `snow-${exports.length + 1}${artifact.extension}`), { overwriteApproved: true });
    exports.push({ format: request.format, appearanceHash: artifact.appearanceHash, ...saved });
    return { cancelled: false, ...saved };
  });
  window = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: {
    preload: join(root, 'desktop/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true,
  } });
  window.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('terrain-map')) errors.push(event.message); });
  const renderer = process.argv.find(value => value.startsWith('--renderer='))?.slice('--renderer='.length) ?? join(root, 'desktop/dist/renderer/index.html');
  await window.loadFile(renderer);
  const js = async source => { try { return await window.webContents.executeJavaScript(source); }
    catch(error) { throw new Error(`${error.message}\nRenderer operation: ${source}\nConsole: ${JSON.stringify(errors)}`, {cause:error}); } };
  const wait = async (predicate, label) => {
    const until = Date.now() + 60000;
    while (Date.now() < until) { if (await predicate()) return; await delay(50); }
    throw new Error(`Timed out: ${label}; ${await js("document.querySelector('.task-error')?.textContent ?? ''")}`);
  };
  const ready = label => js(`[...document.querySelectorAll('button')].some(el=>el.textContent===${JSON.stringify(label)}&&!el.disabled)`);
  const click = label => js(`(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)});if(!el||el.disabled)throw Error('Unavailable button');el.click()})()`);
  const select = (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const input = (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const snowThickness = value => js(`(()=>{const field=[...document.querySelectorAll('.snow-section .number-field')].find(el=>el.querySelector('label').textContent==='最大积雪厚度');const el=field.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await wait(() => ready('导入路线'), 'startup');
  assert.deepEqual(await js("[...document.querySelector('#image-mode').options].map(el=>el.textContent)"), ['不使用', '12个月', '24个月', '本地导入']);
  assert.equal(await js("document.querySelector('#snow-enabled').checked"), false);
  await js("document.querySelector('#snow-enabled').click()");
  await wait(() => js("document.querySelector('#print-colors').value==='4'"), 'four colors');
  assert.equal(await js("document.querySelector('#print-colors option[value=\"3\"]').disabled"), true);
  await click('导入路线'); await wait(() => ready('选择高程'), 'route');
  await click('选择高程'); await wait(() => ready('选择地表影像'), 'DEM');
  await click('选择地表影像'); await wait(() => ready('生成模型'), 'image');
  await click('生成模型'); await wait(() => lastJob && !['running', 'cancelling'].includes(lastJob.state), 'snow generation');
  assert.equal(lastJob.state, 'succeeded', JSON.stringify(lastJob.error));
  await wait(() => ready('保存彩色 3MF'), 'final preview');
  const preview = await manager.preview(lastJob.id);
  assert.ok(preview.mesh.materialParts.some(part => part.id === 'snow'));
  assert.equal(preview.report.validation.connectedComponents, 1);
  assert.match(await js("document.querySelector('.model-snow-source').textContent"), /30\.00%/);
  assert.match(await js("document.querySelector('.view-caption').textContent"), /白雪/);
  assert.match(await js("document.querySelector('.print-color-count').textContent"), /4 色/);
  await js("document.querySelector('.snow-section').scrollIntoView({block:'center'})"); await delay(700);
  await writeFile(join(output, 'snow-model.png'), (await window.webContents.capturePage()).toPNG());
  await click('保存彩色 3MF'); await wait(() => exports.length === 1 && ready('保存彩色 3MF'), '3MF');
  await input('#grass-color', '#005522'); await delay(100);
  assert.equal(await js("!!document.querySelector('.saved-path')"), false);
  assert.equal(await ready('保存彩色 3MF'), true);
  await select('#export-format', 'obj'); await click('保存 OBJ 包'); await wait(() => exports.length === 2, 'OBJ');
  await select('#export-format', 'stl'); await click('保存 STL'); await wait(() => exports.length === 3, 'STL');
  assert.equal(exports[2].sha256, lastJob.result.stlSha256);
  await snowThickness('1.5'); await delay(100);
  assert.equal(await ready('保存 STL'), false);
  assert.match(await js("document.querySelector('.result-state').textContent"), /此前结果/);
  await snowThickness('1'); await delay(700);
  const loaded = new Promise(done => window.webContents.once('did-finish-load', done)); window.reload(); await loaded;
  await wait(() => ready('恢复上次项目'), 'reload');
  assert.equal(await js("document.querySelector('#snow-enabled').checked"), true);
  assert.equal(await js("document.querySelector('#print-colors').value"), '4');
  await click('恢复上次项目'); await wait(() => ready('生成模型'), 'restore');
  assert.equal(await ready('保存彩色 3MF'), false);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, version: '0.4.3', imageryOptionsPreserved: true,
    controls: true, fourColors: true, physicalMaterials: true, recolor: true, staleState: true, sessionRecovery: true,
    validation: preview.report.validation, snow: preview.report.snow, exports, errors }, null, 2));
}
run().then(async () => { await session?.close(); await manager?.close(); window?.destroy(); app.exit(0); }).catch(async error => {
  console.error(error); await mkdir(output, { recursive: true }); await writeFile(join(output, 'failure.txt'), error.stack ?? String(error));
  if (window && !window.isDestroyed()) await writeFile(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
  await session?.close(); await manager?.close(); window?.destroy(); app.exit(1);
});
