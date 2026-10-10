import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicError } from './files.mjs';

const electronPort = process.parentPort;
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
  try {
    const core = await import(message.coreModuleUrl);
    const result = await core.generatePrintableTerrain({
      gpxXml: message.gpxXml, fileName: message.fileName, options: message.options,
      loadDem: async (bounds, context) => {
        if (message.demMode === 'auto') {
          if (typeof message.demCacheDir !== 'string' || !message.demCacheDir || typeof message.offlineOnly !== 'boolean'
            || !message.bounds || ['west', 'south', 'east', 'north'].some(key => !Number.isFinite(message.bounds[key]) || message.bounds[key] !== bounds[key])) {
            throw Object.assign(new Error('自动高程取景校验失败，请重新生成'), { code: 'DEM_REQUEST_INVALID' });
          }
          return core.loadCopernicusDem(bounds, { cacheDir: message.demCacheDir, offlineOnly: message.offlineOnly, signal: context.signal,
            onProgress: value => {
              if (!Number.isFinite(value?.progress)) return;
              send({ type: 'progress', phase: 'dem', progress: 0.14 + Math.max(0, Math.min(1, value.progress)) * 0.22,
                message: typeof value.message === 'string' ? value.message : '正在获取高程数据' });
            },
          });
        }
        const dem = await core.loadLocalDem(message.demPath);
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
        return dem;
      },
      onProgress: progress => send({ type: 'progress', ...progress }),
    });
    if (result.mesh.indices.length / 3 > 500000) throw Object.assign(new Error('模型超过 50 万三角面，请降低精度'), { code: 'MESH_TOO_COMPLEX' });
    await core.publishTerrainOutput(resolve(message.taskDir, 'model.stl'), result);
    send({ type: 'complete' });
  } catch (error) {
    send({ type: 'failure', error: publicError(error, '生成失败，请检查路线与高程数据后重试') });
  } finally {
    // Give utilityProcess IPC time to deliver the final message before exit.
    setTimeout(() => process.exit(0), 25);
  }
});
