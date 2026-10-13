import { app, BrowserWindow, ipcMain, protocol, utilityProcess } from 'electron';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'artifacts', 'grass-controls-v046-check');
const rendererArg = process.argv.find(argument => argument.startsWith('--renderer='));
const renderer = rendererArg ? resolve(rendererArg.slice('--renderer='.length)) : join(root, 'desktop/dist/renderer/index.html');
const smokeOnly = process.argv.includes('--smoke');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, `profile-${Date.now()}`));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'terrain-map', privileges: { standard: true, secure: true } }]);
const delay = ms => new Promise(done => setTimeout(done, ms));
let window, manager, session, lastJob, lastImage;
const errors = [];
const exports = [];
const generations = [];
const screenshots = [];

// Read the actual saved archive, independent of the export implementation.
function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6), method = bytes.readUInt16LE(offset + 8);
    assert.equal(flags & 8, 0, 'test archive reader requires sized local entries');
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = bytes.subarray(start, start + length);
    assert.ok(method === 0 || method === 8, `unsupported ZIP compression ${method}`);
    entries.set(name, method === 8 ? inflateRawSync(body) : body);
    offset = start + length;
  }
  return entries;
}

async function run() {
  await app.whenReady();
  protocol.handle('terrain-map', () => new Response(null, { status: 404 }));
  const routePath = join(output, '灵敏度验证 路线.KML');
  const imagePath = join(output, '分级绿色 地表.tif');
  await writeFile(routePath, '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>草地灵敏度验证路线</name><Placemark><LineString><coordinates>104.28,30.56 104.29,30.565 104.30,30.57</coordinates></LineString></Placemark></Document></kml>');
  const width = 768, height = 768;
  const pixels = new Uint8Array(width * height * 3);
  // East-west gradient crosses both conservative and permissive greenness
  // thresholds; neutral rock at the north edge keeps all palette roles present.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const green = 90 + Math.round(x * 60 / (width - 1));
    const rock = y < 64 || (x % 19 === 9 && y % 19 === 9);
    pixels.set(rock ? [142, 142, 138] : [100, green, 95], (y * width + x) * 3);
  }
  await writeFile(imagePath, Buffer.from(writeArrayBuffer(pixels, {
    width, height, SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1],
    PhotometricInterpretation: 2, PlanarConfiguration: 1, GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1,
    ModelPixelScale: [.08 / width, .08 / height, 0], ModelTiepoint: [0, 0, 0, 104.25, 30.61, 0],
  })));
  manager = createDesktopManager({
    taskRoot: join(output, 'tasks'), coreModuleUrl: pathToFileURL(join(root, 'dist/src/index.js')).href,
    workerFactory: ({ workerPath, taskDir }) => utilityProcess.fork(workerPath, [], { cwd: taskDir, stdio: 'pipe' }),
    onJob: job => { lastJob = job; window?.webContents.send('terrain:job', job); },
  });
  session = createSessionStore({ userDataDirectory: app.getPath('userData'), manager });
  const handle = (name, operation) => ipcMain.handle(`terrain:${name}`, async (_event, ...args) => {
    try { return { ok: true, value: await operation(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code ?? 'TEST', message: error.message } }; }
  });
  handle('runtime', () => ({ version: '0.4.6', platform: 'win32', packaged: false, units: 'mm' }));
  handle('cache-info', () => ({ path: output, elevationBytes: 0, mapBytes: 0 }));
  handle('session-get', () => session.getSession());
  handle('session-save', request => session.saveSession(request));
  handle('session-restore', () => session.restoreSession());
  handle('choose-route', () => manager.addRoute(routePath));
  handle('choose-dem', () => manager.addDem(join(root, 'data', 'copernicus-longquanshan.tif')));
  handle('choose-image', async () => lastImage = await manager.addImage(imagePath));
  handle('remove-image', id => manager.removeImage(id));
  handle('import-image', async path => lastImage = await manager.addImage(path));
  handle('inspect', request => manager.inspect(request));
  handle('start', request => manager.start(request));
  handle('get', id => manager.get(id));
  handle('preview', id => manager.preview(id));
  handle('cancel', id => manager.cancel(id));
  handle('save-model', async request => {
    const artifact = await manager.exportModel(request.id, request.format, request.options);
    const { saveModelFile } = await import('../main/save-model.mjs');
    const path = join(output, `灵敏度导出-${exports.length + 1}.${artifact.extension.replace(/^\./, '')}`);
    const saved = await saveModelFile(artifact.bytes, path, { overwriteApproved: true });
    const entries = zipEntries(await readFile(path));
    const model = entries.get('3D/3dmodel.model')?.toString('utf8');
    assert.ok(model, 'saved 3MF must contain its actual model XML');
    assert.match(model, /<triangle\b/, 'saved color model must include triangles');
    assert.match(model, /<m:colorgroup\b/, 'saved color model must include a palette');
    assert.match(model, /<m:color\s+color="#799278ff"/, 'saved palette must include the selected grass color');
    exports.push({ id: request.id, format: request.format, sensitivity: lastJob.options.grassSensitivity, continuity: lastJob.options.grassContinuity,
      appearanceHash: artifact.appearanceHash, ...saved });
    return { cancelled: false, ...saved };
  });
  window = new BrowserWindow({ show: false, useContentSize: true, width: 1280, height: 1000, webPreferences: {
    preload: join(root, 'desktop/main/preload.cjs'), contextIsolation: true, nodeIntegration: false,
    sandbox: true, backgroundThrottling: false, offscreen: true,
  } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error' && !event.message.includes('terrain-map')) errors.push(event.message);
  });
  await window.loadFile(renderer);
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`${error.message}\nRenderer: ${source}\nConsole: ${JSON.stringify(errors)}`, { cause: error }); }
  };
  const wait = async (predicate, label, timeout = 60000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await delay(25); }
    throw Error(`Timed out: ${label}; ${await js("document.querySelector('.task-error')?.textContent ?? ''")}`);
  };
  const ready = label => js(`[...document.querySelectorAll('button')].some(el => el.textContent === ${JSON.stringify(label)} && !el.disabled)`);
  const click = label => js(`(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)});if(!el||el.disabled)throw Error('Button unavailable: '+${JSON.stringify(label)});el.click();})()`);
  const select = (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Select unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const input = (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Input unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const sliderState = () => js("(()=>{const el=document.querySelector('#grass-sensitivity');const out=document.querySelector('output[for=\"grass-sensitivity\"]');return {value:el.value,disabled:el.disabled,output:out?.textContent,label:document.querySelector('label[for=\"grass-sensitivity\"]')?.textContent};})()");
  const continuityState = () => js("(()=>{const el=document.querySelector('#grass-continuity');if(!el)return null;return {value:el.value,disabled:el.disabled,output:document.querySelector('output[for=\"grass-continuity\"]')?.textContent,label:document.querySelector('label[for=\"grass-continuity\"]')?.textContent};})()");
  const checkContinuity = async value => {
    await wait(async () => (await continuityState())?.value === String(value), `continuity value ${value}`);
    const state = await continuityState();
    assert.match(state.output ?? '', new RegExp(`^\\s*${value}\\s*/\\s*100\\s*$`));
    assert.match(state.label ?? '', /草地连片程度/);
  };
  const checkValue = async value => {
    await wait(async () => (await sliderState()).value === String(value), `sensitivity value ${value}`);
    const state = await sliderState();
    assert.match(state.output ?? '', new RegExp(`^\\s*${value}\\s*/\\s*100\\s*$`), 'visible output must follow the slider value');
    assert.match(state.label ?? '', /草地识别强度/, 'slider must have its visible associated label');
  };
  const checkDisabled = async expected => {
    await wait(async () => (await sliderState()).disabled === expected, `slider ${expected ? 'disabled' : 'enabled'}`);
    assert.equal((await continuityState()).disabled, expected, 'both sliders must share availability');
    if (expected) assert.equal(await ready('恢复默认识别'), false, 'reset must also be disabled when classification is unavailable');
    if (expected) assert.equal(await ready('恢复默认连片'), false, 'continuity reset must be disabled with its slider');
  };
  const capture = async (name, width, height) => {
    window.setContentSize(width, height);
    await delay(150);
    await js("document.querySelector('#grass-continuity').scrollIntoView({block:'center'})");
    await delay(700);
    const visible = await js("(()=>{const sidebar=document.querySelector('.sidebar').getBoundingClientRect();return ['#grass-sensitivity','#grass-continuity','label[for=\"grass-sensitivity\"]','label[for=\"grass-continuity\"]','output[for=\"grass-sensitivity\"]','output[for=\"grass-continuity\"]'].every(s=>{const b=document.querySelector(s).getBoundingClientRect();return b.width>0&&b.height>0&&b.left>=sidebar.left&&b.right<=sidebar.right&&b.top>=Math.max(sidebar.top,0)&&b.bottom<=Math.min(sidebar.bottom,innerHeight)});})()");
    assert.equal(visible, true, 'screenshot must show the slider, label and numerical output without clipping');
    // Windows DPI conversion may round the content size by one CSS pixel.
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    assert.deepEqual(image.getSize(), { width, height });
    await writeFile(join(output, name), image.toPNG());
    screenshots.push({ name, width, height, slider: await sliderState(), continuity: await continuityState() });
  };
  const generate = async (sensitivity, continuity = 0) => {
    const previous = lastJob?.id;
    // Restoring a project schedules a framing inspection. Wait and click in the
    // same renderer turn so a transient enabled button cannot race that effect.
    await wait(() => js("(()=>{const el=[...document.querySelectorAll('button')].find(el=>['生成模型','重新生成'].includes(el.textContent)&&!el.disabled);if(!el)return false;el.click();return true;})()"), 'generation action available');
    await wait(() => lastJob && lastJob.id !== previous, 'new generation started');
    const id = lastJob.id;
    await wait(() => ready('取消生成'), 'generation controls');
    assert.equal((await sliderState()).disabled, true, 'generation must lock classification input');
    assert.equal((await continuityState()).disabled, true, 'generation must lock continuity input');
    assert.equal(await ready('恢复默认识别'), false, 'generation must lock reset');
    await wait(() => lastJob.id === id && !['running', 'cancelling'].includes(lastJob.state), 'generation completed', 120000);
    assert.equal(lastJob.state, 'succeeded', lastJob.error?.message);
    assert.equal(lastJob.options.grassSensitivity, sensitivity, 'real job must receive the slider setting');
    assert.equal(lastJob.options.grassContinuity, continuity, 'real job must receive the continuity setting');
    await wait(() => ready('保存彩色 3MF'), 'current preview can be saved');
    assert.equal((await sliderState()).disabled, false, 'finished generation must unlock classification input');
    const preview = await manager.preview(id);
    assert.equal(preview.appearance.classification, 'rgb-greenness');
    const count = role => preview.appearance.faceClasses.filter(value => value === role).length;
    const result = { id, sensitivity, continuity, grass: count('grass'), rock: count('rock'), route: count('route'),
      appearanceHash: preview.appearance.hash, stlSha256: lastJob.result.stlSha256,
      triangleCount: lastJob.result.triangleCount, validation: preview.report.validation };
    assert.ok(result.grass > 0 && result.rock > 0 && result.route > 0, 'fixture should contain grass, rock and route faces');
    generations.push(result);
    console.log(`sensitivity ${sensitivity}: ${result.grass} grass faces, ${result.rock} rock faces, ${result.route} route faces`);
    return result;
  };
  const save = async (sensitivity, continuity = 0) => {
    const number = exports.length;
    await click('保存彩色 3MF');
    await wait(() => exports.length === number + 1 && ready('保存彩色 3MF'), 'saved color 3MF');
    assert.equal(exports.at(-1).sensitivity, sensitivity);
    assert.equal(exports.at(-1).continuity, continuity);
    assert.ok(await js("document.querySelector('.saved-path')?.textContent"), 'saved file confirmation should be displayed');
    return exports.at(-1);
  };
  const editSensitivity = async value => {
    const id = lastJob.id;
    await input('#grass-sensitivity', String(value)); await checkValue(value);
    await wait(() => js("!!document.querySelector('.result-state.stale')"), 'classification change invalidates old model');
    assert.equal(await ready('保存彩色 3MF'), false, 'stale classification must prevent saving until regeneration');
    assert.equal(await js("!!document.querySelector('.saved-path')"), false, 'classification edit must clear earlier save confirmation');
    assert.equal(lastJob.id, id, 'editing the setting must not silently start generation');
  };
  const editContinuity = async value => {
    const id = lastJob.id;
    await input('#grass-continuity', String(value)); await checkContinuity(value);
    await wait(() => js("!!document.querySelector('.result-state.stale')"), 'continuity edit invalidates old model');
    assert.equal(await ready('保存彩色 3MF'), false, 'continuity edit requires regeneration before saving');
    assert.equal(await js("!!document.querySelector('.saved-path')"), false);
    assert.equal(lastJob.id, id, 'continuity edit must not start generation');
  };
  await wait(() => ready('导入路线'), 'startup');
  const slider = await js("(()=>{const el=document.querySelector('#grass-sensitivity'); return el ? {type:el.type,min:el.min,max:el.max,step:el.step,value:el.value} : null;})()");
  assert.ok(slider, 'grass sensitivity slider must be present in the real renderer');
  assert.deepEqual(slider, { type: 'range', min: '0', max: '100', step: '1', value: '50' });
  assert.ok(await continuityState(), 'grass continuity slider must be present in the real renderer');
  await checkContinuity(50);
  await checkValue(50);
  await writeFile(join(output, 'smoke-result.json'), JSON.stringify({ passed: true, renderer, slider, errors }, null, 2));
  if (smokeOnly) return;
  await select('#image-mode', 'none'); await checkDisabled(true);
  await select('#image-mode', 'local'); await checkDisabled(true);
  await select('#image-mode', '12'); await checkDisabled(false);
  await select('#image-mode', 'local'); await checkDisabled(true);
  await click('导入路线'); await wait(() => ready('更换路线'), 'route imported');
  await select('.dem-mode select', 'local'); await click('选择高程');
  await wait(() => ready('选择地表影像'), 'elevation imported'); await click('选择地表影像');
  await wait(() => !!lastImage && ready('生成模型'), 'local image imported'); await checkDisabled(false);
  await select('#print-colors', '2'); await checkDisabled(true); await checkValue(50);
  await select('#print-colors', '3'); await checkDisabled(false);
  await input('#grass-sensitivity', '100'); await checkValue(100);
  await click('恢复默认识别'); await checkValue(50);
  await input('#grass-continuity', '0'); await checkContinuity(0);
  const baseline = await generate(50);
  const defaultExport = await save(50);
  await capture('01-default-1280x1000.png', 1280, 1000);
  await editSensitivity(100);
  const permissive = await generate(100);
  assert.ok(permissive.grass > baseline.grass, `higher sensitivity must increase grass faces: ${permissive.grass} <= ${baseline.grass}`);
  assert.equal(permissive.stlSha256, baseline.stlSha256, 'classification must preserve terrain geometry');
  const highExport = await save(100);
  assert.notEqual(highExport.sha256, defaultExport.sha256, 'regenerated color export must reflect new classification');
  assert.notEqual(highExport.appearanceHash, defaultExport.appearanceHash);
  await editSensitivity(0);
  const conservative = await generate(0);
  assert.ok(conservative.grass < baseline.grass, `lower sensitivity must reduce grass faces: ${conservative.grass} >= ${baseline.grass}`);
  assert.equal(conservative.stlSha256, baseline.stlSha256);
  const lowExport = await save(0);
  assert.notEqual(lowExport.sha256, highExport.sha256);
  assert.notEqual(lowExport.appearanceHash, highExport.appearanceHash);
  await click('恢复默认识别'); await checkValue(50);
  await wait(() => js("!!document.querySelector('.result-state.stale')"), 'reset invalidates previous classification');
  assert.equal(await ready('保存彩色 3MF'), false, 'reset to default requires regeneration');
  const reset = await generate(50);
  assert.equal(reset.grass, baseline.grass, 'restoring default must reproduce original classification');
  assert.equal(reset.appearanceHash, baseline.appearanceHash);
  await editContinuity(100);
  const joined = await generate(50, 100);
  assert.ok(joined.grass > baseline.grass, `continuity must fill the fixture's small rock holes: ${joined.grass} <= ${baseline.grass}`);
  assert.equal(joined.stlSha256, baseline.stlSha256, 'continuity must preserve terrain geometry');
  const joinedExport = await save(50, 100);
  assert.notEqual(joinedExport.sha256, defaultExport.sha256, 'saved 3MF must include continuity classification');
  await editContinuity(0);
  const split = await generate(50, 0);
  assert.equal(split.appearanceHash, baseline.appearanceHash, 'disabling continuity must restore original classification');
  await click('恢复默认连片'); await checkContinuity(50);
  assert.equal(await ready('保存彩色 3MF'), false, 'continuity reset requires regeneration');
  await editSensitivity(83);
  await editContinuity(72);
  await wait(async () => (await session.getSession()).preferences.options.grassSensitivity === 83, 'session persists sensitivity');
  await wait(async () => (await session.getSession()).preferences.options.grassContinuity === 72, 'session persists continuity');
  const reloaded = new Promise(done => window.webContents.once('did-finish-load', done));
  window.reload(); await reloaded;
  await wait(() => ready('恢复上次项目'), 'renderer reload has saved session');
  await checkValue(83); await checkDisabled(true);
  await checkContinuity(72);
  await click('恢复上次项目');
  await wait(async () => await ready('生成模型') && await js("!!document.querySelector('.image-detail')"), 'restore sources');
  await checkValue(83); await checkDisabled(false);
  await checkContinuity(72);
  assert.equal(await ready('保存彩色 3MF'), false, 'session restoration must require a new model');
  const restored = await generate(83, 72);
  assert.ok(restored.grass >= baseline.grass);
  assert.equal(restored.stlSha256, baseline.stlSha256);
  await save(83, 72);
  await capture('02-session-restored-1000x760.png', 1000, 760);
  await select('#print-colors', '2'); await checkDisabled(true); await checkValue(83);
  await select('#print-colors', '3'); await checkDisabled(false); await checkValue(83);
  await select('#image-mode', 'none'); await checkDisabled(true); await checkValue(83);
  await select('#image-mode', 'local'); await checkDisabled(false); await checkValue(83);
  await click('清除地表影像'); await checkDisabled(true); await checkValue(83);
  assert.deepEqual(errors, [], 'renderer should not report console errors');
  await writeFile(join(output, 'result.json'), JSON.stringify({
    passed: true, renderer, disabledModes: ['none', 'local-without-image', 'two-colors', 'generation'],
    displayedValues: [50, 100, 0, 83], resetRequiresRegeneration: true, savedClassification: true,
    sensitivityRestored: true, continuityRestored: true, continuityFillsSmallHoles: true, geometryPreserved: true, generations, exports, screenshots, errors,
  }, null, 2));
}

run().then(async () => {
  await session?.close(); await manager?.close(); window?.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'failure.txt'), error.stack ?? String(error));
  if (window && !window.isDestroyed()) await writeFile(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
  await session?.close(); await manager?.close(); window?.destroy(); app.exit(1);
});
