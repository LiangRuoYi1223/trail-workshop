import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';
import { classColor } from '../../dist/src/appearance/palette.js';

const project = resolve(import.meta.dirname, '../..');
const parent = join(project, 'artifacts', 'desktop-grass-continuity-worker-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const colors = { maxColors: 4, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
const options = { ...colors, widthMm: 120, heightMm: 80, gridColumns: 129, grassSensitivity: 50,
  snowEnabled: true, snowCoveragePercent: 30, snowMaxThicknessMm: 1 };
const gpx = '<gpx><trk><name>草地连片测试</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
const bigRock = { west: -42, east: -20, south: -20, north: 10 };
const insideBigRock = ({ x, y }, inset = 0) => x >= bigRock.west + inset && x <= bigRock.east - inset
  && y >= bigRock.south + inset && y <= bigRock.north - inset;

function centroid(mesh, face) {
  let x = 0, y = 0;
  for (let corner = 0; corner < 3; corner++) {
    const offset = mesh.indices[face * 3 + corner] * 3;
    x += mesh.positions[offset] / 3; y += mesh.positions[offset + 1] / 3;
  }
  return { x, y };
}

function holeCenters(mesh) {
  const candidates = [];
  for (let face = 0; face < mesh.indices.length / 3; face++) {
    if (mesh.faceKinds[face] !== 'terrain') continue;
    const point = centroid(mesh, face);
    if (point.x <= -12 || point.x >= 45 || point.y <= -30 || point.y >= 25) continue;
    const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3).map(index => index * 3);
    const twiceArea = Math.abs((mesh.positions[b] - mesh.positions[a]) * (mesh.positions[c + 1] - mesh.positions[a + 1])
      - (mesh.positions[c] - mesh.positions[a]) * (mesh.positions[b + 1] - mesh.positions[a + 1]));
    if (twiceArea >= .1) candidates.push({ ...point, face });
  }
  const holes = [];
  for (const target of [{ x: -5, y: -24 }, { x: 16, y: -24 }, { x: 34, y: -16 }]) {
    const available = candidates.filter(point => holes.every(hole => Math.hypot(point.x - hole.x, point.y - hole.y) > 10));
    available.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y));
    assert.ok(available.length, 'fixture needs three separated visible terrain faces');
    holes.push(available[0]);
  }
  return holes;
}

function rgbTiff(selection, holes) {
  // A 0.1 mm raster resolves 0.75 mm square gray holes on a grass background.
  // EPSG:3857 maps directly to the unrotated model's ground coordinates.
  assert.equal(selection.bearingDeg, 0);
  const stepMm = .1, width = 1280, height = 880, westMm = -64, northMm = 44;
  const pixels = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const point = { x: westMm + (column + .5) * stepMm, y: northMm - (row + .5) * stepMm };
    const gray = insideBigRock(point) || holes.some(hole => Math.abs(point.x - hole.x) <= .375 && Math.abs(point.y - hole.y) <= .375);
    pixels.set(gray ? [145, 145, 145] : [30, 160, 40], (row * width + column) * 3);
  }
  const rad = Math.PI / 180, radius = 6378137, cosLat = Math.cos(selection.center.lat * rad);
  const nativePerMm = 1 / selection.mmPerMeter / cosLat;
  const originX = radius * selection.center.lon * rad + westMm * nativePerMm;
  const originY = radius * Math.log(Math.tan(Math.PI / 4 + selection.center.lat * rad / 2)) + northMm * nativePerMm;
  return Buffer.from(writeArrayBuffer(pixels, { width, height, SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2,
    ModelPixelScale: [stepMm * nativePerMm, stepMm * nativePerMm, 0], ModelTiepoint: [0, 0, 0, originX, originY, 0],
    ProjectedCSTypeGeoKey: 3857, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjLinearUnitsGeoKey: 9001 }));
}

function zipEntries(bytes) {
  const files = new Map(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength), start = offset + 30 + nameLength + extraLength;
    const stored = bytes.subarray(start, start + length);
    files.set(name, method === 8 ? inflateRawSync(stored) : stored); offset = start + length;
  }
  return files;
}

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'case-')), routePath = join(root, '路线.gpx'), imagePath = join(root, '草地小孔与大片山石.tif');
  const workers = [];
  const manager = createDesktopManager({ taskRoot: join(root, 'tasks'), coreModuleUrl, jobTimeoutMs: 60000,
    workerFactory: ({ workerPath }) => {
      const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
      return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
        postMessage: message => worker.send(message), kill: () => worker.kill() };
    } });
  t.after(async () => {
    workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); });
    await manager.close();
    const target = resolve(root);
    assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith('case-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  await fs.writeFile(routePath, gpx);
  const route = await manager.addRoute(routePath), dem = await manager.addDem(join(project, 'data', 'copernicus-longquanshan.tif'));
  return { manager, imagePath, request: { routeId: route.id, demId: dem.id, demMode: 'local', offlineOnly: true, options } };
}

async function generate(manager, request) {
  const job = await manager.start(request), until = Date.now() + 60000;
  while (['running', 'cancelling'].includes(manager.get(job.id).state)) {
    if (Date.now() > until) throw new Error('Grass continuity worker did not settle');
    await new Promise(done => setTimeout(done, 20));
  }
  const completed = manager.get(job.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.error));
  return { job: completed, preview: await manager.preview(job.id), artifact: await manager.artifact(job.id) };
}

function assertProtectedClasses(mesh, classes) {
  const expected = { route: 'route', 'route-wall': 'route', snow: 'snow', 'snow-wall': 'snow', base: 'base', text: 'text', 'text-wall': 'text', frame: 'base', wall: 'rock', bottom: 'base' };
  const seen = new Set();
  for (let face = 0; face < classes.length; face++) {
    const kind = mesh.faceKinds[face]; seen.add(kind);
    if (kind !== 'terrain') assert.equal(classes[face], expected[kind], `${kind} face ${face} must retain its material`);
  }
  return seen;
}

function assertExportsMatchParts(files, format, preview) {
  const manifest = JSON.parse(files.get(format === '3mf' ? 'Metadata/manifest.json' : 'manifest.json').toString('utf8'));
  assert.equal(manifest.appearance.hash, preview.appearance.hash);
  assert.equal(manifest.appearance.options.grassContinuity, undefined);
  const exportedClasses = new Map();
  if (format === '3mf') {
    const xml = files.get('3D/3dmodel.model').toString('utf8');
    for (const object of xml.matchAll(/<object\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g)) {
      const classes = [];
      for (const triangle of object[2].matchAll(/<triangle\b[^>]*p1="(\d+)"[^>]*p2="(\d+)"[^>]*p3="(\d+)"[^>]*\/>/g)) {
        assert.equal(triangle[1], triangle[2]); assert.equal(triangle[1], triangle[3]);
        classes.push(manifest.appearance.palette[Number(triangle[1])].color);
      }
      if (classes.length) exportedClasses.set(object[1], classes);
    }
  } else {
    const palette = new Map(manifest.appearance.palette.map((entry, index) => [`palette_${index}`, entry.color]));
    let object, material;
    for (const line of files.get('model.obj').toString('utf8').split('\n')) {
      if (line.startsWith('o ')) { object = line.slice(2); exportedClasses.set(object, []); }
      else if (line.startsWith('usemtl ')) material = palette.get(line.slice(7));
      else if (line.startsWith('f ')) exportedClasses.get(object).push(material);
    }
  }
  assert.deepEqual([...exportedClasses.keys()].sort(), ['base', 'route', 'snow', 'terrain']);
  for (const part of preview.mesh.materialParts) assert.deepEqual(exportedClasses.get(part.id), part.faceClasses.map(kind => classColor(kind, preview.appearance.options)),
    `${format} must preserve every generated ${part.id} face color, including filled gray holes and linked base colors`);
}

test('real snow worker fills small gray grass holes while preserving rock regions, geometry and exported material classes', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const baseline = await generate(f.manager, { ...f.request, imageMode: 'none', options: { ...options, grassContinuity: 0 } });
  const holes = holeCenters(baseline.preview.mesh), selection = baseline.preview.report.selection;
  await fs.writeFile(f.imagePath, rgbTiff(selection, holes));
  const image = await f.manager.addImage(f.imagePath), runs = [];
  for (const grassContinuity of [0, 100]) runs.push(await generate(f.manager, { ...f.request, imageMode: 'local', imageId: image.id,
    options: { ...options, grassContinuity } }));
  const [low, high] = runs, lowPreview = low.preview, highPreview = high.preview;
  assert.deepEqual(lowPreview.mesh.positions, baseline.preview.mesh.positions);
  assert.deepEqual(lowPreview.mesh.indices, baseline.preview.mesh.indices);
  assert.deepEqual(highPreview.mesh.positions, lowPreview.mesh.positions);
  assert.deepEqual(highPreview.mesh.indices, lowPreview.mesh.indices);
  assert.equal(high.artifact.stlSha256, low.artifact.stlSha256, 'continuity must not change printable geometry');
  assert.equal(highPreview.report.config.grassSensitivity, undefined);
  assert.equal(highPreview.report.config.grassContinuity, undefined);
  for (const hole of holes) assert.equal(lowPreview.appearance.faceClasses[hole.face], 'rock', 'disabled continuity must expose each gray hole');
  const grassCount = preview => preview.appearance.faceClasses.filter((kind, face) => kind === 'grass' && preview.mesh.faceKinds[face] === 'terrain').length;
  const lowGrass = grassCount(lowPreview), highGrass = grassCount(highPreview);
  t.diagnostic(`visible terrain grass faces: continuity 0=${lowGrass}, continuity 100=${highGrass}; holes=${JSON.stringify(holes)}`);
  assert.ok(highGrass > lowGrass, `worker must apply continuity to gray holes: grass count remained ${lowGrass} -> ${highGrass}`);
  for (const hole of holes) assert.equal(highPreview.appearance.faceClasses[hole.face], 'grass', 'strong continuity must fill each sampled small hole');
  const bigRockFaces = lowPreview.mesh.faceKinds.flatMap((kind, face) => kind === 'terrain' && insideBigRock(centroid(lowPreview.mesh, face), 1) ? [face] : []);
  assert.ok(bigRockFaces.length > 100, 'fixture must expose a substantial rock region');
  for (const face of bigRockFaces) {
    assert.equal(lowPreview.appearance.faceClasses[face], 'rock'); assert.equal(highPreview.appearance.faceClasses[face], 'rock');
  }
  assert.notEqual(highPreview.appearance.hash, lowPreview.appearance.hash);
  const seen = assertProtectedClasses(highPreview.mesh, highPreview.appearance.faceClasses);
  for (const kind of ['route', 'route-wall', 'snow', 'snow-wall', 'wall', 'base']) assert.ok(seen.has(kind), `fixture must exercise ${kind}`);
  const core = await import(coreModuleUrl), loadedImage = await core.loadColorGeoTiff(f.imagePath);
  const mask = core.createGrassContinuityMask(highPreview.mesh, selection, loadedImage, 50, 100);
  let filledPartFaces = 0;
  for (const part of highPreview.mesh.materialParts) {
    const before = lowPreview.mesh.materialParts.find(value => value.id === part.id);
    assert.deepEqual(part.positions, before.positions); assert.deepEqual(part.indices, before.indices);
    assertProtectedClasses(part, part.faceClasses);
    for (let face = 0; face < part.faceClasses.length; face++) {
      if (part.faceKinds[face] !== 'terrain') continue;
      const point = centroid(part, face), shouldFill = before.faceClasses[face] === 'rock' && mask.shouldFill(point.x, point.y);
      assert.equal(part.faceClasses[face], shouldFill ? 'grass' : before.faceClasses[face], 'closed terrain must use the exterior continuity mask');
      if (shouldFill) filledPartFaces++;
      if (insideBigRock(point, 1)) assert.equal(part.faceClasses[face], 'rock');
    }
  }
  assert.ok(filledPartFaces > 0, 'closed terrain volume must also gain grass in small gray holes');
  for (const format of ['3mf', 'obj']) {
    const exported = await f.manager.exportModel(high.job.id, format, { ...colors, grassSensitivity: 0, grassContinuity: 0 });
    assert.equal(exported.appearanceHash, highPreview.appearance.hash, 'export must retain generated continuity despite changed classification inputs');
    assertExportsMatchParts(zipEntries(exported.bytes), format, highPreview);
  }
});
