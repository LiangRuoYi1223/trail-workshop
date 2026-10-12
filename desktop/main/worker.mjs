import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { publicError } from './files.mjs';

const electronPort = process.parentPort;
if (electronPort) {
  // The dedicated Electron worker shares the map's system proxy settings.
  // Both DEM GeoTIFF ranges and Sentinel acquisition call the global fetch.
  const { net } = createRequire(import.meta.url)('electron');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = input instanceof URL ? input.href : input;
    const url = typeof target === 'string' ? target : target?.url;
    // GeoTIFF decoders load embedded WASM via data:, unsupported by net.fetch.
    return /^https?:/i.test(url) ? net.fetch(target, init) : nativeFetch(input, init);
  };
}
const port = electronPort ?? (typeof process.send === 'function' ? {
  on: (name, callback) => process.on(name, callback), postMessage: message => process.send(message),
} : undefined);
if (!port) throw new Error('This module must run inside a desktop utility process.');
let started = false;
port.on('message', async event => {
  const message = electronPort ? event.data : event;
  if (started || message?.type !== 'generate') return;
  started = true;
  const send = value => port.postMessage({ ...value, jobId: message.jobId });
  const controller = new AbortController(), automaticImage = message.imageMode === 'auto';
  const localImage = message.imageMode !== 'none' && !automaticImage && message.imagePath !== undefined;
  const imageLookbackMonths = message.imageLookbackMonths === undefined ? 24 : message.imageLookbackMonths;
  const acquisition = { dem: { state: 'running', progress: 0, message: '准备读取高程' },
    ...(automaticImage || localImage ? { image: { state: 'running', progress: 0, message: '准备读取地表影像' } } : {}) };
  const acquisitionProgress = (branch, value, state = 'running') => {
    if (controller.signal.aborted || !Number.isFinite(value?.progress)) return;
    acquisition[branch] = { ...acquisition[branch], ...value, state, progress: Math.max(0, Math.min(1, value.progress)),
      message: typeof value.message === 'string' ? value.message : branch === 'image' ? '正在读取地表影像' : '正在读取高程' };
    const progress = automaticImage ? 0.02 + acquisition.dem.progress * 0.26 + acquisition.image.progress * 0.26
      : 0.14 + acquisition.dem.progress * 0.22;
    send({ type: 'progress', phase: 'acquire', acquisition: structuredClone(acquisition), progress,
      message: typeof value.message === 'string' ? value.message : '正在读取地表影像与高程' });
  };
  const sameBounds = bounds => message.bounds && ['west', 'south', 'east', 'north'].every(key =>
    Number.isFinite(message.bounds[key]) && message.bounds[key] === bounds[key]);
  try {
    send({ type: 'progress', phase: 'prepare', progress: 0.01, message: '正在检查路线和取景范围' });
    const core = await import(message.coreModuleUrl);
    const route = core.parseRouteXml(message.gpxXml, { fileName: message.fileName });
    const bounds = core.createTerrainFrame(route.segments.flatMap(segment => segment.points), message.options).bounds;
    if (automaticImage && (![12, 24].includes(imageLookbackMonths) || typeof message.imageCacheDir !== 'string' || !message.imageCacheDir || typeof message.imageOfflineOnly !== 'boolean' || !sameBounds(bounds))) {
      throw Object.assign(new Error('自动地表影像取景校验失败，请重试或切换本地导入'), { code: 'IMAGE_REQUEST_INVALID' });
    }
    if (message.demMode === 'auto' && (typeof message.demCacheDir !== 'string' || !message.demCacheDir || typeof message.offlineOnly !== 'boolean' || !sameBounds(bounds))) {
      throw Object.assign(new Error('自动高程取景校验失败，请重新生成'), { code: 'DEM_REQUEST_INVALID' });
    }
    let image, imageSource, dem;
    send({ type: 'progress', phase: 'acquire', acquisition: structuredClone(acquisition), progress: 0.02,
      message: '正在并行读取高程与地表影像' });
    const acquireImage = async () => {
      if (automaticImage) {
        try {
          ({ image, source: imageSource } = await core.loadSentinelColorImage(bounds, {
            cacheDir: message.imageCacheDir, offlineOnly: message.imageOfflineOnly, lookbackMonths: imageLookbackMonths, signal: controller.signal,
            onProgress: value => acquisitionProgress('image', value),
          }));
          if (!image || !imageSource) throw Object.assign(new Error('自动地表影像未返回完整的有效数据'), { code: 'IMAGE_ACQUISITION_FAILED' });
        } catch (error) {
          const issue = publicError(error, '无法获取自动地表影像，请检查网络后重试或切换本地导入 RGB GeoTIFF');
          if (/^(SESSION|CONFIG|GPX|KML|GEO)_/.test(issue.code)) throw Object.assign(new Error(issue.message), { code: issue.code });
          throw Object.assign(new Error(/重试/.test(issue.message) && /本地/.test(issue.message) ? issue.message
            : `${issue.message}；请重试或切换本地导入 RGB GeoTIFF`), { code: issue.code.startsWith('IMAGE_') ? issue.code : 'IMAGE_ACQUISITION_FAILED' });
        }
      } else if (localImage) {
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(message.imagePath)) {
          controller.signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > 64 * 1024 * 1024) throw Object.assign(new Error('地表影像超过 64 MB，请先裁剪'), { code: 'IMAGE_FILE_TOO_LARGE' });
          hash.update(chunk);
        }
        if (hash.digest('hex') !== message.imageSha256) throw Object.assign(new Error('地表影像文件已改变，请重新选择后生成'), { code: 'SESSION_INPUT_CHANGED' });
        image = await core.loadColorGeoTiff(message.imagePath);
        if (image.metadata.sha256 !== message.imageSha256) throw Object.assign(new Error('地表影像文件已改变，请重新选择后生成'), { code: 'SESSION_INPUT_CHANGED' });
      }
      controller.signal.throwIfAborted();
      if (acquisition.image) acquisitionProgress('image', { progress: 1, message: '地表影像读取完成' }, 'complete');
    };
    const acquireDem = async () => {
      if (message.demMode === 'auto') {
        dem = await core.loadCopernicusDem(bounds, { cacheDir: message.demCacheDir, offlineOnly: message.offlineOnly, signal: controller.signal,
          onProgress: value => acquisitionProgress('dem', value) });
      } else {
        dem = await core.loadLocalDem(message.demPath);
        if (message.demSha256 !== undefined && dem.metadata.sha256 !== message.demSha256) {
          throw Object.assign(new Error('高程文件已改变，请重新选择后生成'), { code: 'SESSION_INPUT_CHANGED' });
        }
        // Public sample attribution is attached only when its file digest matches.
        if (message.demSourcePath) {
          try {
            const source = JSON.parse(await readFile(message.demSourcePath, 'utf8'));
            if (source.sha256 === dem.metadata.sha256) dem.metadata = { ...dem.metadata, source: {
              sha256: source.sha256, dataset: source.dataset, sourceUrl: source.sourceUrl,
              registry: source.registry, attribution: source.attribution, accessedAt: source.accessedAt,
            } };
          } catch { /* A missing optional attribution file never changes the measured DEM. */ }
        }
      }
      controller.signal.throwIfAborted();
      if (!dem || typeof dem.sample !== 'function') throw Object.assign(new Error('高程未返回完整的有效数据'), { code: 'DEM_ACQUISITION_FAILED' });
      acquisitionProgress('dem', { progress: 1, message: '高程读取完成' }, 'complete');
    };
    // Attach rejection handlers to both branches before starting either one.
    // The first failure aborts its peer immediately; Promise.all observes both rejections.
    const acquire = operation => Promise.resolve().then(operation).catch(error => {
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    });
    const acquisitions = [acquire(acquireDem), acquire(acquireImage)];
    try { await Promise.all(acquisitions); }
    catch (error) {
      // Cooperating readers must finish abort cleanup before the process exits.
      // A reader that ignores abort cannot hold the failed job indefinitely.
      let cleanupTimer;
      try {
        await Promise.race([Promise.allSettled(acquisitions), new Promise(done => { cleanupTimer = setTimeout(done, 1000); })]);
      } finally { clearTimeout(cleanupTimer); }
      throw error;
    }
    controller.signal.throwIfAborted();
    const modelStart = automaticImage ? 0.54 : 0.36;
    send({ type: 'progress', phase: 'model', acquisition: structuredClone(acquisition), progress: modelStart, message: '地表影像与高程已就绪，正在生成模型' });
    const result = await core.generatePrintableTerrain({
      gpxXml: message.gpxXml, fileName: message.fileName, options: message.options,
      signal: controller.signal,
      loadDem: async modelBounds => {
        controller.signal.throwIfAborted();
        // Reuse only the DEM acquired for the independently checked footprint.
        if (['west', 'south', 'east', 'north'].some(key => modelBounds[key] !== bounds[key])
          || (message.demMode === 'auto' && !sameBounds(modelBounds))) {
          throw Object.assign(new Error('自动高程取景校验失败，请重新生成'), { code: 'DEM_REQUEST_INVALID' });
        }
        return dem;
      },
      onProgress: value => send({ type: 'progress', phase: 'model', progress: modelStart + value.progress * (0.98 - modelStart), message: value.message }),
    });
    if (result.mesh.indices.length / 3 > 500000) throw Object.assign(new Error('模型超过 50 万三角面，请降低精度'), { code: 'MESH_TOO_COMPLEX' });
    const selection = result.report.selection;
    const appearanceSelection = { center: selection.center, bearingDeg: selection.bearingDeg, mmPerMeter: selection.mmPerMeter };
    result.appearance = core.buildModelAppearance(result.mesh, appearanceSelection, message.appearanceOptions, image);
    if (result.mesh.materialParts) {
      for (const part of result.mesh.materialParts) {
        controller.signal.throwIfAborted();
        part.faceClasses = core.buildModelAppearance(part, appearanceSelection, message.appearanceOptions, image).faceClasses;
      }
      core.validateMaterialParts(result.mesh);
    }
    core.validateModelAppearance(result.appearance, result.mesh.indices.length / 3);
    if (imageSource) result.report.imageSource = imageSource;
    controller.signal.throwIfAborted();
    await core.publishTerrainOutput(resolve(message.taskDir, 'model.stl'), result);
    send({ type: 'complete' });
  } catch (error) {
    send({ type: 'failure', error: publicError(error, '生成失败，请检查路线与高程数据后重试') });
  } finally {
    controller.abort();
    // Give utilityProcess IPC time to deliver the final message before exit.
    setTimeout(() => process.exit(0), 25);
  }
});
