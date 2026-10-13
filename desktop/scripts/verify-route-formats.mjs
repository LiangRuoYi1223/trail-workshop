import { app, BrowserWindow, ipcMain, protocol, utilityProcess } from 'electron';
import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';
import { saveModelFile } from '../main/save-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'artifacts', 'route-formats-check');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, `profile-${Date.now()}`));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'terrain-map', privileges: { standard: true, secure: true } }]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let window, manager, session;
const errors = [];

async function run() {
  await app.whenReady();
  protocol.handle('terrain-map', () => new Response(null, { status: 404 }));
  const kmlPath = join(output, '中文 路线.KML'), gpxPath = join(output, '中文 路线.gpx');
  const name = '格式验证路线';
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name><Placemark><LineString><coordinates>104.28,30.56,700 104.29,30.565,750 104.30,30.57,800</coordinates></LineString></Placemark></Document></kml>`;
  const gpx = `<gpx><trk><name>${name}</name><trkseg><trkpt lat="30.56" lon="104.28"><ele>700</ele></trkpt><trkpt lat="30.565" lon="104.29"><ele>750</ele></trkpt><trkpt lat="30.57" lon="104.30"><ele>800</ele></trkpt></trkseg></trk></gpx>`;
  await Promise.all([writeFile(kmlPath, kml), writeFile(gpxPath, gpx)]);
  const demPath = join(root, 'data', 'copernicus-longquanshan.tif');
  let chosenRoute = gpxPath, lastRoute, lastInspection, lastJob, saved;
  manager = createDesktopManager({ taskRoot: join(output, 'tasks'), coreModuleUrl: pathToFileURL(join(root, 'dist/src/index.js')).href,
    workerFactory: ({ workerPath, taskDir }) => utilityProcess.fork(workerPath, [], { cwd: taskDir, stdio: 'pipe' }),
    onJob: job => { lastJob = job; window?.webContents.send('terrain:job', job); } });
  session = createSessionStore({ userDataDirectory: app.getPath('userData'), manager });
  const handle = (name, operation) => ipcMain.handle(`terrain:${name}`, async (_event, ...args) => {
    try { return { ok: true, value: await operation(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code || 'TEST', message: error.message } }; }
  });
  handle('runtime', () => ({ version: '0.4.0', platform: 'win32', packaged: false, units: 'mm' }));
  handle('cache-info', () => ({ path: output, elevationBytes: 0, mapBytes: 0 }));
  handle('session-get', () => session.getSession());
  handle('session-save', request => session.saveSession(request));
  handle('session-restore', () => session.restoreSession());
  handle('choose-route', async () => lastRoute = await manager.addRoute(chosenRoute));
  handle('choose-dem', () => manager.addDem(demPath));
  handle('import-route', async path => lastRoute = await manager.addRoute(path));
  handle('import-dem', path => manager.addDem(path));
  handle('inspect', async request => lastInspection = await manager.inspect(request));
  handle('start', request => manager.start(request));
  handle('get', id => manager.get(id));
  handle('preview', id => manager.preview(id));
  handle('cancel', id => manager.cancel(id));
  handle('save-model', async request => {
    const artifact = await manager.exportModel(request.id, request.format, request.options);
    saved = await saveModelFile(artifact.bytes, join(output, `KML_验证模型${artifact.extension}`), { overwriteApproved: true });
    return { cancelled: false, ...saved, appearanceHash: artifact.appearanceHash };
  });
  window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { preload: join(root, 'desktop/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error' && !event.message.includes('terrain-map')) errors.push(event.message);
  });
  await window.loadFile(join(root, 'desktop/dist/renderer/index.html'));
  const js = source => window.webContents.executeJavaScript(source);
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(40); }
    throw new Error(`Timed out: ${label}`);
  };
  const ready = label => js(`[...document.querySelectorAll('button')].some(el => el.textContent === ${JSON.stringify(label)} && !el.disabled)`);
  const click = label => js(`(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(label)}); if (!el || el.disabled) throw Error('Button unavailable'); el.click(); })()`);
  const capture = async label => writeFile(join(output, `${label}.png`), (await window.webContents.capturePage()).toPNG());
  const drop = async paths => {
    await js(`(() => { document.querySelector('#probe-files')?.remove(); const input = document.createElement('input'); input.id = 'probe-files'; input.type = 'file'; input.multiple = true; input.hidden = true; document.body.append(input); })()`);
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    const { root: document } = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: document.nodeId, selector: '#probe-files' });
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: paths });
    await js(`(() => { const dataTransfer = new DataTransfer(); for (const file of document.querySelector('#probe-files').files) dataTransfer.items.add(file); document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })); })()`);
  };
  await wait(() => ready('导入路线'), 'startup');
  await js(`const imageMode=document.querySelector('#image-mode');imageMode.value='local';imageMode.dispatchEvent(new Event('change',{bubbles:true}));`);
  await js(`const format=document.querySelector('#export-format');format.value='stl';format.dispatchEvent(new Event('change',{bubbles:true}));`);
  await capture('01-startup');
  // Exercise actual File objects and the production preload path resolver.
  await drop([kmlPath, demPath]);
  await wait(async () => !!lastRoute || !!await js(`document.querySelector('.task-error')`), 'KML drop result');
  assert.ok(lastRoute, await js(`document.querySelector('.task-error')?.textContent || 'KML drop was rejected'`));
  await wait(() => lastInspection && ready('生成模型'), 'KML and DEM drop');
  assert.equal(lastRoute.fileName, '中文 路线.KML');
  assert.equal(lastRoute.name, name); assert.equal(lastRoute.pointCount, 3); assert.equal(lastRoute.segmentCount, 1);
  assert.deepEqual(lastRoute.segments[0][0], { lat: 30.56, lon: 104.28 });
  assert.equal(await js(`document.querySelector('.dem-mode select').value`), 'local');
  await capture('02-kml-map');
  const originalRouteId = lastRoute.id;
  await drop([kmlPath, gpxPath]);
  await wait(async () => !!await js(`document.querySelector('.task-error')`), 'two-route drop rejection');
  assert.match(await js(`document.querySelector('.task-error').textContent`), /一份路线/);
  assert.equal(lastRoute.id, originalRouteId);
  await click('更换路线');
  await wait(() => lastRoute.fileName.endsWith('.gpx') && ready('生成模型'), 'GPX selection');
  assert.equal(lastRoute.pointCount, 3); assert.equal(lastRoute.segmentCount, 1);
  chosenRoute = kmlPath;
  await click('更换路线');
  await wait(() => lastRoute.fileName.endsWith('.KML') && ready('生成模型'), 'KML selection');
  await drop([gpxPath]);
  await wait(() => lastRoute.fileName.endsWith('.gpx') && ready('生成模型'), 'GPX drop');
  await drop([kmlPath]);
  await wait(() => lastRoute.fileName.endsWith('.KML') && ready('生成模型'), 'KML drop');
  await click('生成模型');
  await wait(() => lastJob && !['running', 'cancelling'].includes(lastJob.state), 'KML generation');
  assert.equal(lastJob.state, 'succeeded', lastJob.error?.message);
  await wait(() => ready('保存 STL'), 'verified KML preview');
  const preview = await manager.preview(lastJob.id);
  assert.equal(preview.report.validation.connectedComponents, 1);
  assert.equal(preview.report.validation.boundaryEdges, 0); assert.equal(preview.report.validation.nonManifoldEdges, 0);
  await click('保存 STL');
  await wait(() => saved && ready('保存 STL'), 'KML export');
  assert.equal(saved.sha256, lastJob.result.stlSha256);
  await capture('03-kml-model');
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.reload(); await reloaded;
  await wait(() => ready('恢复上次项目'), 'restart offers KML project');
  await js(`const format=document.querySelector('#export-format');format.value='stl';format.dispatchEvent(new Event('change',{bubbles:true}));`);
  const previousJobId = lastJob.id;
  await click('恢复上次项目');
  await wait(() => js(`document.querySelector('.file-detail strong')?.textContent === ${JSON.stringify(name)}`), 'KML project recovery');
  await wait(() => ready('生成模型'), 'KML framing after recovery');
  assert.equal(await ready('保存 STL'), false, 'recovery must not reuse old STL');
  assert.equal(lastJob.id, previousJobId, 'recovery must not start generation');
  await capture('04-kml-restored');
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { passed: true, gpxSelection: true, kmlSelection: true, gpxDrop: true, kmlDrop: true,
    kmlDemCombinedDrop: true, duplicateRouteRejected: true, kmlRecovery: true, saved: { ...saved, warnings: undefined },
    validation: preview.report.validation, errors };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await session.close(); await manager.close(); window.destroy(); app.exit(0);
}
run().catch(async error => {
  console.error(error);
  await writeFile(join(output, 'failure.txt'), error.stack || String(error));
  if (window && !window.isDestroyed()) await writeFile(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
  await session?.close(); await manager?.close(); window?.destroy(); app.exit(1);
});
