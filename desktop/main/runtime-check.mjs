import { validateOptions } from './files.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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

const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };
const attributes = text => Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const equalNumbers = (actual, expected) => actual.length === expected.length && actual.every((value, index) => Number.isFinite(value) && value === expected[index]);

function checkExportManifest(manifest, prepared, outer, palette) {
  requireCheck(JSON.stringify(manifest.boundsMm) === JSON.stringify(outer.bounds), '彩色文件外形尺寸与预览不一致。');
  if (!prepared) {
    requireCheck(manifest.materialParts === undefined, '单一外形文件出现未确认的材料实体。'); return;
  }
  const report = prepared.report;
  requireCheck(Array.isArray(manifest.materialParts) && manifest.materialParts.length === report.parts.length, '彩色文件材料实体数量不一致。');
  for (let index = 0; index < report.parts.length; index++) {
    const expected = report.parts[index], part = manifest.materialParts[index];
    requireCheck(part.id === expected.id && part.vertexCount === expected.vertexCount && part.triangleCount === expected.triangleCount
      && part.connectedComponents === expected.connectedComponents && part.boundaryEdges === 0 && part.nonManifoldEdges === 0
      && Number.isFinite(part.volumeMm3) && part.volumeMm3 > 0 && Math.abs(part.volumeMm3 - expected.volumeMm3) <= report.volumeToleranceMm3
      && JSON.stringify(part.bounds) === JSON.stringify(expected.bounds)
      && part.defaultMaterial === prepared.parts[index].defaultMaterial && part.defaultMaterial < palette.length,
    '彩色文件材料角色、闭合性、体积或材质记录不一致。');
  }
  requireCheck(Number.isFinite(manifest.materialVolumeMm3) && Math.abs(manifest.materialVolumeMm3 - report.volumeMm3) <= report.volumeToleranceMm3
    && manifest.materialVolumeToleranceMm3 === report.volumeToleranceMm3, '彩色文件材料体积总和与单一外形不一致。');
}

function check3mf(files, expectedParts, palette, prepared, preview, core) {
  const model = files.get('3D/3dmodel.model')?.toString('utf8') ?? '';
  const colors = [...model.matchAll(/<m:color color="(#[a-f0-9]{6})ff"\/>/g)].map(match => match[1]);
  requireCheck(model.includes('unit="millimeter"') && JSON.stringify(colors) === JSON.stringify(palette.map(entry => entry.color)), '3MF 毫米单位或调色板不一致。');
  const objects = [...model.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)].map(match => ({ attributes: attributes(match[1]), body: match[2] }));
  requireCheck(objects.length === (model.match(/<object\b/g) ?? []).length
    && objects.length === expectedParts.length + (prepared ? 1 : 0)
    && new Set(objects.map(object => object.attributes.id)).size === objects.length, '3MF 材料对象数量或身份不一致。');
  if (prepared) {
    const bases = [...model.matchAll(/<base name="([^"]*)" displaycolor="(#[a-f0-9]{6})ff"\/>/g)].map(match => match[2]);
    requireCheck(model.includes('<basematerials id="2">') && JSON.stringify(bases) === JSON.stringify(palette.map(entry => entry.color)), '3MF 基础材料颜色不一致。');
    const assembly = objects.at(-1), expectedIds = expectedParts.map((_, index) => String(index + 3));
    const components = [...assembly.body.matchAll(/<component\b([^>]*)\/>/g)].map(match => attributes(match[1]));
    const items = [...model.matchAll(/<item\b([^>]*)\/>/g)].map(match => attributes(match[1]));
    requireCheck(assembly.attributes.id === String(expectedParts.length + 3) && assembly.attributes.name === 'terrain-assembly'
      && assembly.body.includes('<components>') && !assembly.body.includes('<mesh>')
      && components.length === (model.match(/<component\b/g) ?? []).length && components.length === expectedIds.length
      && components.every((component, index) => component.objectid === expectedIds[index] && Object.keys(component).length === 1)
      && items.length === 1 && items[0].objectid === assembly.attributes.id && Object.keys(items[0]).length === 1,
    '3MF 装配引用、相对位置或构建对象不一致。');
  } else {
    const items = [...model.matchAll(/<item\b([^>]*)\/>/g)].map(match => attributes(match[1]));
    requireCheck(items.length === 1 && items[0].objectid === '2' && Object.keys(items[0]).length === 1
      && !model.includes('<component'), '3MF 单一模型构建引用不一致。');
  }
  const decoded = [];
  for (let index = 0; index < expectedParts.length; index++) {
    const expected = expectedParts[index], object = objects[index], part = expected.mesh;
    requireCheck(object.attributes.id === String(prepared ? index + 3 : 2) && object.attributes.type === 'model'
      && (!prepared || object.attributes.name === part.id && object.attributes.pid === '2' && Number(object.attributes.pindex) === expected.defaultMaterial),
    '3MF 材料对象角色或默认材质不一致。');
    const vertices = [...object.body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
    const faces = [...object.body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="([12])" p1="(\d+)" p2="(\d+)" p3="(\d+)"\/>/g)];
    const positions = vertices.flatMap(vertex => [Number(vertex[1]), Number(vertex[2]), Number(vertex[3])]);
    const indices = faces.flatMap(face => [Number(face[1]), Number(face[2]), Number(face[3])]);
    requireCheck(vertices.length === (object.body.match(/<vertex\b/g) ?? []).length && equalNumbers(positions, part.positions), '3MF 材料实体顶点与预览不一致。');
    requireCheck(faces.length === (object.body.match(/<triangle\b/g) ?? []).length && equalNumbers(indices, part.indices), '3MF 材料实体局部索引与预览不一致。');
    requireCheck(faces.length === expected.materials.length && faces.every((face, faceIndex) => Number(face[4]) === (prepared && part.id !== 'terrain' ? 2 : 1)
      && Number(face[5]) === expected.materials[faceIndex] && face[5] === face[6] && face[5] === face[7]
      && Number(face[5]) < palette.length), '3MF 材料实体面材质或材料角色不一致。');
    core.assertPrintableMesh({ positions, indices }, { allowDisconnected: Boolean(prepared) });
    decoded.push({ ...part, positions, indices });
  }
  requireCheck((model.match(/<mesh>/g) ?? []).length === expectedParts.length, '3MF 出现未确认的网格实体。');
  if (prepared) core.validateMaterialParts({ ...preview.mesh, materialParts: decoded });
}

function checkObj(files, expectedParts, palette, prepared, preview, core) {
  const obj = files.get('model.obj')?.toString('utf8') ?? '', mtl = files.get('model.mtl')?.toString('utf8') ?? '';
  requireCheck(files.has('palette.png') && obj.includes('mtllib model.mtl'), 'OBJ 材质文件或色卡缺失。');
  const objects = [];
  let current;
  for (const line of obj.split(/\r?\n/)) {
    if (line.startsWith('o ')) { current = { id: line.slice(2), positions: [], indices: [], materials: [], groups: [], currentMaterial: undefined }; objects.push(current); }
    else if (/^(v |f |g |usemtl )/.test(line)) {
      requireCheck(current, 'OBJ 材料实体对象之前出现几何。');
      if (line.startsWith('v ')) { const xyz = line.split(/\s+/).slice(1).map(Number); requireCheck(xyz.length === 3 && xyz.every(Number.isFinite), 'OBJ 顶点无效。'); current.positions.push(...xyz); }
      else if (line.startsWith('g ')) current.groups.push(line.slice(2));
      else if (line.startsWith('usemtl ')) { const match = /^usemtl palette_(\d+)$/.exec(line); requireCheck(match && Number(match[1]) < palette.length, 'OBJ 材质索引无效。'); current.currentMaterial = Number(match[1]); }
      else { const match = /^f (\d+) (\d+) (\d+)$/.exec(line); requireCheck(match && current.currentMaterial !== undefined, 'OBJ 三角面或材质无效。'); current.indices.push(Number(match[1]), Number(match[2]), Number(match[3])); current.materials.push(current.currentMaterial); }
    }
  }
  requireCheck(objects.length === expectedParts.length, 'OBJ 材料实体数量不一致。');
  let vertexOffset = 1;
  const decoded = [];
  for (let index = 0; index < expectedParts.length; index++) {
    const expected = expectedParts[index], actual = objects[index], part = expected.mesh;
    requireCheck(actual.id === (prepared ? part.id : 'terrain') && (!prepared || actual.groups.length === 1 && actual.groups[0] === part.id), 'OBJ 材料对象角色不一致。');
    requireCheck(equalNumbers(actual.positions, part.positions), 'OBJ 材料实体顶点与预览不一致。');
    requireCheck(equalNumbers(actual.indices, part.indices.map(value => value + vertexOffset)), 'OBJ 材料实体全局索引与预览不一致。');
    requireCheck(equalNumbers(actual.materials, expected.materials), 'OBJ 材料实体面材质与角色不一致。');
    const indices = actual.indices.map(value => value - vertexOffset);
    core.assertPrintableMesh({ positions: actual.positions, indices }, { allowDisconnected: Boolean(prepared) });
    decoded.push({ ...part, positions: actual.positions, indices }); vertexOffset += part.positions.length / 3;
  }
  const definitions = [...mtl.matchAll(/^newmtl (\S+)\r?\nKd ([^\r\n]+)\r?\nd 1\r?\nillum 1$/gm)];
  requireCheck(definitions.length === palette.length && definitions.length === (mtl.match(/^newmtl /gm) ?? []).length
    && definitions.every((definition, index) => definition[1] === `palette_${index}`
      && equalNumbers(definition[2].split(/\s+/).map(Number), [...Buffer.from(palette[index].color.slice(1), 'hex')].map(value => value / 255))),
  'OBJ 固定 RGB 材质定义与调色板不一致。');
  if (prepared) core.validateMaterialParts({ ...preview.mesh, materialParts: decoded });
}

async function checkColorExports(manager, id, outputRoot, image, automaticImage, core) {
  const preview = await manager.preview(id), artifact = await manager.artifact(id), appearance = preview.appearance;
  if (!appearance || ![1,2,3,4,5,6].includes(appearance.options.maxColors) || appearance.palette.length > appearance.options.maxColors
    || appearance.faceClasses.length !== preview.mesh.indices.length / 3
    || appearance.classification !== (image || automaticImage ? 'rgb-greenness' : 'uniform')) throw new Error('生成模型没有有效的有限颜色外观。');
  const outer = core.assertPrintableMesh(preview.mesh), formats = [];
  for (const [format, requested] of [['3mf', appearance.options], ['obj', { maxColors: 2,
    grassColor: '#3b7a49', rockColor: '#6f7065', routeColor: '#eb6e2e' }]]) {
    const options = core.validateAppearanceOptions(validateOptions(requested));
    const current = core.recolorModelAppearance(appearance, options);
    const prepared = preview.mesh.materialParts === undefined ? undefined : core.prepareMaterialParts(preview.mesh, current);
    const expectedPalette = prepared?.palette ?? current.palette;
    const expectedParts = prepared?.parts ?? [{ mesh: preview.mesh, materials: current.faceMaterials }];
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
      || manifest.triangleCount !== outer.triangleCount || manifest.vertexCount !== outer.vertexCount
      || manifest.appearance.hash !== exported.appearanceHash || manifest.appearance.hash !== current.hash
      || JSON.stringify(palette) !== JSON.stringify(expectedPalette) || !Array.isArray(palette) || !palette.length
      || palette.length > options.maxColors || new Set(palette.map(entry => entry.color)).size !== palette.length
      || palette.some(entry => !/^#[a-f0-9]{6}$/.test(entry.color)) || !palette.some(entry => entry.color === options.routeColor)) {
      throw new Error('彩色文件与当前配色、颜色上限或毫米模型不一致。');
    }
    checkExportManifest(manifest, prepared, outer, palette);
    if (format === '3mf') check3mf(files, expectedParts, palette, prepared, preview, core);
    else {
      requireCheck(exported.appearanceHash !== appearance.hash && palette.length === 2 && palette.some(entry => entry.color === '#3b7a49'), '改色两色 OBJ 配色验证失败。');
      checkObj(files, expectedParts, palette, prepared, preview, core);
    }
    formats.push({ format, path: saved.path, bytes: saved.bytes, sha256: saved.sha256,
      appearanceHash: exported.appearanceHash, maxColors: options.maxColors, colorCount: palette.length, palette,
      ...(prepared ? { materialParts: prepared.report.parts, materialVolumeMm3: prepared.report.volumeMm3, assemblyVerified: true } : {}) });
  }
  const after = await manager.preview(id), stl = await manager.exportModel(id, 'stl', appearance.options);
  if (after.appearance.hash !== appearance.hash || sha256(stl.bytes) !== artifact.stlSha256) throw new Error('改色导出改变了已生成的分类或 STL。');
  return { passed: true, classification: appearance.classification, imageSha256: image?.sha256 ?? appearance.source?.sha256,
    frozenGeometry: true, recolorChangesHash: true, formats };
}
// Invoked explicitly by the packaging smoke check, outside the renderer bridge.
export async function checkRuntime({ app, manager, routePath, demPath, imagePath, destination, onlineRoutePath, imageMode = 'local', coreModuleUrl }) {
  const outputRoot = resolve(destination);
  await mkdir(outputRoot, { recursive: true });
  const runtime = { packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node,
    applicationRoot: app.getAppPath(), platform: process.platform };
  try {
    if (!runtime.packaged) throw new Error('Runtime verification must use the packaged executable.');
    if (!['auto', 'local', 'none'].includes(imageMode)) throw new Error('Runtime imagery mode must be auto, local or none.');
    if (!routePath || !demPath) throw new Error('请通过 --runtime-check-local-route 和 --runtime-check-dem 指定验证用 GPX 或 KML 与 GeoTIFF；软件不再附带示例。');
    const core = await import(coreModuleUrl ?? pathToFileURL(join(app.getAppPath(), 'core/index.js')).href);
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
    const color = await checkColorExports(manager, task.id, outputRoot, image, imageMode === 'auto', core);
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


/** Reuse the same strict manifest, geometry, material and volume readback in role-toggle acceptance. */
export function validateColorArtifact(bytes,format,preview,appearance,core) {
  if(format!=='3mf'&&format!=='obj')throw new Error('彩色回读格式无效。');
  const files=archiveEntries(bytes),outer=core.assertPrintableMesh(preview.mesh);
  const prepared=preview.mesh.materialParts===undefined?undefined:core.prepareMaterialParts(preview.mesh,appearance);
  const palette=prepared?.palette??appearance.palette;
  const parts=prepared?.parts??[{mesh:preview.mesh,materials:appearance.faceMaterials}];
  const manifest=JSON.parse(files.get(format==='3mf'?'Metadata/manifest.json':'manifest.json')?.toString('utf8')??'null');
  requireCheck(manifest?.unit==='mm'&&manifest.triangleCount===outer.triangleCount&&manifest.vertexCount===outer.vertexCount
    &&manifest.appearance?.hash===appearance.hash&&JSON.stringify(manifest.appearance?.palette)===JSON.stringify(palette),
    '彩色回读记录与实际外形/外观不一致。');
  checkExportManifest(manifest,prepared,outer,palette);
  if(format==='3mf')check3mf(files,parts,palette,prepared,preview,core);
  else checkObj(files,parts,palette,prepared,preview,core);
  return {actualGeometryReadback:true,unit:'mm',colors:palette.length,roles:parts.map(part=>part.mesh.id??'terrain'),
    triangleCount:outer.triangleCount,volumeMm3:outer.volumeMm3};
}
