import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { createDesktopManager } from '../main/manager.mjs';

const project = resolve(import.meta.dirname, '../..');
const parent = join(project, 'artifacts/snow-worker-tests');
const colors = { maxColors: 4, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength), start = offset + 30 + nameLength + extra;
    const payload = bytes.subarray(start, start + length);
    files.set(name, method === 8 ? inflateRawSync(payload) : payload);
    offset = start + length;
  }
  return files;
}

test('real snow worker saves classified closed volumes, a white material assembly, recolors and preserves STL', async t => {
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(join(parent, 'case-'));
  const routePath = join(folder, '路线.gpx'), imagePath = join(folder, '地表.tif');
  const route = '<gpx><trk><name>雪面路线</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
  const pixels = Uint8Array.from(Array.from({ length: 16 * 16 }, (_, i) => i % 16 < 8 ? [30, 160, 40] : [150, 145, 140]).flat());
  const tiff = Buffer.from(writeArrayBuffer(pixels, { width: 16, height: 16, SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2,
    ModelPixelScale: [0.01, 0.01, 0], ModelTiepoint: [0, 0, 0, 104.20, 30.65, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1 }));
  await Promise.all([fs.writeFile(routePath, route), fs.writeFile(imagePath, tiff)]);
  const workers = [];
  const manager = createDesktopManager({ taskRoot: join(folder, 'tasks'), coreModuleUrl: pathToFileURL(join(project, 'dist/src/index.js')).href,
    workerFactory: ({ workerPath }) => {
      const child = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(child);
      return { on: (...args) => child.on(...args), once: (...args) => child.once(...args),
        postMessage: value => child.send(value), kill: () => child.kill() };
    } });
  t.after(async () => { workers.forEach(child => { if (child.exitCode === null) child.kill(); }); await manager.close(); await fs.rm(folder, { recursive: true, force: true }); });
  const imported = await manager.addRoute(routePath), dem = await manager.addDem(join(project, 'data/copernicus-longquanshan.tif'));
  const image = await manager.addImage(imagePath);
  const job = await manager.start({ routeId: imported.id, demId: dem.id, imageId: image.id, demMode: 'local', imageMode: 'local',
    options: { gridColumns: 33, ...colors, snowEnabled: true, snowCoveragePercent: 30, snowMaxThicknessMm: 1 } });
  const until = Date.now() + 45000;
  while (['running', 'cancelling'].includes(manager.get(job.id).state)) {
    assert.ok(Date.now() < until, 'snow worker timed out');
    await new Promise(done => setTimeout(done, 10));
  }
  assert.equal(manager.get(job.id).state, 'succeeded', JSON.stringify(manager.get(job.id).error));
  const preview = await manager.preview(job.id);
  assert.equal(preview.report.config.snowEnabled, true);
  assert.ok(Math.abs(preview.report.snow.actualCoveragePercent - 30) <= preview.report.snow.coverageTolerancePercent);
  assert.equal(preview.report.validation.connectedComponents, 1);
  assert.deepEqual(preview.mesh.materialParts.map(part => part.id).sort(), ['route', 'snow', 'terrain']);
  for (const part of preview.mesh.materialParts) {
    assert.equal(part.faceClasses?.length, part.indices.length / 3, 'worker must classify every closed material volume');
    if (part.id !== 'terrain') assert.ok(part.faceClasses.every(kind => kind === part.id));
  }
  const first = await manager.exportModel(job.id, '3mf', colors);
  const files = unzip(first.bytes), xml = files.get('3D/3dmodel.model').toString('utf8');
  assert.match(xml, /<components>/);
  assert.match(xml, /displaycolor="#ffffffff"/i);
  assert.equal((xml.match(/<mesh>/g) ?? []).length, 3);
  const obj = await manager.exportModel(job.id, 'obj', { ...colors, routeColor: '#0055ff' });
  assert.notEqual(obj.appearanceHash, first.appearanceHash);
  const objFiles = unzip(obj.bytes);
  assert.match(objFiles.get('model.mtl').toString('utf8'), /Kd 0 0\.3333333333333333 1/);
  assert.deepEqual((objFiles.get('model.obj').toString('utf8').match(/^o .+$/gm) ?? []).sort(), ['o route', 'o snow', 'o terrain']);
  await assert.rejects(manager.exportModel(job.id, '3mf', { ...colors, maxColors: 3 }), { code: 'CONFIG_INVALID' });
  const stl = await manager.exportModel(job.id, 'stl', colors);
  assert.equal(createHash('sha256').update(stl.bytes).digest('hex'), manager.get(job.id).result.stlSha256);
  assert.deepEqual((await manager.preview(job.id)).appearance, preview.appearance);
});
