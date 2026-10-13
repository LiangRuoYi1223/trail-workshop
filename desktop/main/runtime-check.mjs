import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { saveModelStl } from './save-stl.mjs';
import { saveModelFile } from './save-model.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function archiveEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), compressed = bytes.readUInt32LE(offset + 18), length = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    if (![0, 8].includes(method) || start + compressed > bytes.length || length > 100 * 1024 * 1024) throw new Error('彩色文件 ZIP 结构无效。');
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength), data = bytes.subarray(start, start + compressed);
    const expanded = method === 8 ? inflateRawSync(data, { maxOutputLength: 100 * 1024 * 1024 }) : data;
    if (expanded.length !== length || entries.has(name)) throw new Error('彩色文件 ZIP 内容长度无效。');
    entries.set(name, expanded); offset = start + compressed;
  }
  if (!entries.size) throw new Error('彩色文件 ZIP 为空。');
  return entries;
}

async function checkColorExports(manager, id, outputRoot, image, automaticImage = false) {
  const preview = await manager.preview(id), artifact = await manager.artifact(id), appearance = preview.appearance;
  if (!appearance || appearance.options.maxColors !== 3 || appearance.palette.length > 3
    || appearance.faceClasses.length !== preview.mesh.indices.length / 3
    || appearance.classification !== (image || automaticImage ? 'rgb-greenness' : 'uniform')) throw new Error('生成模型没有有效的有限颜色外观。');
  const formats = [];
  for (const [format, options] of [['3mf', appearance.options], ['obj', { maxColors: 2,
    grassColor: '#3b7a49', rockColor: '#6f7065', routeColor: '#eb6e2e' }]]) {
    const exported = await manager.exportModel(id, format, options);
    const target = join(outputRoot, format === '3mf' ? '验证模型_三色.3mf' : '验证模型_改色两色_OBJ.zip');
    const saved = await saveModelFile(exported.bytes, target, { expectedSha256: sha256(exported.bytes) });
    const bytes = await readFile(saved.path), files = archiveEntries(bytes);
    const manifestPath = format === '3mf' ? 'Metadata/manifest.json' : 'manifest.json';
    const manifest = JSON.parse(files.get(manifestPath)?.toString('utf8') ?? 'null');
    const palette = manifest?.appearance?.palette;
    if (preview.report.imageSource && JSON.stringify(manifest?.metadata?.imageSource) !== JSON.stringify(preview.report.imageSource)) {
      throw new Error('彩色打印文件缺少真实影像来源及拍摄日期。');
    }
    if (sha256(bytes) !== saved.sha256 || !manifest || manifest.unit !== 'mm'
      || manifest.triangleCount !== preview.mesh.indices.length / 3 || manifest.vertexCount !== preview.mesh.positions.length / 3
      || manifest.appearance.hash !== exported.appearanceHash || !Array.isArray(palette) || !palette.length
      || palette.length > options.maxColors || new Set(palette.map(entry => entry.color)).size !== palette.length
      || palette.some(entry => !/^#[a-f0-9]{6}$/.test(entry.color)) || !palette.some(entry => entry.color === options.routeColor)) {
      throw new Error('彩色文件与当前配色、颜色上限或毫米模型不一致。');
    }
    if (format === '3mf') {
      const model = files.get('3D/3dmodel.model')?.toString('utf8') ?? '';
      const vertices = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
      const faces = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="1" p1="(\d+)" p2="(\d+)" p3="(\d+)"\/>/g)];
      const colors = [...model.matchAll(/<m:color color="(#[a-f0-9]{6})ff"\/>/g)].map(match => match[1]);
      if (!model.includes('unit="millimeter"') || vertices.length !== manifest.vertexCount || faces.length !== manifest.triangleCount
        || JSON.stringify(colors) !== JSON.stringify(palette.map(entry => entry.color))
        || vertices.some((vertex, index) => [1, 2, 3].some(axis => !Number.isFinite(Number(vertex[axis])) || Number(vertex[axis]) !== preview.mesh.positions[index * 3 + axis - 1]))
        || faces.some((face, index) => [1, 2, 3].some(axis => Number(face[axis]) !== preview.mesh.indices[index * 3 + axis - 1])
          || face[4] !== face[5] || face[4] !== face[6] || Number(face[4]) >= palette.length)) throw new Error('3MF 网格、材质或有限坐标验证失败。');
    } else {
      const obj = files.get('model.obj')?.toString('utf8') ?? '', mtl = files.get('model.mtl')?.toString('utf8') ?? '';
      const vertices = obj.split('\n').filter(line => line.startsWith('v ')), faces = obj.split('\n').filter(line => line.startsWith('f '));
      if (exported.appearanceHash === appearance.hash || palette.length !== 2 || !palette.some(entry => entry.color === '#3b7a49')
        || vertices.length !== manifest.vertexCount || faces.length !== manifest.triangleCount
        || vertices.some((line, index) => line.split(' ').slice(1).some((value, axis) => !Number.isFinite(Number(value)) || Number(value) !== preview.mesh.positions[index * 3 + axis]))
        || !files.has('palette.png') || mtl.split('\n').filter(line => line.startsWith('newmtl ')).length !== palette.length) throw new Error('改色两色 OBJ 材质或几何验证失败。');
    }
    formats.push({ format, path: saved.path, bytes: saved.bytes, sha256: saved.sha256,
      appearanceHash: exported.appearanceHash, maxColors: options.maxColors, colorCount: palette.length, palette });
  }
  const after = await manager.preview(id), stl = await manager.exportModel(id, 'stl', appearance.options);
  if (after.appearance.hash !== appearance.hash || sha256(stl.bytes) !== artifact.stlSha256) throw new Error('改色导出改变了已生成的分类或 STL。');
  return { passed: true, classification: appearance.classification, imageSha256: image?.sha256 ?? appearance.source?.sha256,
    frozenGeometry: true, recolorChangesHash: true, formats };
}

// Invoked explicitly by the packaging smoke check, outside the renderer bridge.
export async function checkRuntime({ app, manager, routePath, demPath, imagePath, destination, onlineRoutePath, imageMode = 'local' }) {
  const outputRoot = resolve(destination);
  await mkdir(outputRoot, { recursive: true });
  const runtime = { packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node,
    applicationRoot: app.getAppPath(), platform: process.platform };
  try {
    if (!runtime.packaged) throw new Error('Runtime verification must use the packaged executable.');
    if (!['auto', 'local', 'none'].includes(imageMode)) throw new Error('Runtime imagery mode must be auto, local or none.');
    if (!routePath || !demPath) throw new Error('请通过 --runtime-check-local-route 和 --runtime-check-dem 指定验证用 GPX 或 KML 与 GeoTIFF；软件不再附带示例。');
    const route = await manager.addRoute(resolve(routePath));
    const dem = await manager.addDem(resolve(demPath));
    const image = imageMode === 'local' && imagePath ? await manager.addImage(resolve(imagePath)) : undefined;
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
    let task = await manager.start({ routeId: route.id, demId: dem.id, imageMode, ...(image ? { imageId: image.id } : {}), options });
    let completed = await waitFor(task.id);
    if (completed.state !== 'succeeded') throw new Error(completed.error?.message ?? 'Packaged generation failed.');
    const local = { state: completed.state, result: completed.result };
    const color = await checkColorExports(manager, task.id, outputRoot, image, imageMode === 'auto');
    let automaticSurface;
    if (imageMode === 'auto') {
      const source = completed.result.imageSource, firstPreview = await manager.preview(task.id);
      if (!source || source.provider !== 'Sentinel-2' || !source.scenes?.length
        || source.scenes.some(scene => !Number.isFinite(Date.parse(scene.datetime)))) throw new Error('自动影像缺少可信来源或实际拍摄日期。');
      const firstHash = completed.result.stlSha256, firstAppearance = firstPreview.appearance.hash;
      const offlineTask = await manager.start({ routeId: route.id, demId: dem.id, imageMode: 'auto', imageOfflineOnly: true, options });
      const offlineJob = await waitFor(offlineTask.id), offlineSource = offlineJob.result?.imageSource;
      if (offlineJob.state !== 'succeeded' || !offlineSource?.cacheHit
        || JSON.stringify(offlineSource.scenes) !== JSON.stringify(source.scenes)
        || JSON.stringify(offlineSource.bounds) !== JSON.stringify(source.bounds)
        || offlineJob.result.stlSha256 !== firstHash || offlineJob.result.appearanceHash !== firstAppearance) {
        throw new Error('离线影像缓存未复用同一拍摄来源、分类或模型字节。');
      }
      automaticSurface = { source, offlineSource, byteIdentical: true, appearanceIdentical: true,
        sceneDates: source.scenes.map(scene => scene.datetime), offlineJob };
      task = offlineTask; completed = offlineJob;
    }
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
    const saved = await saveModelStl(artifact.path, join(outputRoot, '验证模型_单一模型.stl'), { expectedSha256: artifact.stlSha256 });
    const savedBytes = await readFile(saved.path), outputHash = createHash('sha256').update(savedBytes).digest('hex');
    if (outputHash !== artifact.stlSha256 || saved.bytes !== artifact.bytes) throw new Error('Export does not match the verified preview.');
    const baselinePath = join(outputRoot, 'baseline-body.sha256');
    const bodySha256 = createHash('sha256').update(savedBytes.subarray(84)).digest('hex');
    await writeFile(baselinePath, `${bodySha256}\n`);
    const report = { passed: true, runtime, inputs: { routePath: resolve(routePath), demPath: resolve(demPath), imageMode,
      ...(imageMode === 'local' && imagePath ? { imagePath: resolve(imagePath) } : {}) }, color,
      cancellation: cancelled.state, restarted: completed.state,
      previewMatchesStl: true, job: completed, validation: preview.report.validation,
      integratedModel: preview.report.integratedModel, dem: preview.report.dem,
      ...(automaticSurface ? { automaticSurface } : {}),
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
