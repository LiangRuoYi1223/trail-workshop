import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopError, checkedInput, publicError, removeOwnedTask, validateOptions, verifyOutput } from './files.mjs';

const MAX_GPX_BYTES = 2 * 1024 * 1024;
const MAX_DEM_BYTES = 256 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const downloadName = name => `${String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '徒步地形'}_一体地形.stl`;
const safeSourceText = value => typeof value === 'string' && !/[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|[\x00-\x1f]/.test(value)
  ? value.slice(0, 250) : undefined;
function sourceSummary(metadata, mode) {
  const provider = safeSourceText(metadata?.provider) ?? (mode === 'auto' ? 'copernicus-glo30' : 'local-geotiff');
  const dataset = safeSourceText(metadata?.dataset ?? metadata?.source?.dataset);
  return { provider, ...(dataset ? { dataset } : {}),
    ...(typeof metadata?.cacheHit === 'boolean' ? { cacheHit: metadata.cacheHit } : {}),
    ...(Number.isInteger(metadata?.tileCount) && metadata.tileCount > 0 ? { tileCount: metadata.tileCount } : {}) };
}

export function createDesktopManager({ taskRoot, coreModuleUrl, workerFactory, demCacheDir, onJob = () => {}, jobTimeoutMs = 180000 }) {
  if (typeof taskRoot !== 'string' || !taskRoot || typeof coreModuleUrl !== 'string' || !coreModuleUrl.startsWith('file:')
    || typeof workerFactory !== 'function' || !Number.isFinite(jobTimeoutMs) || jobTimeoutMs <= 0
    || (demCacheDir !== undefined && (typeof demCacheDir !== 'string' || !demCacheDir || demCacheDir.includes('\0')))) throw new DesktopError('CONFIG_INVALID', '桌面任务配置无效');
  const root = resolve(taskRoot), cacheDir = demCacheDir === undefined ? undefined : resolve(demCacheDir), corePromise = import(coreModuleUrl);
  corePromise.catch(() => {});
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const routes = new Map(), dems = new Map(), jobs = new Map();
  let active, closed = false, pruning = Promise.resolve();
  const ensureOpen = () => { if (closed) throw new DesktopError('APP_CLOSED', '软件正在退出'); };
  const emit = job => { try { onJob(copy(job.public)); } catch { /* UI observers cannot change task ownership. */ } };
  const find = id => {
    const job = jobs.get(id);
    if (!job) throw new DesktopError('JOB_NOT_FOUND', '找不到该生成任务，请重新生成');
    return job;
  };
  const cleanup = async job => {
    try { await removeOwnedTask(root, job.taskDir, job.public.id); }
    catch { job.public.cleanupWarning = '临时任务清理失败，下次启动可清理'; }
  };
  const finish = async (job, state, error) => {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    if (state !== 'succeeded') await cleanup(job);
    job.public.state = state;
    job.public.message = state === 'succeeded' ? '一体模型已生成，可以保存 STL' : state === 'cancelled' ? '已取消，可重新生成' : error.message;
    if (error) job.public.error = error;
    if (active === job.public.id) active = undefined;
    emit(job);
    pruning = pruning.then(async () => {
      // Keep recent successes through repeated failed attempts, while bounding
      // large preview meshes and diagnostic history for a long-running session.
      for (const [successful, keep] of [[true, 3], [false, 7]]) {
        const completed = [...jobs.values()].filter(item => item.finished && (item.public.state === 'succeeded') === successful);
        for (const stale of completed.slice(0, Math.max(0, completed.length - keep))) {
          await cleanup(stale); stale.verified = undefined; jobs.delete(stale.public.id);
        }
      }
    }).catch(() => {});
    job.doneResolve();
  };
  const settleAfterExit = async job => {
    if (!job.exited || job.finished) return;
    if (job.stopReason) return finish(job, job.stopReason.state, job.stopReason.error);
    if (job.completion) {
      try {
        const verified = await job.completion;
        if (job.stopReason) return finish(job, job.stopReason.state, job.stopReason.error);
        job.verified = verified;
        job.public.progress = 1;
        job.public.result = { dimensions: verified.dimensions, triangleCount: verified.triangleCount,
          downloadName: downloadName(job.public.routeName), stlSha256: verified.stlSha256,
          demSource: sourceSummary(verified.preview.report.dem, job.public.demMode) };
        return finish(job, 'succeeded');
      } catch (error) {
        if (job.stopReason) return finish(job, job.stopReason.state, job.stopReason.error);
        return finish(job, 'failed', publicError(error, '生成结果校验失败，请重试'));
      }
    }
    return finish(job, 'failed', { code: 'WORKER_CRASHED', message: '计算进程意外结束，请降低精度后重试' });
  };
  const stop = (job, reason) => {
    if (job.finished || job.stopReason) return;
    job.stopReason = reason;
    if (reason.state === 'cancelled') {
      job.public.state = 'cancelling'; job.public.message = '正在取消计算'; emit(job);
    }
    if (job.child && !job.exited) {
      try { job.child.kill(); } catch { /* Exit, rather than a kill return value, releases the slot. */ }
    } else if (job.exited) void settleAfterExit(job);
  };
  return {
    async addRoute(path, { isSample = false, expectedSha256 } = {}) {
      ensureOpen();
      const file = await checkedInput(path, ['.gpx'], MAX_GPX_BYTES, 'GPX 路线');
      let contents;
      try { contents = await readFile(file.path); }
      catch { throw new DesktopError('INPUT_READ_FAILED', '无法读取 GPX，请检查文件权限'); }
      if (contents.length > MAX_GPX_BYTES) throw new DesktopError('INPUT_TOO_LARGE', 'GPX 文件超过 2 MB，请先简化路线');
      const digest = sha256(contents), xml = contents.toString('utf8');
      if (expectedSha256 !== undefined && digest !== expectedSha256) throw new DesktopError('SESSION_INPUT_CHANGED', '上次路线文件已改变，请重新导入');
      let parsed;
      try { parsed = (await corePromise).parseGpxXml(xml, { fileName: file.fileName }); }
      catch (error) { const issue = publicError(error, 'GPX 无效，请重新从徒步软件导出'); throw new DesktopError(issue.code, issue.message); }
      if (parsed.sourcePointCount > 50000) throw new DesktopError('GPX_TOO_COMPLEX', '路线超过 5 万点，请先简化轨迹');
      if (!parsed.segments.some(segment => segment.points.length >= 2)) throw new DesktopError('GPX_TOO_SHORT', '路线须至少包含一个有两个有效点的连续段');
      if (parsed.crossesAntimeridian || parsed.segments.some(segment => segment.points.some(point => Math.abs(point.lat) > 80))) throw new DesktopError('GEO_UNSUPPORTED', '暂不支持跨日期变更线或纬度超过 ±80° 的路线');
      const info = { id: randomUUID(), fileName: file.fileName, name: parsed.name ?? basename(file.fileName, '.gpx'),
        pointCount: parsed.pointCount, segmentCount: parsed.segmentCount, distanceKm: parsed.distanceKm,
        invalidPointCount: parsed.invalidPointCount, segments: parsed.segments.map(segment => segment.points.map(point => ({ lat: point.lat, lon: point.lon }))),
        isSample: Boolean(isSample) };
      routes.set(info.id, { info, xml, source: { path: file.path, fileName: file.fileName, bytes: contents.length, sha256: digest, isSample: Boolean(isSample) } });
      return copy(info);
    },
    async addDem(path, { isSample = false, dataset, expectedSha256, validate = false } = {}) {
      ensureOpen();
      const file = await checkedInput(path, ['.tif', '.tiff'], MAX_DEM_BYTES, 'GeoTIFF 高程');
      const hash = createHash('sha256'); let bytes = 0;
      try {
        for await (const chunk of createReadStream(file.path)) {
          bytes += chunk.length;
          if (bytes > MAX_DEM_BYTES) throw new DesktopError('INPUT_TOO_LARGE', 'GeoTIFF 高程文件超过 256 MB，请先裁剪');
          hash.update(chunk);
        }
      } catch (error) { if (error instanceof DesktopError) throw error; throw new DesktopError('INPUT_READ_FAILED', '无法读取高程文件，请检查文件权限'); }
      const digest = hash.digest('hex');
      if (bytes !== file.bytes || (expectedSha256 !== undefined && digest !== expectedSha256)) throw new DesktopError('SESSION_INPUT_CHANGED', '上次高程文件已改变，请重新选择');
      if (validate) {
        try {
          const sampler = await (await corePromise).loadLocalDem(file.path);
          if (sampler.metadata.sha256 !== digest) throw new DesktopError('SESSION_INPUT_CHANGED', '上次高程文件已改变，请重新选择');
        } catch (error) { const issue = publicError(error, '高程文件无法解析，请重新选择有效的 GeoTIFF'); throw new DesktopError(issue.code, issue.message); }
      }
      const info = { id: randomUUID(), fileName: file.fileName, bytes: file.bytes, isSample: Boolean(isSample),
        ...(typeof dataset === 'string' ? { dataset: dataset.slice(0, 250) } : {}) };
      dems.set(info.id, { info, path: file.path, source: { path: file.path, fileName: file.fileName, bytes, sha256: digest, isSample: Boolean(isSample),
        ...(info.dataset ? { dataset: info.dataset } : {}) }, ...(isSample ? { sourcePath: file.path.replace(/\.tiff?$/i, '.source.json') } : {}) });
      return copy(info);
    },
    // Main-process-only descriptors. The session IPC returns summaries without paths.
    sessionSources({ routeId, demId } = {}) {
      ensureOpen();
      const route = routeId === undefined ? undefined : routes.get(routeId);
      const dem = demId === undefined ? undefined : dems.get(demId);
      if (routeId !== undefined && !route) throw new DesktopError('ROUTE_NOT_FOUND', '最近项目只接受已导入的路线');
      if (demId !== undefined && !dem) throw new DesktopError('DEM_NOT_FOUND', '最近项目只接受已选择的高程文件');
      return copy({ ...(route ? { route: { ...route.source, name: route.info.name } } : {}), ...(dem ? { dem: dem.source } : {}) });
    },
    async inspect({ routeId, options }) {
      ensureOpen();
      const route = routes.get(routeId);
      if (!route) throw new DesktopError('ROUTE_NOT_FOUND', '请先导入路线');
      const validated = validateOptions(options), core = await corePromise;
      try {
        const frame = core.createTerrainFrame(route.info.segments.flat(), validated);
        let build = core.buildFootprintPolygonMm;
        if (!build) ({ buildFootprintPolygonMm: build } = await import(new URL('./vendor/trailprint/footprint.js', coreModuleUrl)));
        const outlineMm = build(frame.crop) ?? Array.from({ length: 128 }, (_, i) => ({ x: frame.crop.widthMm / 2 * Math.cos(i * 2 * Math.PI / 128), y: frame.crop.widthMm / 2 * Math.sin(i * 2 * Math.PI / 128) }));
        const radius = frame.crop.radiusMm ?? frame.crop.widthMm / 2;
        const controlVerticesMm = build({ ...frame.crop, cornerRadiusMm: 0 })
          ?? [{ x: radius, y: 0 }, { x: 0, y: radius }, { x: -radius, y: 0 }, { x: 0, y: -radius }];
        return { selection: { center: { lat: frame.crop.centerLat, lon: frame.crop.centerLon }, groundWidthM: frame.groundWidthM,
          groundHeightM: frame.groundHeightM, bearingDeg: frame.crop.bearingDeg },
          routeSegmentsMm: route.info.segments.map(segment => segment.map(frame.geoToMm)), outlineMm, controlVerticesMm,
          controlVerticesGeo: controlVerticesMm.map(point => frame.mmToGeo(point.x, point.y)),
          outlineGeo: outlineMm.map(point => frame.mmToGeo(point.x, point.y)), bounds: { ...frame.bounds } };
      } catch (error) { const issue = publicError(error, '无法建立路线取景，请检查尺寸'); throw new DesktopError(issue.code, issue.message); }
    },
    async start({ routeId, demId, demMode, options, offlineOnly = false }) {
      ensureOpen();
      if (active) throw new DesktopError('JOB_BUSY', '已有任务正在计算，请等待或取消后再生成');
      const mode = demMode === undefined ? (demId === undefined ? 'auto' : 'local') : demMode;
      if (!['auto', 'local'].includes(mode) || typeof offlineOnly !== 'boolean') throw new DesktopError('CONFIG_INVALID', '请选择有效的高程来源及离线设置');
      const route = routes.get(routeId), dem = mode === 'local' ? dems.get(demId) : undefined;
      if (!route) throw new DesktopError('ROUTE_NOT_FOUND', '请先导入路线');
      if (mode === 'local' && !dem) throw new DesktopError('DEM_NOT_FOUND', '请选择覆盖该路线的本地高程文件');
      if (mode === 'auto' && !cacheDir) throw new DesktopError('DEM_CACHE_UNAVAILABLE', '自动高程缓存目录未配置，请重新打开软件或选择本地高程');
      const validated = validateOptions(options), core = await corePromise;
      // Compute the same geographic footprint used by inspect and generation.
      // No renderer-supplied bounds or data URLs enter the worker request.
      let bounds;
      try { bounds = Object.freeze({ ...core.createTerrainFrame(route.info.segments.flat(), validated).bounds }); }
      catch (error) { const issue = publicError(error, '无法建立路线取景，请检查尺寸'); throw new DesktopError(issue.code, issue.message); }
      ensureOpen();
      if (active) throw new DesktopError('JOB_BUSY', '已有任务正在计算，请等待或取消后再生成');
      const id = randomUUID();
      const job = { public: { id, state: 'running', progress: 0, message: '准备读取路线与高程', createdAt: new Date().toISOString(),
        routeName: route.info.name, options: validated, demMode: mode, offlineOnly }, taskDir: join(root, id), exited: false, finished: false };
      job.done = new Promise(done => { job.doneResolve = done; });
      jobs.set(id, job); active = id; emit(job);
      try {
        await mkdir(job.taskDir, { recursive: true });
        if (closed || job.stopReason) { job.exited = true; await finish(job, 'cancelled'); return copy(job.public); }
        const child = await workerFactory({ workerPath, taskDir: job.taskDir });
        job.child = child;
        child.once('exit', () => { job.exited = true; void settleAfterExit(job); });
        child.on('error', () => stop(job, { state: 'failed', error: { code: 'WORKER_FAILED', message: '无法启动计算进程，请重新打开软件' } }));
        child.on('message', message => {
          if (message?.jobId !== id || job.stopReason || job.finished) return;
          if (message.type === 'progress' && Number.isFinite(message.progress)) {
            // Only a verified file makes the task complete.
            job.public.progress = Math.max(job.public.progress, Math.min(0.99, Math.max(0, message.progress)));
            job.public.message = typeof message.message === 'string' ? message.message.slice(0, 200) : '正在生成模型'; emit(job);
          } else if (message.type === 'complete' && !job.completion) {
            job.completion = verifyOutput(job.taskDir);
            // Avoid an unhandled rejection while waiting for the process to exit.
            job.completion.catch(() => {});
            job.public.message = '正在核对 STL 与最终预览'; emit(job);
            if (job.exited) void settleAfterExit(job);
          } else if (message.type === 'failure') {
            const issue = publicError(new DesktopError(typeof message.error?.code === 'string' ? message.error.code : 'GENERATION_FAILED',
              typeof message.error?.message === 'string' ? message.error.message : '生成失败，请检查输入数据'));
            stop(job, { state: 'failed', error: issue });
          }
        });
        job.timer = setTimeout(() => stop(job, { state: 'failed', error: { code: 'JOB_TIMEOUT', message: '生成超过 3 分钟，请降低精度或缩小取景后重试' } }), jobTimeoutMs);
        job.timer.unref?.();
        if (closed || job.stopReason) {
          if (!job.stopReason) stop(job, { state: 'cancelled' });
          else { try { child.kill(); } catch { /* Wait for the real exit event. */ } }
        }
        else child.postMessage({ type: 'generate', jobId: id, gpxXml: route.xml, fileName: route.info.fileName, demMode: mode,
          ...(mode === 'local' ? { demPath: dem.path, demSourcePath: dem.sourcePath } : { demCacheDir: cacheDir, offlineOnly }),
          bounds, options: validated, taskDir: job.taskDir, coreModuleUrl });
      } catch (error) {
        if (job.child && !job.exited) stop(job, { state: 'failed', error: publicError(error, '无法启动计算任务，请检查临时目录权限') });
        else {
          job.exited = true;
          if (job.stopReason) await finish(job, job.stopReason.state, job.stopReason.error);
          else await finish(job, 'failed', publicError(error, '无法启动计算任务，请检查临时目录权限'));
        }
      }
      return copy(job.public);
    },
    cancel(id) {
      const job = find(id);
      if (!job.finished) stop(job, { state: 'cancelled' });
      return copy(job.public);
    },
    get(id) { return copy(find(id).public); },
    async preview(id) {
      ensureOpen();
      const job = find(id);
      if (job.public.state !== 'succeeded' || !job.verified) throw new DesktopError('RESULT_UNAVAILABLE', '该任务尚无可用模型');
      return copy(job.verified.preview);
    },
    async artifact(id) {
      ensureOpen();
      const job = find(id);
      if (job.public.state !== 'succeeded' || !job.verified) throw new DesktopError('RESULT_UNAVAILABLE', '该任务尚无可保存的 STL');
      // Saving rechecks the bytes; root's save helper also verifies this digest.
      const bytes = await readFile(job.verified.path).catch(() => { throw new DesktopError('OUTPUT_READ_FAILED', '生成文件已不存在，请重新生成'); });
      const { createHash } = await import('node:crypto');
      if (createHash('sha256').update(bytes).digest('hex') !== job.verified.stlSha256) throw new DesktopError('OUTPUT_MISMATCH', '生成文件已改变，请重新生成');
      return { path: job.verified.path, bytes: job.verified.bytes, stlSha256: job.verified.stlSha256, downloadName: job.public.result.downloadName };
    },
    async close() {
      closed = true;
      for (const job of jobs.values()) if (!job.finished) stop(job, { state: 'cancelled' });
      await Promise.all([...jobs.values()].map(job => job.done));
      await pruning;
      await Promise.all([...jobs.values()].map(async job => { await cleanup(job); job.verified = undefined; }));
    },
  };
}
