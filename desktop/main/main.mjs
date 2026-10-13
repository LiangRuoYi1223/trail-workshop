import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, shell, utilityProcess } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDesktopManager } from './manager.mjs';
import { DesktopError, publicError } from './files.mjs';
import { StlSaveError } from './save-stl.mjs';
import { saveModelFile, assertPermanentSaveTarget } from './save-model.mjs';
import { cacheDirectoryBytes, clearOwnedCacheDirectory, createMapCache } from './map-cache.mjs';
import { createSessionStore } from './session.mjs';

const VERSION = '0.4.7';
const developmentRoot = fileURLToPath(new URL('../../', import.meta.url));
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataDirectory = argument('data-dir');
const runtimeCheckDirectory = argument('runtime-check');
const runtimeCheckRoute = argument('runtime-check-route') ?? argument('runtime-check-gpx');
const runtimeCheckLocalRoute = argument('runtime-check-local-route') ?? argument('runtime-check-local-gpx');
const runtimeCheckDem = argument('runtime-check-dem');
const runtimeCheckImage = argument('runtime-check-image');
const runtimeCheckImageMode = argument('runtime-check-image-mode') ?? 'local';
const captureDirectory = argument('capture-dir');
const sizeMatch = /^(\d{3,4})x(\d{3,4})$/.exec(argument('window-size') ?? '');
const requestedSize = sizeMatch && Number(sizeMatch[1]) >= 960 && Number(sizeMatch[1]) <= 3840 && Number(sizeMatch[2]) >= 720 && Number(sizeMatch[2]) <= 2160
  ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : { width: 1280, height: 900 };
app.setName('TerrainWorkshop');
protocol.registerSchemesAsPrivileged([{ scheme: 'terrain-map', privileges: { standard: true, secure: true } }]);
let window, manager, quitting = false;
if (dataDirectory) { mkdirSync(resolve(dataDirectory), { recursive: true }); app.setPath('userData', resolve(dataDirectory)); }
async function boot() {

function safeError(error) {
  if (error instanceof StlSaveError) return { code: error.code, message: error.message +
    (error.recoveryPath ? ` 原文件备份保存在：${error.recoveryPath}` : '') };
  return publicError(error);
}

await app.whenReady();
const applicationRoot = app.isPackaged ? app.getAppPath() : developmentRoot;
const coreModuleUrl = pathToFileURL(join(applicationRoot, app.isPackaged ? 'core/index.js' : 'dist/src/index.js')).href;
const rendererFile = join(applicationRoot, app.isPackaged ? 'renderer/index.html' : 'desktop/dist/renderer/index.html');
const taskRoot = join(app.getPath('userData'), 'tasks', randomUUID());
const userDataDirectory = app.getPath('userData'), demCacheDir = join(userDataDirectory, 'elevation-cache');
const imageCacheDir = join(userDataDirectory, 'surface-cache');
const mapCacheDir = join(userDataDirectory, 'map-tiles');
const mapCache = createMapCache({ cacheDir: mapCacheDir, fetchImpl: (url, options) => net.fetch(url, options), version: VERSION });
protocol.handle('terrain-map', async request => {
  try { return new Response(await mapCache.get(request.url), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' } }); }
  catch { return new Response(null, { status: 404 }); }
});
let activeJob, cacheClearing = false, pendingStarts = 0;
await mkdir(taskRoot, { recursive: true });
manager = createDesktopManager({ taskRoot, coreModuleUrl, demCacheDir, imageCacheDir,
  workerFactory: ({ workerPath, taskDir }) => utilityProcess.fork(workerPath, [], { cwd: taskDir, stdio: 'pipe', serviceName: 'Terrain model generator' }),
  onLargeRoute: async ({ fileName, bytes }) => {
    if (!window || window.isDestroyed()) return;
    await dialog.showMessageBox(window, { type: 'info', title: '大文件导入提醒',
      message: '路线文件较大，计算时间会延长。',
      detail: `${fileName}（${(bytes / 1024 / 1024).toFixed(2)} MB）\n文件超过 2 MB，请耐心等待读取和处理。`,
      buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true });
  },
  onJob: job => {
    if (['running', 'cancelling'].includes(job.state)) activeJob = job.id;
    else if (activeJob === job.id) activeJob = undefined;
    if (window && !window.isDestroyed()) window.webContents.send('terrain:job', job);
    if (captureDirectory && job.state === 'succeeded') setTimeout(() => void captureWindow('model').catch(error => console.error(error.message)), 2000);
  },
});
const sessions = createSessionStore({ userDataDirectory, manager });
if (runtimeCheckDirectory) {
  try {
    const { checkRuntime } = await import(process.argv.includes('--runtime-check-snow') ? './runtime-check-snow.mjs' : './runtime-check.mjs');
    const report = await checkRuntime({ app, manager, routePath: runtimeCheckLocalRoute, demPath: runtimeCheckDem, imagePath: runtimeCheckImage,
      destination: runtimeCheckDirectory, onlineRoutePath: runtimeCheckRoute, imageMode: runtimeCheckImageMode });
    console.log(JSON.stringify({ passed: report.passed, runtime: report.runtime, result: report.job.result, saved: report.saved }));
    await manager.close(); app.exit(0);
  } catch (error) { console.error(error); await manager.close(); app.exit(1); }
  return;
}
async function captureWindow(label) {
  if (!captureDirectory || !window || window.isDestroyed()) return;
  await mkdir(resolve(captureDirectory), { recursive: true });
  const [width, height] = window.getContentSize();
  const screenshot = await window.webContents.capturePage();
  const imageBytes = screenshot.toPNG();
  const capturePath = join(resolve(captureDirectory), `${label}-${width}x${height}`);
  await writeFile(`${capturePath}.png`, imageBytes);
  await writeFile(`${capturePath}.window.json`, JSON.stringify({ capturedAt: new Date().toISOString(), label,
    bounds: window.getBounds(), contentBounds: window.getContentBounds(), screenshotSize: { width: imageBytes.readUInt32BE(16), height: imageBytes.readUInt32BE(20) },
    nativeImageSize: screenshot.getSize(),
    zoomFactor: window.webContents.getZoomFactor(), scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor }, null, 2));
}

function handle(channel, operation) {
  ipcMain.handle(`terrain:${channel}`, async (event, ...args) => {
    try {
      if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame) throw new DesktopError('IPC_DENIED', '此操作无法从当前窗口执行');
      return { ok: true, value: await operation(...args) };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  });
}

handle('runtime', () => ({ version: VERSION, electron: process.versions.electron, node: process.versions.node,
  platform: process.platform, packaged: app.isPackaged, units: 'mm' }));
handle('session-get', () => sessions.getSession());
handle('session-save', request => sessions.saveSession(request));
handle('session-restore', () => sessions.restoreSession());
handle('choose-route', async () => {
  const selection = await dialog.showOpenDialog(window, { title: '导入徒步路线', filters: [{ name: 'GPX / KML 路线', extensions: ['gpx', 'kml'] }], properties: ['openFile'] });
  return selection.canceled ? null : manager.addRoute(selection.filePaths[0]);
});
handle('choose-dem', async () => {
  const selection = await dialog.showOpenDialog(window, { title: '选择本地高程文件', filters: [{ name: 'GeoTIFF 高程', extensions: ['tif', 'tiff'] }], properties: ['openFile'] });
  return selection.canceled ? null : manager.addDem(selection.filePaths[0]);
});
handle('import-route', path => manager.addRoute(path));
handle('import-dem', path => manager.addDem(path));
handle('choose-image',async()=>{
  const selection=await dialog.showOpenDialog(window,{title:'选择彩色地表影像',filters:[{name:'RGB 地表 GeoTIFF',extensions:['tif','tiff']}],properties:['openFile']});
  return selection.canceled?null:manager.addImage(selection.filePaths[0]);
});
handle('import-image',path=>manager.addImage(path));
handle('remove-image',id=>manager.removeImage(id));
handle('inspect', async request => {
  const inspection = await manager.inspect(request);
  if (captureDirectory) setTimeout(() => void captureWindow('map').catch(error => console.error(error.message)), 1500);
  return inspection;
});
handle('start', async request => {
  if (cacheClearing) throw new DesktopError('CACHE_BUSY', '正在清理缓存，请稍后生成');
  pendingStarts++;
  try { return await manager.start(request); }
  finally { pendingStarts--; }
});
handle('cache-info', async () => ({ path: userDataDirectory,
  elevationBytes: await cacheDirectoryBytes(demCacheDir), mapBytes: await cacheDirectoryBytes(mapCacheDir),
  imageBytes: await cacheDirectoryBytes(imageCacheDir) }));
handle('clear-cache', async () => {
  if (activeJob || pendingStarts || cacheClearing) throw new DesktopError('CACHE_BUSY', '生成任务结束后才能清理缓存');
  cacheClearing = true;
  try { await mapCache.clear(); await clearOwnedCacheDirectory(userDataDirectory, 'elevation-cache');
    await clearOwnedCacheDirectory(userDataDirectory, 'surface-cache'); return { cleared: true }; }
  finally { cacheClearing = false; }
});
handle('cancel', id => manager.cancel(id));
handle('get', id => manager.get(id));
handle('preview', id => manager.preview(id));
handle('save', async id => {
  const artifact = await manager.artifact(id);
  const chosen = await dialog.showSaveDialog(window, {
    title: '保存一体打印模型', defaultPath: join(app.getPath('downloads'), artifact.downloadName),
    filters: [{ name: 'STL 打印模型（单位：mm）', extensions: ['stl'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (chosen.canceled || !chosen.filePath) return { cancelled: true };
  const originalPath = chosen.filePath;
  const targetPath = extname(originalPath).toLowerCase() === '.stl' ? originalPath : `${originalPath}.stl`;
  // The native dialog confirmed the original name. An appended extension can
  // refer to a different existing file and needs its own overwrite decision.
  if (targetPath !== originalPath && existsSync(targetPath)) {
    const choice = await dialog.showMessageBox(window, { type: 'question', title: '确认覆盖 STL',
      message: '此 STL 文件已存在，是否覆盖？', detail: targetPath, buttons: ['取消', '覆盖'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return { cancelled: true };
  }
  assertPermanentSaveTarget(targetPath,taskRoot);
  const frozen=await manager.exportModel(id,'stl');
  const saved = await saveModelFile(frozen.bytes, targetPath, { sourcePath:artifact.path,expectedSha256:artifact.stlSha256,overwriteApproved:true });
  if (saved.warnings.length) await dialog.showMessageBox(window, { type: 'warning', title: 'STL 已保存', message: saved.warnings.join('\n') });
  return { cancelled: false, path: saved.path, bytes: saved.bytes, sha256: saved.sha256 };
});
handle('save-model',async request=>{
  if(!request||typeof request!=='object'||Object.keys(request).some(key=>!['id','format','options'].includes(key)))throw new DesktopError('CONFIG_INVALID','保存参数无效');
  const artifact=await manager.exportModel(request.id,request.format,request.options);
  const label=artifact.format==='3mf'?'彩色 3MF':artifact.format==='obj'?'OBJ 材质包':'STL 形状';
  const chosen=await dialog.showSaveDialog(window,{title:`保存${label}`,defaultPath:join(app.getPath('downloads'),artifact.downloadName),filters:[{name:`${label}（毫米）`,extensions:[artifact.extension.slice(1)]}],properties:['showOverwriteConfirmation','createDirectory']});
  if(chosen.canceled||!chosen.filePath)return{cancelled:true};
  const target=extname(chosen.filePath).toLowerCase()===artifact.extension?chosen.filePath:`${chosen.filePath}${artifact.extension}`;
  if(target!==chosen.filePath&&existsSync(target)){
    const decision=await dialog.showMessageBox(window,{type:'question',title:'确认覆盖打印文件',message:'此打印文件已存在，是否覆盖？',detail:target,buttons:['取消','覆盖'],defaultId:0,cancelId:0});
    if(decision.response!==1)return{cancelled:true};
  }
  assertPermanentSaveTarget(target,taskRoot);
  let saved;
  if(artifact.format==='stl') {
    const source=await manager.artifact(request.id);
    saved=await saveModelFile(artifact.bytes,target,{sourcePath:source.path,expectedSha256:source.stlSha256,overwriteApproved:true});
  } else saved=await saveModelFile(artifact.bytes,target,{overwriteApproved:true});
  if(saved.warnings.length)await dialog.showMessageBox(window,{type:'warning',title:'打印文件已保存',message:saved.warnings.join('\n')});
  return{cancelled:false,path:saved.path,bytes:saved.bytes,sha256:saved.sha256,appearanceHash:artifact.appearanceHash};
});

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: '文件', submenu: [{ label: '退出', role: 'quit' }] },
  { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' },
    { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
  { label: '帮助', submenu: [{ label: '第三方许可', click: () => shell.openPath(join(applicationRoot, app.isPackaged ? 'licenses' : 'desktop/licenses')) },
    { label: '关于徒步地形工坊', click: () => dialog.showMessageBox(window, { type: 'info', title: '徒步地形工坊',
    message: `徒步地形工坊 ${VERSION}`, detail: '导入 GPX 或 KML 与高程，使用彩色地表影像区分草地、山石，可选地形适配积雪，路线使用独立颜色。支持最多四色的 3MF、OBJ 材质包及 STL；彩色文件保留有厚度的白色雪层。\n实际打印需在目标切片软件中确认耗材映射，可恢复上次项目。' }) }] },
]));

window = new BrowserWindow({ title: '徒步地形工坊', ...requestedSize, minWidth: 960, minHeight: 720,
  backgroundColor: '#f5f6f4', show: true, webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    contextIsolation: true, nodeIntegration: false, sandbox: true }, });
window.webContents.setWindowOpenHandler(({ url }) => {
  if (url === 'https://www.openstreetmap.org/copyright') void shell.openExternal(url);
  return { action: 'deny' };
});
window.webContents.on('will-navigate', event => event.preventDefault());
window.once('ready-to-show', () => window.show());
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void sessions.close().finally(() => Promise.allSettled([manager.close(), mapCache.close()])).finally(() => app.quit());
});
try { await window.loadFile(rendererFile); window.show(); }
catch { await dialog.showMessageBox({ type: 'error', title: '启动失败', message: '无法加载程序界面，请解压完整软件文件夹后重试。' }); app.quit(); }
if (captureDirectory) {
  setTimeout(() => void captureWindow('startup').catch(error => console.error(error.message)), 1500);
  let resizeTimer;
  window.on('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => void captureWindow('window').catch(error => console.error(error.message)), 1000); });
}
}
void boot().catch(error => { console.error(error); app.exit(1); });
