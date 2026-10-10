import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { saveModelStl } from './save-stl.mjs';

// Invoked explicitly by the packaging smoke check, outside the renderer bridge.
export async function checkRuntime({ app, manager, fixtureRoot, demSample, destination, onlineRoutePath }) {
  const outputRoot = resolve(destination);
  await mkdir(outputRoot, { recursive: true });
  const runtime = { packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node,
    applicationRoot: app.getAppPath(), platform: process.platform };
  try {
    if (!runtime.packaged) throw new Error('Runtime verification must use the packaged executable.');
    const route = await manager.addRoute(join(fixtureRoot, 'sample-trail.gpx'), { isSample: true });
    const dem = await manager.addDem(demSample, { isSample: true });
    const options = { shape: 'rectangle', widthMm: 120, heightMm: 80, baseThicknessMm: 2, zExaggeration: 2,
      gridColumns: 129, smoothing: 'raw', bearingDeg: 0, paddingFraction: .1, routeWidthMm: 1, frameWidthMm: 3 };
    const waitFor = async id => {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const job = manager.get(id);
        if (!['running', 'cancelling'].includes(job.state)) return job;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('Packaged task did not settle within 180 seconds.');
    };
    const interrupted = await manager.start({ routeId: route.id, demId: dem.id, options: { ...options, gridColumns: 257 } });
    manager.cancel(interrupted.id);
    const cancelled = await waitFor(interrupted.id);
    if (cancelled.state !== 'cancelled') throw new Error('Cancellation did not settle.');
    let online, selection, onlineHash, cached, missing;
    let task = await manager.start({ routeId: route.id, demId: dem.id, options });
    let completed = await waitFor(task.id);
    if (completed.state !== 'succeeded') throw new Error(completed.error?.message ?? 'Packaged generation failed.');
    const local = { state: completed.state, result: completed.result };
    if (onlineRoutePath) {
      const independentRoute = await manager.addRoute(resolve(onlineRoutePath));
      const inspection = await manager.inspect({ routeId: independentRoute.id, options });
      // Freeze a deliberately moved and rotated view to exercise the same
      // crop contract used by the interactive map.
      selection = { ...options, bearingDeg: 12, center: { lat: inspection.selection.center.lat + .0002,
        lon: inspection.selection.center.lon }, groundWidthM: inspection.selection.groundWidthM * 1.25 };
      task = await manager.start({ routeId: independentRoute.id, demMode: 'auto', options: selection });
      completed = await waitFor(task.id);
      if (completed.state !== 'succeeded') throw new Error(completed.error?.message ?? 'Automatic elevation generation failed.');
      online = completed;
      onlineHash = (await manager.artifact(task.id)).stlSha256;
      const cachedTask = await manager.start({ routeId: independentRoute.id, demMode: 'auto', offlineOnly: true, options: selection });
      cached = await waitFor(cachedTask.id);
      if (cached.state !== 'succeeded' || !cached.result.demSource?.cacheHit
        || cached.result.stlSha256 !== onlineHash) throw new Error('Offline cached model differs from the online model.');
      const missingTask = await manager.start({ routeId: independentRoute.id, demMode: 'auto', offlineOnly: true,
        options: { ...selection, groundWidthM: selection.groundWidthM * 1.1 } });
      missing = await waitFor(missingTask.id);
      if (missing.state !== 'failed' || missing.error?.code !== 'DEM_CACHE_MISS') throw new Error('Uncached offline selection must fail explicitly.');
      // A failed request must leave the previous valid model available.
      task = cachedTask; completed = cached;
    }
    const preview = await manager.preview(task.id), artifact = await manager.artifact(task.id);
    const saved = await saveModelStl(artifact.path, join(outputRoot, onlineRoutePath ? 'Mojstrovka_单一模型.stl' : '桌面样品_单一模型.stl'), { expectedSha256: artifact.stlSha256 });
    const savedBytes = await readFile(saved.path), outputHash = createHash('sha256').update(savedBytes).digest('hex');
    if (outputHash !== artifact.stlSha256 || saved.bytes !== artifact.bytes) throw new Error('Export does not match the verified preview.');
    const baselinePath = join(outputRoot, 'baseline-body.sha256');
    const bodySha256 = createHash('sha256').update(savedBytes.subarray(84)).digest('hex');
    await writeFile(baselinePath, `${bodySha256}\n`);
    const report = { passed: true, runtime, cancellation: cancelled.state, restarted: completed.state,
      previewMatchesStl: true, job: completed, validation: preview.report.validation,
      integratedModel: preview.report.integratedModel, dem: preview.report.dem,
      ...(online ? { automaticElevation: { routePath: resolve(onlineRoutePath), selection, local,
        onlineJob: online, offlineJob: cached, uncachedOffline: missing, byteIdentical: onlineHash === outputHash } } : {}),
      saved: { path: saved.path, bytes: saved.bytes, sha256: saved.sha256, bodySha256 }, unit: 'mm' };
    await writeFile(join(outputRoot, 'runtime-check.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    await writeFile(join(outputRoot, 'runtime-check.json'), JSON.stringify({ passed: false, runtime, error: error.message }, null, 2) + '\n');
    throw error;
  }
}
