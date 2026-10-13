import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';

const project = resolve(import.meta.dirname, '../..');
const parent = join(project, 'artifacts/desktop-color-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const colorOptions = { maxColors: 3, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
const gpx = '<gpx><trk><name>彩色测试</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
function zipEntries(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), compressedLength = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength), start = offset + 30 + nameLength + extraLength;
    const stored = bytes.subarray(start, start + compressedLength);
    files.set(name, method === 8 ? inflateRawSync(stored) : stored);
    offset = start + compressedLength;
  }
  return files;
}
function rgbTiff(rgb) {
  const pixels = Uint8Array.from(Array.from({ length: 8 * 8 }, (_, i) => rgb ?? (i % 8 < 4 ? [30, 160, 40] : [150, 145, 140])).flat());
  return Buffer.from(writeArrayBuffer(pixels, { width: 8, height: 8, SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2,
    ModelPixelScale: [0.02, 0.02, 0], ModelTiepoint: [0, 0, 0, 104.20, 30.65, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1 }));
}
async function fixture(t, { rgb } = {}) {
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'case-')), profile = join(root, 'profile');
  const routePath = join(root, '路线.gpx'), imagePath = join(root, '地表.tif');
  await Promise.all([fs.mkdir(profile), fs.writeFile(routePath, gpx), fs.writeFile(imagePath, rgbTiff(rgb))]);
  const managers = [], stores = [], workers = [];
  const fresh = () => {
    const manager = createDesktopManager({ taskRoot: join(root, `tasks-${managers.length}`), coreModuleUrl,
      jobTimeoutMs: 30000, workerFactory: ({ workerPath }) => {
        const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
        return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
          postMessage: value => worker.send(value), kill: () => worker.kill() };
      } });
    const store = createSessionStore({ userDataDirectory: profile, manager });
    managers.push(manager); stores.push(store); return { manager, store };
  };
  t.after(async () => {
    workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); });
    await Promise.all(stores.map(store => store.close())); await Promise.all(managers.map(manager => manager.close()));
    assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith('case-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = fresh(), route = await first.manager.addRoute(routePath);
  const dem = await first.manager.addDem(join(project, 'data/copernicus-longquanshan.tif'));
  return { root, profile, routePath, imagePath, route, dem, fresh, ...first,
    request: { routeId: route.id, demId: dem.id, demMode: 'local', offlineOnly: true, options: { gridColumns: 33, ...colorOptions } } };
}
async function settled(manager, id) {
  const until = Date.now() + 30000;
  while (['running', 'cancelling'].includes(manager.get(id).state)) {
    if (Date.now() > until) throw new Error('Color worker did not settle');
    await new Promise(done => setTimeout(done, 10));
  }
  const job = manager.get(id); assert.equal(job.state, 'succeeded', JSON.stringify(job.error)); return job;
}

test('image import validates real RGB TIFF, exposes no path and rejects a changed saved SHA', async t => {
  const f = await fixture(t), bytes = await fs.readFile(f.imagePath);
  const image = await f.manager.addImage(f.imagePath, { expectedSha256: digest(bytes) });
  assert.equal(image.width, 8); assert.equal(image.height, 8); assert.equal(image.crs, 'EPSG:4326');
  assert.equal(image.sha256, digest(bytes)); assert.ok(!JSON.stringify(image).includes(f.root));
  assert.equal(f.manager.sessionSources({ imageId: image.id }).image.path, f.imagePath);
  await fs.writeFile(f.imagePath, 'invalid image');
  await assert.rejects(f.manager.addImage(f.imagePath, { expectedSha256: image.sha256 }), { code: 'SESSION_INPUT_CHANGED' });
  await assert.rejects(f.manager.addImage(f.imagePath));
  f.manager.removeImage(image.id);
  assert.throws(() => f.manager.sessionSources({ imageId: image.id }), { code: 'IMAGE_NOT_FOUND' });
});

test('session restores image under a new id and changed image keeps route and colors with a warning', async t => {
  const f = await fixture(t), image = await f.manager.addImage(f.imagePath);
  await f.store.saveSession({ ...f.request, imageId: image.id });
  const startup = await f.fresh().store.getSession();
  assert.equal(startup.schemaVersion, 1); assert.equal(startup.recentProject.imageFileName, '地表.tif');
  assert.ok(!JSON.stringify(startup).includes(f.root));
  const restored = await f.fresh().store.restoreSession();
  assert.ok(restored.route); assert.ok(restored.dem); assert.notEqual(restored.image.id, image.id);
  assert.equal(restored.options.maxColors, 3); assert.equal(restored.options.rockColor, '#a9aa92');
  assert.deepEqual(restored.warnings, []); assert.ok(!JSON.stringify(restored).includes(f.root));
  await fs.writeFile(f.imagePath, 'modified image');
  const changed = await f.fresh().store.restoreSession();
  assert.ok(changed.route); assert.ok(changed.dem); assert.equal(changed.image, undefined);
  assert.equal(changed.options.grassColor, '#799278'); assert.ok(changed.warnings.some(value => value.includes('影像') && value.includes('改变')));
  const before = await fs.readFile(join(f.profile, 'session-v1.json'));
  await assert.rejects(f.store.saveSession({ ...f.request, imageId: f.imagePath }));
  await assert.rejects(f.store.saveSession({ ...f.request, imagePath: f.imagePath }));
  assert.deepEqual(await fs.readFile(join(f.profile, 'session-v1.json')), before);
});

test('real worker classifies image once and export uses current colors without changing frozen geometry', async t => {
  const f = await fixture(t), image = await f.manager.addImage(f.imagePath);
  const job = await f.manager.start({ ...f.request, imageId: image.id }); await settled(f.manager, job.id);
  const preview = await f.manager.preview(job.id);
  assert.equal(preview.appearance.faceClasses.length, preview.mesh.indices.length / 3);
  assert.ok(preview.appearance.faceClasses.includes('grass')); assert.ok(preview.appearance.faceClasses.includes('rock'));
  assert.ok(preview.appearance.faceClasses.includes('route')); assert.equal(preview.appearance.palette.length, 3);
  const first = await f.manager.exportModel(job.id, '3mf', colorOptions);
  const two = await f.manager.exportModel(job.id, 'obj', { ...colorOptions, maxColors: 2, grassColor: '#112233', rockColor: '#f9ffff', routeColor: '#ff6600' });
  assert.ok(Buffer.isBuffer(first.bytes)); assert.equal(first.extension, '.3mf'); assert.equal(first.bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(two.extension, '.zip'); assert.notEqual(two.appearanceHash, first.appearanceHash);
  const threeFiles = zipEntries(first.bytes), twoFiles = zipEntries(two.bytes);
  const manifest = JSON.parse(twoFiles.get('manifest.json').toString('utf8'));
  assert.deepEqual(manifest.appearance.palette.map(value => value.color).sort(), ['#112233', '#ff6600']);
  assert.equal(manifest.appearance.hash, two.appearanceHash); assert.equal(manifest.triangleCount, preview.mesh.indices.length / 3);
  assert.ok(twoFiles.get('model.mtl').toString('utf8').includes('Kd 1 0.4 0'));
  assert.equal(twoFiles.get('model.obj').toString('utf8').split('\n').filter(line => line.startsWith('f ')).length, preview.mesh.indices.length / 3);
  assert.equal((threeFiles.get('3D/3dmodel.model').toString('utf8').match(/<m:color /g) ?? []).length, 3);
  const unchanged = await f.manager.preview(job.id); assert.deepEqual(unchanged.mesh, preview.mesh); assert.deepEqual(unchanged.appearance, preview.appearance);
  const stl = await f.manager.exportModel(job.id, 'stl', colorOptions), artifact = await f.manager.artifact(job.id);
  assert.equal(digest(stl.bytes), artifact.stlSha256);
  await assert.rejects(f.manager.exportModel(job.id, '../stl', colorOptions), { code: 'CONFIG_INVALID' });
  await assert.rejects(f.manager.exportModel(job.id, '3mf', { ...colorOptions, maxColors: 5 }), { code: 'CONFIG_INVALID' });
});

test('real snow worker applies grass sensitivity to preview and closed material volumes without changing geometry', async t => {
  const f = await fixture(t, { rgb: [95, 105, 98] }), image = await f.manager.addImage(f.imagePath);
  const colors = { ...colorOptions, maxColors: 4 }, previews = [];
  for (const [grassSensitivity, expectedTerrainClass] of [[50, 'rock'], [100, 'grass']]) {
    const job = await f.manager.start({ ...f.request, imageId: image.id, options: {
      ...f.request.options, ...colors, grassSensitivity, snowEnabled: true, snowCoveragePercent: 30, snowMaxThicknessMm: 1,
    } });
    await settled(f.manager, job.id);
    const preview = await f.manager.preview(job.id); previews.push(preview);
    const terrainClasses = preview.appearance.faceClasses.filter((_, face) => preview.mesh.faceKinds[face] === 'terrain');
    assert.ok(terrainClasses.length > 0);
    assert.ok(terrainClasses.every(kind => kind === expectedTerrainClass));
    assert.equal(preview.report.config.grassSensitivity, undefined, 'classification settings must stay outside geometry config');
    for (const part of preview.mesh.materialParts) {
      assert.equal(part.faceClasses.length, part.indices.length / 3);
      if (part.id !== 'terrain') assert.ok(part.faceClasses.every(kind => kind === part.id));
      else {
        const classes = part.faceClasses.filter((_, face) => part.faceKinds[face] === 'terrain');
        assert.ok(classes.length > 0); assert.ok(classes.every(kind => kind === expectedTerrainClass));
      }
    }
    for (const [format, manifestPath] of [['3mf', 'Metadata/manifest.json'], ['obj', 'manifest.json']]) {
      const exported = await f.manager.exportModel(job.id, format, { ...colors, grassSensitivity: 0 });
      const files = zipEntries(exported.bytes), manifest = JSON.parse(files.get(manifestPath).toString('utf8'));
      assert.equal(exported.appearanceHash, preview.appearance.hash, 'export must use the generated classification');
      assert.equal(manifest.appearance.hash, preview.appearance.hash);
      assert.equal(manifest.appearance.options.grassSensitivity, undefined);
      if (format === 'obj') {
        const materialClasses = new Map(manifest.appearance.palette.map((entry, index) => [`palette_${index}`, entry.id]));
        const objectFaces = new Map(); let object, material;
        for (const line of files.get('model.obj').toString('utf8').split('\n')) {
          if (line.startsWith('o ')) { object = line.slice(2); objectFaces.set(object, []); }
          else if (line.startsWith('usemtl ')) material = materialClasses.get(line.slice(7));
          else if (line.startsWith('f ')) objectFaces.get(object).push(material);
        }
        for (const part of preview.mesh.materialParts) assert.deepEqual(objectFaces.get(part.id), part.faceClasses);
      }
    }
    assert.deepEqual((await f.manager.preview(job.id)).appearance, preview.appearance);
  }
  assert.deepEqual(previews[0].mesh.positions, previews[1].mesh.positions);
  assert.deepEqual(previews[0].mesh.indices, previews[1].mesh.indices);
  assert.notEqual(previews[0].appearance.hash, previews[1].appearance.hash);
});

test('worker refuses a previously imported image whose bytes changed before generation', async t => {
  const f = await fixture(t), image = await f.manager.addImage(f.imagePath);
  const bytes = await fs.readFile(f.imagePath); bytes[bytes.length - 1] ^= 1; await fs.writeFile(f.imagePath, bytes);
  const job = await f.manager.start({ ...f.request, imageId: image.id });
  const until = Date.now() + 30000;
  while (f.manager.get(job.id).state === 'running') { assert.ok(Date.now() < until); await new Promise(done => setTimeout(done, 10)); }
  assert.equal(f.manager.get(job.id).state, 'failed'); assert.equal(f.manager.get(job.id).error.code, 'SESSION_INPUT_CHANGED');
  await assert.rejects(f.manager.preview(job.id), { code: 'RESULT_UNAVAILABLE' });
});

test('generic color saving freezes bytes and rolls back an approved overwrite after publication failure', async t => {
  const f = await fixture(t), module = await import('../main/save-model.mjs').catch(() => ({}));
  assert.equal(typeof module.saveModelFile, 'function', 'color export needs an atomic binary saver');
  const { saveModelFile } = module, target = join(f.root, '我的模型.3mf'), bytes = Buffer.from('PK color bundle');
  const input = Buffer.from(bytes), pending = saveModelFile(input, target, { expectedSha256: digest(bytes) }); input.fill(0);
  const saved = await pending; assert.equal(saved.sha256, digest(bytes)); assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(saveModelFile(bytes, target), { code: 'DESTINATION_EXISTS' });
  const original = Buffer.from('previous user file'); await fs.writeFile(target, original);
  const fsOps = { ...fs, rename: async (from, to) => { if (from.endsWith('.stage')) throw Object.assign(new Error('failure'), { code: 'EACCES' }); return fs.rename(from, to); } };
  await assert.rejects(saveModelFile(bytes, target, { overwriteApproved: true }, fsOps), { code: 'SAVE_FAILED' });
  assert.deepEqual(await fs.readFile(target), original);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.includes('.stage') || name.includes('.backup')), []);
  await assert.rejects(saveModelFile(bytes, target, { expectedSha256: '0'.repeat(64), overwriteApproved: true }), { code: 'HASH_MISMATCH' });
  assert.deepEqual(await fs.readFile(target), original);
});

test('generic save preserves a destination created during staging and rejects a changed parent', async t => {
  const f = await fixture(t), { saveModelFile } = await import('../main/save-model.mjs');
  const target = join(f.root, 'race.3mf'), contents = Buffer.from('color bundle'), sentinel = 'new user file';
  const appeared = { ...fs, open: async (name, ...args) => {
    const handle = await fs.open(name, ...args);
    if (name.endsWith('.stage')) await fs.writeFile(target, sentinel);
    return handle;
  } };
  await assert.rejects(saveModelFile(contents, target, {}, appeared), { code: 'DESTINATION_CHANGED' });
  assert.equal(await fs.readFile(target, 'utf8'), sentinel);
  const target2 = join(f.root, 'directory.3mf'); let staged = false;
  const changedParent = { ...fs, open: async (name, ...args) => {
    const handle = await fs.open(name, ...args); if (name.endsWith('.stage')) staged = true; return handle;
  }, realpath: async name => staged && name === f.root ? join(f.root, 'redirected') : fs.realpath(name) };
  await assert.rejects(saveModelFile(contents, target2, {}, changedParent), { code: 'DESTINATION_CHANGED' });
  await assert.rejects(fs.readFile(target2), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target, 'utf8'), sentinel);
});
