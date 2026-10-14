import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createDesktopManager } from '../main/manager.mjs';
import { verifyOutput } from '../main/files.mjs';

const project = resolve(import.meta.dirname, '../..');
const testParent = join(project, 'outputs', 'desktop-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const gpx = '<gpx><trk><name>测试山路</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>测试山路</name><Placemark><LineString><coordinates>104.28,30.56,100 104.30,30.57,120</coordinates></LineString></Placemark></Document></kml>';
const paddedRoute = (xml, bytes) => {
  const contents = Buffer.alloc(bytes, 32); Buffer.from(xml).copy(contents); return contents;
};
const delay = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async condition => {
  const expires = Date.now() + 10000;
  while (!condition()) { if (Date.now() > expires) throw new Error('Test task did not settle'); await delay(5); }
};
class FakeWorker extends EventEmitter {
  constructor(manualExit) { super(); this.manualExit = manualExit; this.kills = 0; }
  postMessage(message) { this.request = message; }
  kill() { this.kills++; if (!this.manualExit) queueMicrotask(() => this.emit('exit', 0)); }
  send(message) { this.emit('message', { ...message, jobId: this.request.jobId }); }
}
async function fixture(t, { timeout = 1000, manualExit = false, factory, cache = true, coreOverride, onLargeRoute, timingOptions = {} } = {}) {
  await mkdir(testParent, { recursive: true });
  const root = await mkdtemp(join(testParent, 'terrain-desktop-manager-'));
  const routePath = join(root, '中文路线.gpx'), demPath = join(root, '高程.tif'), children = [], events = [];
  await Promise.all([writeFile(routePath, gpx), writeFile(demPath, Buffer.from('mock DEM'))]);
  let coreUrl = coreModuleUrl;
  if (coreOverride) {
    const mockPath = join(root, 'test-core.mjs');
    await writeFile(mockPath, `export * from ${JSON.stringify(coreModuleUrl)};\n${coreOverride(root)}`);
    coreUrl = pathToFileURL(mockPath).href;
  }
  const manager = createDesktopManager({ taskRoot: join(root, 'tasks'), coreModuleUrl: coreUrl, jobTimeoutMs: timeout,
    ...(cache ? { demCacheDir: join(root, 'elevation-cache') } : {}),
    workerFactory: factory ?? (() => { const child = new FakeWorker(manualExit); children.push(child); return child; }),
    onJob: job => events.push(job), ...(onLargeRoute ? { onLargeRoute } : {}), ...timingOptions });
  t.after(async () => {
    children.forEach(child => child.emit('exit', 0));
    await manager.close();
    const target = resolve(root);
    assert.equal(dirname(target), testParent); assert.ok(basename(target).startsWith('terrain-desktop-manager-'));
    await rm(target, { recursive: true, force: true });
  });
  const route = await manager.addRoute(routePath), dem = await manager.addDem(demPath);
  return { root, manager, route, dem, routePath, demPath, children, events, start: options => manager.start({ routeId: route.id, demId: dem.id, options }) };
}
async function writeOutput(taskDir, { corrupt = false, dem, appearance } = {}) {
  const positions = [0, 0, 0, 1.123456789, 0, 0, 0, 1, 0, 0, 0, 1];
  const indices = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
  const stl = Buffer.alloc(284); stl.writeUInt32LE(4, 80);
  for (let t = 0; t < 4; t++) for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) stl.writeFloatLE(positions[indices[t * 3 + v] * 3 + a], 84 + t * 50 + 12 + v * 12 + a * 4);
  const sha = createHash('sha256').update(stl).digest('hex');
  const report = { stage: 2, output: { bytes: stl.length, sha256: corrupt ? '0'.repeat(64) : sha },
    validation: { triangleCount: 4, connectedComponents: 1, boundaryEdges: 0, nonManifoldEdges: 0 }, ...(dem ? { dem } : {}), ...(appearance ? { appearanceHash: appearance.hash } : {}) };
  const preview = { stage: 2, unit: 'mm', mesh: { positions, indices, faceKinds: ['wall', 'terrain', 'route', 'bottom'] }, ...(appearance ? { appearance } : {}) };
  await Promise.all([writeFile(join(taskDir, 'model.stl'), stl), writeFile(join(taskDir, 'model.report.json'), JSON.stringify(report)), writeFile(join(taskDir, 'model.preview.json'), JSON.stringify(preview))]);
}

test('output verification rejects color data with bad face count, materials, palette or hash', async t => {
  const f = await fixture(t), core = await import(coreModuleUrl), taskDir = join(f.root, 'color-verification');
  await mkdir(taskDir); await writeOutput(taskDir);
  const path = join(taskDir, 'model.preview.json'), initial = JSON.parse(await readFile(path, 'utf8'));
  const appearance = core.buildModelAppearance(initial.mesh, { center: { lat: 30.56, lon: 104.28 }, bearingDeg: 0, mmPerMeter: 0.03 },
    { maxColors: 3, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' });
  await writeOutput(taskDir, { appearance });
  assert.equal((await verifyOutput(taskDir, core.validateModelAppearance)).preview.appearance.classification, 'uniform');
  const valid = JSON.parse(await readFile(path, 'utf8'));
  for (const corrupt of [
    value => value.faceClasses.pop(), value => value.faceMaterials[0] = 9,
    value => value.palette.push({ id: 'grass', name: 'extra', color: '#112233' }), value => value.hash = '0'.repeat(64),
  ]) {
    const changed = structuredClone(valid); corrupt(changed.appearance); await writeFile(path, JSON.stringify(changed));
    await assert.rejects(verifyOutput(taskDir, core.validateModelAppearance), { code: 'OUTPUT_INVALID' });
  }
  await writeFile(path, JSON.stringify(valid));
  const reportPath = join(taskDir, 'model.report.json'), report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.appearanceHash = '0'.repeat(64); await writeFile(reportPath, JSON.stringify(report));
  await assert.rejects(verifyOutput(taskDir, core.validateModelAppearance), { code: 'OUTPUT_MISMATCH' });
});

test('route information uses opaque ids, preserves segment breaks and does not expose paths', async t => {
  const f = await fixture(t);
  assert.equal(f.route.name, '测试山路'); assert.equal(f.route.pointCount, 2); assert.equal(f.route.fileName, '中文路线.gpx');
  assert.ok(!JSON.stringify(f.route).includes(f.root)); assert.ok(!JSON.stringify(f.dem).includes(f.root));
  const split = join(f.root, '多段.gpx');
  await writeFile(split, '<gpx><trk><trkseg><trkpt lat="30" lon="104"/><trkpt lat="30.01" lon="104.01"/></trkseg><trkseg><trkpt lat="30.03" lon="104.03"/><trkpt lat="30.04" lon="104.04"/></trkseg></trk></gpx>');
  const route = await f.manager.addRoute(split);
  assert.equal(route.segmentCount, 2); assert.deepEqual(route.segments.map(segment => segment.length), [2, 2]);
});

test('KML import accepts selected uppercase extension and preserves route coordinates without exposing paths', async t => {
  const f = await fixture(t), path = join(f.root, '中文路线.KML');
  await writeFile(path, kml);
  const route = await f.manager.addRoute(path);
  assert.equal(route.name, '测试山路'); assert.equal(route.fileName, '中文路线.KML');
  assert.equal(route.pointCount, 2); assert.equal(route.segmentCount, 1);
  assert.deepEqual(route.segments, [[{ lat: 30.56, lon: 104.28 }, { lat: 30.57, lon: 104.30 }]]);
  assert.ok(!JSON.stringify(route).includes(f.root)); assert.equal(route.isSample, false);
  const descriptor = f.manager.sessionSources({ routeId: route.id }).route;
  assert.equal(descriptor.fileName, '中文路线.KML'); assert.equal(descriptor.bytes, Buffer.byteLength(kml));
  assert.equal(descriptor.sha256, createHash('sha256').update(kml).digest('hex'));
  assert.equal(await readFile(path, 'utf8'), kml);
});

test('KML MultiGeometry imports independent lines and inspection preserves every discontinuity', async t => {
  const f = await fixture(t), path = join(f.root, '多段.kml');
  await writeFile(path, '<kml><Placemark><name>多段山路</name><MultiGeometry>'
    + '<LineString><coordinates>104,30 104.01,30.01 invalid 104.03,30.03 104.04,30.04</coordinates></LineString>'
    + '<LineString><coordinates>104.06,30.06 104.07,30.07</coordinates></LineString>'
    + '</MultiGeometry></Placemark></kml>');
  const route = await f.manager.addRoute(path);
  assert.equal(route.name, '多段山路'); assert.equal(route.pointCount, 6); assert.equal(route.invalidPointCount, 1);
  assert.equal(route.segmentCount, 3);
  assert.deepEqual(route.segments, [
    [{ lat: 30, lon: 104 }, { lat: 30.01, lon: 104.01 }],
    [{ lat: 30.03, lon: 104.03 }, { lat: 30.04, lon: 104.04 }],
    [{ lat: 30.06, lon: 104.06 }, { lat: 30.07, lon: 104.07 }],
  ]);
  const inspected = await f.manager.inspect({ routeId: route.id, options: {} });
  assert.deepEqual(inspected.routeSegmentsMm.map(segment => segment.length), [2, 2, 2]);
  assert.ok(inspected.routeSegmentsMm.flat().every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(!JSON.stringify(inspected).includes(f.root));
});

test('KML malformed XML, DTD and unsupported geometry retain actionable format errors', async t => {
  const f = await fixture(t), path = join(f.root, '无效.kml');
  for (const [xml, code] of [
    ['<kml><Placemark>', 'KML_INVALID_XML'],
    ['<!DOCTYPE kml [<!ENTITY x "x">]><kml/>', 'KML_UNSUPPORTED_DTD'],
    ['<kml><Placemark><Point><coordinates>104,30</coordinates></Point></Placemark></kml>', 'KML_NO_TRACK'],
    ['<kml><Placemark><LineString><coordinates>invalid 200,100</coordinates></LineString></Placemark></kml>', 'KML_NO_TRACK'],
  ]) {
    await writeFile(path, xml);
    await assert.rejects(f.manager.addRoute(path), error => error.code === code && /KML|路线|坐标/.test(error.message));
    assert.equal(await readFile(path, 'utf8'), xml);
  }
});

test('KML resource limits reject files over 32 MB and lines over 50,000 source points', async t => {
  const f = await fixture(t), path = join(f.root, '超大.kml');
  await writeFile(path, Buffer.alloc(32 * 1024 * 1024 + 1, 32));
  await assert.rejects(f.manager.addRoute(path), { code: 'INPUT_TOO_LARGE' });
  await writeFile(path, `<kml><Placemark><LineString><coordinates>${'104,30 '.repeat(50001)}</coordinates></LineString></Placemark></kml>`);
  await assert.rejects(f.manager.addRoute(path), { code: 'KML_TOO_COMPLEX' });
});

test('KML singleton lines cannot join across separate segments to satisfy the minimum route length', async t => {
  const f = await fixture(t), path = join(f.root, '单点.kml');
  await writeFile(path, '<kml><Placemark><MultiGeometry><LineString><coordinates>104,30</coordinates></LineString>'
    + '<LineString><coordinates>104.01,30.01</coordinates></LineString></MultiGeometry></Placemark></kml>');
  await assert.rejects(f.manager.addRoute(path), { code: 'KML_TOO_SHORT' });
});

test('route file extension selects its parser and mismatched GPX or KML content is rejected', async t => {
  const f = await fixture(t), wrongKml = join(f.root, '错格式.kml'), wrongGpx = join(f.root, '错格式.GPX');
  await Promise.all([writeFile(wrongKml, gpx), writeFile(wrongGpx, kml)]);
  await assert.rejects(f.manager.addRoute(wrongKml), { code: 'KML_INVALID_FORMAT' });
  await assert.rejects(f.manager.addRoute(wrongGpx), { code: 'GPX_INVALID_FORMAT' });
});

test('unchanged KML can be imported with its saved SHA while changed bytes are rejected', async t => {
  const f = await fixture(t), path = join(f.root, '校验.kml'), digest = createHash('sha256').update(kml).digest('hex');
  await writeFile(path, kml);
  const route = await f.manager.addRoute(path, { isSample: true, expectedSha256: digest });
  assert.equal(route.isSample, true); assert.equal(f.manager.sessionSources({ routeId: route.id }).route.isSample, true);
  const changed = kml.replace('104.28', '105.28'); await writeFile(path, changed);
  await assert.rejects(f.manager.addRoute(path, { expectedSha256: digest }), { code: 'SESSION_INPUT_CHANGED' });
  assert.equal(await readFile(path, 'utf8'), changed);
});

test('invalid file types, missing inputs and malformed XML return clear typed errors', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.addRoute(f.demPath), { code: 'INPUT_INVALID' });
  await assert.rejects(f.manager.addDem(join(f.root, 'missing.tif')), { code: 'INPUT_READ_FAILED' });
  await writeFile(f.routePath, '<gpx><trk>');
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'GPX_INVALID_XML' });
  await writeFile(f.routePath, '<!DOCTYPE gpx [<!ENTITY x "x">]><gpx/>');
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'GPX_UNSUPPORTED_DTD' });
});

test('GPX resource limits reject files over 32 MB and tracks over 50,000 source points', async t => {
  const f = await fixture(t);
  await writeFile(f.routePath, Buffer.alloc(32 * 1024 * 1024 + 1, 32));
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'INPUT_TOO_LARGE' });
  await writeFile(f.routePath, `<gpx><trk><trkseg>${'<trkpt lat="30" lon="104"/>'.repeat(50001)}</trkseg></trk></gpx>`);
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'GPX_TOO_COMPLEX' });
});

for (const [extension, xml] of [['gpx', gpx], ['kml', kml]]) {
  test(`${extension.toUpperCase()} import accepts 32 MB inclusively and warns only above 2 MB`, async t => {
    const notices = [], f = await fixture(t, { onLargeRoute: notice => notices.push(notice) });
    const path = join(f.root, `边界.${extension}`);
    for (const [bytes, warningCount] of [[2097151, 0], [2097152, 0], [2097153, 1], [33554432, 2]]) {
      const contents = paddedRoute(xml, bytes); await writeFile(path, contents);
      const route = await f.manager.addRoute(path);
      assert.equal(route.pointCount, 2); assert.equal(route.name, '测试山路');
      const descriptor = f.manager.sessionSources({ routeId: route.id }).route;
      assert.equal(descriptor.bytes, bytes); assert.equal(descriptor.sha256, createHash('sha256').update(contents).digest('hex'));
      assert.equal(notices.length, warningCount);
      if (warningCount) assert.deepEqual(notices.at(-1), { fileName: `边界.${extension}`, bytes });
    }
    await writeFile(path, Buffer.alloc(33554433, 32));
    await assert.rejects(f.manager.addRoute(path), error => error.code === 'INPUT_TOO_LARGE' && /32 MB/.test(error.message));
    assert.equal(notices.length, 2, 'an unsupported file must be rejected without a misleading continue notice');
  });
}

test('large route notice finishes before file reading and parsing continue', async t => {
  let notices = 0;
  const f = await fixture(t, { onLargeRoute: async notice => {
    notices++;
    assert.deepEqual(notice, { fileName: '提示后读取.gpx', bytes: 2097153 });
    // Start with malformed XML: reading before awaiting the notice would fail.
    await delay(20);
    await writeFile(join(f.root, notice.fileName), paddedRoute(gpx, notice.bytes));
  } });
  const path = join(f.root, '提示后读取.gpx');
  await writeFile(path, paddedRoute('<gpx><trk>', 2097153));
  const route = await f.manager.addRoute(path);
  assert.equal(notices, 1); assert.equal(route.pointCount, 2);
  assert.equal(route.name, '测试山路');
});

test('a large route notice does not bypass the 50,000 source-point limit', async t => {
  const notices = [], f = await fixture(t, { onLargeRoute: notice => notices.push(notice) });
  for (const [extension, xml, code] of [
    ['gpx', `<gpx><trk><trkseg>${'<trkpt lat="30" lon="104"/>'.repeat(50001)}</trkseg></trk></gpx>`, 'GPX_TOO_COMPLEX'],
    ['kml', `<kml><Placemark><LineString><coordinates>${'104,30 '.repeat(50001)}</coordinates></LineString></Placemark></kml>`, 'KML_TOO_COMPLEX'],
  ]) {
    const fileName = `过多点.${extension}`, path = join(f.root, fileName);
    await writeFile(path, paddedRoute(xml, 2097153));
    await assert.rejects(f.manager.addRoute(path), { code });
    assert.deepEqual(notices.at(-1), { fileName, bytes: 2097153 });
  }
  assert.equal(notices.length, 2);
});

test('route growth while showing a notice still rejects bytes above 32 MB after reading', async t => {
  const f = await fixture(t, { onLargeRoute: notice => writeFile(join(f.root, notice.fileName), Buffer.alloc(33554433, 32)) });
  const path = join(f.root, '变大.gpx'); await writeFile(path, paddedRoute(gpx, 2097153));
  await assert.rejects(f.manager.addRoute(path), error => error.code === 'INPUT_TOO_LARGE' && /32 MB/.test(error.message));
});

test('inspection shares core projection and produces usable circle, rectangle and polygon outlines', async t => {
  const f = await fixture(t);
  const { createTerrainFrame } = await import(coreModuleUrl);
  for (const shape of ['rectangle', 'circle', 'polygon']) {
    const options = { shape, widthMm: 120, heightMm: 80, bearingDeg: 23 };
    const inspected = await f.manager.inspect({ routeId: f.route.id, options });
    const frame = createTerrainFrame(f.route.segments.flat(), options);
    assert.equal(inspected.routeSegmentsMm.length, 1); assert.ok(inspected.outlineMm.length >= 4);
    assert.ok(inspected.selection.groundWidthM > 0); assert.equal(inspected.selection.bearingDeg, 23);
    assert.ok(inspected.routeSegmentsMm.flat().every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.deepEqual(inspected.bounds, frame.bounds);
    assert.deepEqual(inspected.outlineGeo, inspected.outlineMm.map(point => frame.mmToGeo(point.x, point.y)));
    assert.ok(inspected.outlineGeo.every(point => point.lat >= frame.bounds.south && point.lat <= frame.bounds.north
      && point.lon >= frame.bounds.west && point.lon <= frame.bounds.east));
  }
});

test('inspection exposes sharp rectangle handles independently from its rounded outline', async t => {
  const f = await fixture(t);
  const options = { widthMm: 120, heightMm: 80, cornerRadiusMm: 12, bearingDeg: 31, groundWidthM: 4000 };
  const inspected = await f.manager.inspect({ routeId: f.route.id, options });
  assert.deepEqual(inspected.controlVerticesMm, [{ x: -60, y: -40 }, { x: 60, y: -40 }, { x: 60, y: 40 }, { x: -60, y: 40 }]);
  assert.ok(inspected.outlineMm.length > inspected.controlVerticesMm.length);
  const { createTerrainFrame } = await import(coreModuleUrl), frame = createTerrainFrame(f.route.segments.flat(), options);
  for (let i = 0; i < inspected.controlVerticesGeo.length; i++) {
    const point = frame.geoToMm(inspected.controlVerticesGeo[i]), expected = inspected.controlVerticesMm[i];
    assert.ok(Math.abs(point.x - expected.x) < 1e-7); assert.ok(Math.abs(point.y - expected.y) < 1e-7);
  }
  assert.equal(inspected.selection.groundWidthM, 4000); assert.equal(inspected.selection.bearingDeg, 31);
});

test('inspection exposes four circle cardinal handles and regular polygon corners', async t => {
  const f = await fixture(t);
  const circle = await f.manager.inspect({ routeId: f.route.id, options: { shape: 'circle', widthMm: 120 } });
  assert.deepEqual(circle.controlVerticesMm, [{ x: 60, y: 0 }, { x: 0, y: 60 }, { x: -60, y: 0 }, { x: 0, y: -60 }]);
  assert.equal(circle.controlVerticesGeo.length, 4);
  const polygon = await f.manager.inspect({ routeId: f.route.id, options: { shape: 'polygon', widthMm: 120, polygonSides: 4, cornerRadiusMm: 10 } });
  const expected = [{ x: 42.42640687119285, y: -42.42640687119285 }, { x: 42.42640687119285, y: 42.42640687119285 },
    { x: -42.42640687119285, y: 42.42640687119285 }, { x: -42.42640687119285, y: -42.42640687119285 }];
  assert.equal(polygon.controlVerticesMm.length, 4); assert.equal(polygon.controlVerticesGeo.length, 4);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(polygon.controlVerticesMm[i].x - expected[i].x) < 1e-10);
    assert.ok(Math.abs(polygon.controlVerticesMm[i].y - expected[i].y) < 1e-10);
  }
  assert.ok(polygon.outlineMm.length > polygon.controlVerticesMm.length);
});

test('automatic mode starts without local DEM and freezes the inspected geographic request', async t => {
  const f = await fixture(t);
  const options = { center: { lat: 30.565, lon: 104.29 }, groundWidthM: 4000, bearingDeg: 31 };
  const inspected = await f.manager.inspect({ routeId: f.route.id, options });
  const request = { routeId: f.route.id, options, offlineOnly: true };
  const job = await f.manager.start(request);
  options.center.lon = 105; options.groundWidthM = 9000; request.offlineOnly = false; request.demMode = 'local';
  const message = f.children[0].request;
  assert.equal(job.demMode, 'auto'); assert.equal(job.offlineOnly, true);
  assert.equal(message.demMode, 'auto'); assert.equal(message.offlineOnly, true);
  assert.equal(message.demCacheDir, join(f.root, 'elevation-cache')); assert.equal(message.demPath, undefined);
  assert.equal(message.options.center.lon, 104.29); assert.equal(message.options.groundWidthM, 4000);
  assert.deepEqual(message.bounds, inspected.bounds);
  assert.ok(Object.isFrozen(message.bounds)); assert.ok(Object.isFrozen(message.options));
  assert.ok(!JSON.stringify(job).includes(f.root));
});

test('automatic mode requires a configured cache and invalid source settings never launch', async t => {
  const f = await fixture(t, { cache: false });
  await assert.rejects(f.manager.start({ routeId: f.route.id, options: {} }), { code: 'DEM_CACHE_UNAVAILABLE' });
  for (const request of [{ demMode: 'remote' }, { demMode: null }, { demMode: '' }, { offlineOnly: 'true' }, { offlineOnly: 1 }, { offlineOnly: null }]) {
    await assert.rejects(f.manager.start({ routeId: f.route.id, options: {}, ...request }), { code: 'CONFIG_INVALID' });
  }
  await assert.rejects(f.manager.start({ routeId: f.route.id, demMode: 'local', options: {} }), { code: 'DEM_NOT_FOUND' });
  assert.equal(f.children.length, 0);
  assert.equal((await f.start({})).demMode, 'local');
});

test('two simultaneous starts still reserve exactly one worker', async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([
    f.manager.start({ routeId: f.route.id, options: {} }),
    f.manager.start({ routeId: f.route.id, options: {} }),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'JOB_BUSY');
  assert.equal(f.children.length, 1);
});

test('automatic high-elevation failures retain actionable Chinese errors and release on exit', async t => {
  const f = await fixture(t, { manualExit: true });
  const job = await f.manager.start({ routeId: f.route.id, offlineOnly: true, options: {} });
  const child = f.children[0];
  child.send({ type: 'failure', error: { code: 'DEM_CACHE_MISS', message: '离线缓存未覆盖当前取景，请联网获取高程后重试' } });
  await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.deepEqual(f.manager.get(job.id).error, { code: 'DEM_CACHE_MISS', message: '离线缓存未覆盖当前取景，请联网获取高程后重试' });
  assert.equal((await f.start({})).state, 'running');
});

test('verified automatic source summary includes cache state and excludes URLs, file paths and extra fields', async t => {
  const f = await fixture(t), job = await f.manager.start({ routeId: f.route.id, options: {} });
  const child = f.children[0];
  await writeOutput(child.request.taskDir, { dem: { provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)',
    cacheHit: true, tileCount: 2, sourceUrls: ['https://example.com/a'], path: f.root, key: 'private' } });
  child.send({ type: 'complete' }); child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  assert.deepEqual(f.manager.get(job.id).result.demSource, { provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)', cacheHit: true, tileCount: 2 });
  assert.ok(!JSON.stringify(f.manager.get(job.id)).includes('private'));
  assert.ok(!JSON.stringify(f.manager.get(job.id)).includes('https://'));
});

test('options reject unknown fields, unsupported scales and invalid values before launching a worker', async t => {
  const f = await fixture(t);
  for (const options of [{ widthMm: 0 }, { gridColumns: 258 }, { gridColumns: 128.5 }, { routeWidthMm: 0.1 }, { center: { lat: 91, lon: 0 } }, { output: 'secret' }, { shape: 'triangle' }, { smoothing: 'magic' }, { shape: 'circle', cornerRadiusMm: 1 }]) {
    await assert.rejects(f.start(options), { code: 'CONFIG_INVALID' });
  }
  assert.equal(f.children.length, 0);
});

test('route appearance defaults preserve the existing relief and stay outside worker geometry', async t => {
  const f = await fixture(t), job = await f.start({});
  assert.equal(job.options.routeHeightMm, 1);
  assert.equal(job.options.routeColor, '#c84832');
  assert.equal(f.children[0].request.options.routeHeightMm, 1);
  assert.equal(f.children[0].request.options.routeColor, undefined);
  assert.equal(f.children[0].request.options.maxColors, undefined);
  assert.equal(f.children[0].request.options.grassColor, undefined);
  assert.equal(f.children[0].request.options.rockColor, undefined);
  for (const key of ['baseColorSource', 'baseColor', 'textColorSource', 'textColor']) assert.equal(f.children[0].request.options[key], undefined);
  assert.deepEqual(f.children[0].request.appearanceOptions, { maxColors: 6, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832', baseColorSource: 'rock', baseColor: '#a9aa92', textColorSource: 'route', textColor: '#c84832', grassEnabled:true, rockEnabled:true });
  assert.ok(Object.isFrozen(f.children[0].request.options));
});

test('invalid color budgets and mountain colors cannot launch generation', async t => {
  const f = await fixture(t);
  for (const options of [{ grassEnabled:false,rockEnabled:false }, { maxColors: 7 }, { maxColors: '3' }, { grassColor: 'green' }, { rockColor: '#fff' }, { grassColor: null }]) {
    await assert.rejects(f.start(options), { code: 'CONFIG_INVALID' });
  }
  assert.equal(f.children.length, 0);
});

test('route settings accept height endpoints and normalize color without changing the crop', async t => {
  const f = await fixture(t), before = await f.manager.inspect({ routeId: f.route.id, options: {} });
  for (const routeHeightMm of [0.1, 10]) {
    const options = { routeHeightMm, routeColor: '#12ABF0', routeWidthMm: 2.5 };
    const after = await f.manager.inspect({ routeId: f.route.id, options });
    assert.deepEqual(after, before);
    const job = await f.start(options);
    options.routeHeightMm = 5; options.routeColor = '#ffffff';
    assert.equal(job.options.routeHeightMm, routeHeightMm);
    assert.equal(job.options.routeColor, '#12abf0');
    assert.equal(f.children.at(-1).request.options.routeHeightMm, routeHeightMm);
    assert.equal(f.children.at(-1).request.options.routeWidthMm, 2.5);
    assert.equal(f.children.at(-1).request.options.routeColor, undefined);
    f.manager.cancel(job.id);
    await waitFor(() => f.manager.get(job.id).state === 'cancelled');
  }
});

test('invalid route heights and non-RGB colors are rejected before worker launch', async t => {
  const f = await fixture(t);
  for (const routeHeightMm of [0, 0.09, 10.01, Infinity, NaN, '1', null]) {
    await assert.rejects(f.start({ routeHeightMm }), { code: 'CONFIG_INVALID' });
  }
  for (const routeColor of ['red', '#fff', '#12345678', '123456', '#zzzzzz', '#123456 ', '', null, 123456]) {
    await assert.rejects(f.start({ routeColor }), { code: 'CONFIG_INVALID' });
  }
  assert.equal(f.children.length, 0);
});

test('one task freezes caller parameters and blocks a second task until actual worker exit', async t => {
  const f = await fixture(t, { manualExit: true });
  const options = { widthMm: 100, center: { lat: 30.565, lon: 104.29 } };
  const job = await f.start(options); options.widthMm = 200; options.center.lon = 105;
  assert.equal(f.manager.get(job.id).options.widthMm, 100); assert.equal(f.children[0].request.options.center.lon, 104.29);
  await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  f.manager.cancel(job.id); assert.equal(f.manager.get(job.id).state, 'cancelling');
  await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  f.children[0].emit('exit', 0);
  await waitFor(() => f.manager.get(job.id).state === 'cancelled');
  const second = await f.start({}); assert.equal(second.state, 'running');
});

test('completion verifies binary STL, returns matching Float32 preview and a path-free job result', async t => {
  const f = await fixture(t);
  const job = await f.start({}); const child = f.children[0];
  await writeOutput(child.request.taskDir);
  child.send({ type: 'progress', progress: 1, message: 'core finished' });
  assert.equal(f.manager.get(job.id).progress, 0.99);
  child.send({ type: 'complete', path: join(f.root, 'untrusted.stl') });
  assert.equal(f.manager.get(job.id).state, 'running'); child.emit('exit', 0);
  await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  const final = f.manager.get(job.id), preview = await f.manager.preview(job.id), artifact = await f.manager.artifact(job.id);
  assert.equal(preview.mesh.positions[3], Math.fround(1.123456789)); assert.equal(final.result.triangleCount, 4);
  assert.equal(final.result.dimensions.x, Math.fround(1.123456789)); assert.equal(artifact.stlSha256, final.result.stlSha256);
  assert.ok(artifact.path.endsWith('model.stl')); assert.ok(!JSON.stringify(final).includes(f.root));
  await writeFile(artifact.path, 'changed'); await assert.rejects(f.manager.artifact(job.id), { code: 'OUTPUT_MISMATCH' });
});

test('cancellation ignores late completion, removes owned files and allows retry', async t => {
  const f = await fixture(t, { manualExit: true }); const job = await f.start({}), child = f.children[0];
  await writeOutput(child.request.taskDir); f.manager.cancel(job.id); child.send({ type: 'complete' }); child.emit('exit', 0);
  await waitFor(() => f.manager.get(job.id).state === 'cancelled');
  assert.equal(f.manager.get(job.id).result, undefined);
  assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
  await assert.rejects(f.manager.preview(job.id), { code: 'RESULT_UNAVAILABLE' });
  assert.equal((await f.start({})).state, 'running');
});

test('timeout kills the worker, awaits exit and exposes an actionable failure', async t => {
  const f = await fixture(t, { timeout: 15, manualExit: true }); const job = await f.start({}), child = f.children[0];
  await waitFor(() => child.kills === 1); await assert.rejects(f.start({}), { code: 'JOB_BUSY' });
  child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.equal(f.manager.get(job.id).error.code, 'JOB_TIMEOUT'); assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});

test('unexpected worker exit fails cleanly instead of reporting success', async t => {
  const f = await fixture(t), job = await f.start({}); f.children[0].emit('exit', 9);
  await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.equal(f.manager.get(job.id).error.code, 'WORKER_CRASHED'); assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});

test('missing or corrupt results are rejected and task directories are cleaned', async t => {
  const f = await fixture(t);
  for (const corrupt of [undefined, true]) {
    const job = await f.start({}), child = f.children.at(-1);
    if (corrupt) await writeOutput(child.request.taskDir, { corrupt });
    child.send({ type: 'complete' }); child.emit('exit', 0);
    await waitFor(() => f.manager.get(job.id).state === 'failed');
    assert.ok(['OUTPUT_READ_FAILED', 'OUTPUT_INVALID'].includes(f.manager.get(job.id).error.code));
  }
  assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});

test('close cancels active computation and waits for process exit', async t => {
  const f = await fixture(t, { manualExit: true }), job = await f.start({}); let resolved = false;
  const closing = f.manager.close().then(() => { resolved = true; });
  await delay(5); assert.equal(resolved, false); assert.equal(f.children[0].kills, 1);
  f.children[0].emit('exit', 0); await closing; assert.equal(f.manager.get(job.id).state, 'cancelled');
  await assert.rejects(f.manager.addRoute(f.routePath), { code: 'APP_CLOSED' });
});

test('successful task storage is bounded and closing removes only app-owned temporary results', async t => {
  const f = await fixture(t), ids = [];
  const unrelated = join(f.root, '保留我的文件.txt'); await writeFile(unrelated, 'keep');
  for (let i = 0; i < 4; i++) {
    const job = await f.start({}), child = f.children.at(-1); ids.push(job.id);
    await writeOutput(child.request.taskDir); child.send({ type: 'complete' }); child.emit('exit', 0);
    await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  }
  await waitFor(() => { try { f.manager.get(ids[0]); return false; } catch (error) { return error.code === 'JOB_NOT_FOUND'; } });
  assert.equal((await readdir(join(f.root, 'tasks'))).length, 3);
  await f.manager.close(); assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});

test('real isolated Node process generates the approved sample and verifies matching preview/STL', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const route = await f.manager.addRoute(join(project, 'fixtures/sample-trail.gpx'), { isSample: true });
  const dem = await f.manager.addDem(join(project, 'data/copernicus-longquanshan.tif'), { isSample: true, dataset: 'Copernicus DSM GLO-30' });
  const job = await f.manager.start({ routeId: route.id, demId: dem.id, options: { gridColumns: 65 } });
  await waitFor(() => ['succeeded', 'failed'].includes(f.manager.get(job.id).state));
  const final = f.manager.get(job.id); assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.equal(final.result.dimensions.x, 126); assert.equal(final.result.dimensions.y, 86);
  const preview = await f.manager.preview(job.id); assert.equal(preview.report.dem.source.sha256, preview.report.dem.sha256);
  assert.ok(preview.mesh.faceKinds.includes('route')); assert.ok(preview.mesh.faceKinds.includes('frame'));
  const artifact = await f.manager.artifact(job.id); assert.equal((await readFile(artifact.path)).length, artifact.bytes);
  assert.ok(f.events.some(event => event.progress > 0 && event.progress < 1));
});

test('isolated worker generates equivalent GPX and KML multi-line routes with matching preview and STL', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const gpxPath = join(f.root, '等价.gpx'), kmlPath = join(f.root, '等价.kml');
  const equivalentGpx = '<gpx><trk><name>多段测试山路</name>'
    + '<trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.563" lon="104.29"/></trkseg>'
    + '<trkseg><trkpt lat="30.567" lon="104.296"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
  const equivalentKml = '<kml><Document><name>多段测试山路</name><Placemark><MultiGeometry>'
    + '<LineString><coordinates>104.28,30.56 104.29,30.563</coordinates></LineString>'
    + '<LineString><coordinates>104.296,30.567 104.30,30.57</coordinates></LineString>'
    + '</MultiGeometry></Placemark></Document></kml>';
  await Promise.all([writeFile(gpxPath, equivalentGpx), writeFile(kmlPath, equivalentKml)]);
  const routes = [await f.manager.addRoute(gpxPath), await f.manager.addRoute(kmlPath)];
  const dem = await f.manager.addDem(join(project, 'data/copernicus-longquanshan.tif'));
  const outputs = [];
  for (const route of routes) {
    assert.equal(route.segmentCount, 2);
    const job = await f.manager.start({ routeId: route.id, demId: dem.id, options: { gridColumns: 33 } });
    await waitFor(() => ['succeeded', 'failed'].includes(f.manager.get(job.id).state));
    const final = f.manager.get(job.id); assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
    const preview = await f.manager.preview(job.id), artifact = await f.manager.artifact(job.id);
    assert.ok(preview.mesh.faceKinds.includes('route')); assert.equal(artifact.stlSha256, final.result.stlSha256);
    outputs.push({ mesh: preview.mesh, bytes: await readFile(artifact.path), dimensions: final.result.dimensions });
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(await readFile(gpxPath, 'utf8'), equivalentGpx); assert.equal(await readFile(kmlPath, 'utf8'), equivalentKml);
});

test('isolated worker applies route thickness while preview color leaves saved STL bytes unchanged', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const route = await f.manager.addRoute(join(project, 'fixtures/sample-trail.gpx'));
  const dem = await f.manager.addDem(join(project, 'data/copernicus-longquanshan.tif'));
  const artifacts = [];
  for (const [routeHeightMm, routeColor] of [[2.4, '#ff0000'], [2.4, '#0000ff'], [1, '#0000ff']]) {
    const job = await f.manager.start({ routeId: route.id, demId: dem.id,
      options: { gridColumns: 33, routeWidthMm: 1.8, routeHeightMm, routeColor } });
    await waitFor(() => ['succeeded', 'failed'].includes(f.manager.get(job.id).state));
    const final = f.manager.get(job.id); assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
    const preview = await f.manager.preview(job.id);
    assert.equal(preview.report.config.routeHeightMm, routeHeightMm);
    assert.equal(preview.report.config.routeWidthMm, 1.8);
    assert.equal(preview.report.integratedModel.route.heightMm, routeHeightMm);
    assert.ok(preview.report.integratedModel.route.maxStlHeightErrorMm <= 0.001);
    artifacts.push(await f.manager.artifact(job.id));
  }
  assert.deepEqual(await readFile(artifacts[0].path), await readFile(artifacts[1].path));
  assert.notEqual(artifacts[0].stlSha256, artifacts[2].stlSha256);
});

test('isolated automatic worker uses frozen bounds, reports measured DEM progress and returns a matching STL', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, coreOverride: root => `
    import { writeFile } from 'node:fs/promises';
    import { loadLocalDem } from ${JSON.stringify(coreModuleUrl)};
    export async function loadCopernicusDem(bounds, options) {
      await writeFile(${JSON.stringify(join(root, 'provider-request.json'))}, JSON.stringify({bounds, cacheDir: options.cacheDir, offlineOnly: options.offlineOnly}));
      options.onProgress({progress: 0.25, message: '已读取 1/4 高程范围'});
      options.onProgress({progress: 0.75, message: '已读取 3/4 高程范围'});
      const dem = await loadLocalDem(${JSON.stringify(join(project, 'data/copernicus-longquanshan.tif'))});
      dem.metadata = {...dem.metadata, provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)', cacheHit: false, tileCount: 1};
      options.onProgress({progress: 1, message: '高程验证完成'});
      return dem;
    }
  `, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const route = await f.manager.addRoute(join(project, 'fixtures/sample-trail.gpx'));
  const options = { gridColumns: 65 }, inspected = await f.manager.inspect({ routeId: route.id, options });
  const job = await f.manager.start({ routeId: route.id, options, offlineOnly: true });
  await waitFor(() => ['succeeded', 'failed'].includes(f.manager.get(job.id).state));
  const final = f.manager.get(job.id); assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'provider-request.json'), 'utf8')),
    { bounds: inspected.bounds, cacheDir: join(f.root, 'elevation-cache'), offlineOnly: true });
  for (const expected of [0.195, 0.305, 0.36]) assert.ok(f.events.some(event => Math.abs(event.progress - expected) < 1e-12));
  assert.deepEqual(final.result.demSource, { provider: 'copernicus-glo30', dataset: 'Copernicus DEM GLO-30 Public (DSM)', cacheHit: false, tileCount: 1 });
  assert.equal(final.result.dimensions.x, 126); assert.equal(final.result.dimensions.y, 86);
  assert.ok((await f.manager.preview(job.id)).mesh.faceKinds.includes('route'));
  assert.equal((await f.manager.artifact(job.id)).stlSha256, final.result.stlSha256);
});

test('automatic worker refuses a core footprint that differs from the frozen manager selection', async t => {
  const workers = [];
  const f = await fixture(t, { timeout: 30000, coreOverride: () => `
    export async function generatePrintableTerrain(request) { return request.loadDem({west: 0, south: 0, east: 1, north: 1}, {}); }
    import { loadLocalDem } from ${JSON.stringify(coreModuleUrl)};
    export async function loadCopernicusDem() { return loadLocalDem(${JSON.stringify(join(project, 'data/copernicus-longquanshan.tif'))}); }
  `, factory: ({ workerPath }) => {
    const worker = fork(workerPath, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
    return { on: (...args) => worker.on(...args), once: (...args) => worker.once(...args),
      postMessage: value => worker.send(value), kill: () => worker.kill() };
  } });
  t.after(() => { workers.forEach(worker => { if (worker.exitCode === null) worker.kill(); }); });
  const job = await f.manager.start({ routeId: f.route.id, options: {} });
  await waitFor(() => f.manager.get(job.id).state === 'failed');
  assert.equal(f.manager.get(job.id).error.code, 'DEM_REQUEST_INVALID');
  assert.match(f.manager.get(job.id).error.message, /取景校验失败/);
  assert.deepEqual(await readdir(join(f.root, 'tasks')), []);
});


test('manager timing starts at acceptance, leaves the initial estimate fixed, and freezes only after verified worker exit', async t => {
  let tick = 100, wall = Date.parse('2026-10-13T00:00:00.000Z');
  const f = await fixture(t, { manualExit: true, timingOptions: { monotonicNow: () => tick, clock: () => new Date(wall), softwareVersion: 'timing-test' } });
  const job = await f.start({}), child = f.children[0];
  assert.ok(job.timing, 'authoritative job timing is missing'); const initial = structuredClone(job.timing);
  assert.equal(job.timing.elapsedMs, 0); assert.equal(job.createdAt, '2026-10-13T00:00:00.000Z');
  tick = 2100; wall -= 3600000; child.send({ type: 'progress', phase: 'acquire', progress: .2, message: '获取中' });
  assert.equal(f.manager.get(job.id).timing.elapsedMs, 2000);
  tick = 5100; child.send({ type: 'progress', phase: 'model', progress: .5, message: '建模中' });
  await writeOutput(child.request.taskDir); tick = 7100; child.send({ type: 'complete' });
  await delay(10); assert.equal(f.manager.get(job.id).timing.totalDurationMs, undefined);
  tick = 10100; child.emit('exit', 0); await waitFor(() => f.manager.get(job.id).state === 'succeeded');
  const final = f.manager.get(job.id).timing;
  assert.equal(final.totalDurationMs, 10000); assert.equal(final.elapsedMs, 10000);
  assert.equal(final.estimatedTotalMs, initial.estimatedTotalMs); assert.deepEqual(final.estimatedRangeMs, initial.estimatedRangeMs);
  assert.equal(final.finishedAt, '2026-10-12T23:00:00.000Z');
  tick = 200100; wall += 7200000; await f.manager.artifact(job.id); await f.manager.preview(job.id);
  assert.deepEqual(f.manager.get(job.id).timing, final);
  const finished = f.events.filter(item => item.state === 'succeeded'); assert.equal(finished.length, 1); assert.deepEqual(finished[0].timing, final);
});

test('failed, cancelled, corrupt-output, and startup-failed tasks retain duration without learning success samples', async t => {
  let tick = 0; const f = await fixture(t, { manualExit: true, timingOptions: { monotonicNow: () => tick, clock: () => new Date(0), softwareVersion: 'timing-test' } });
  for (const outcome of ['cancelled', 'failure', 'corrupt']) {
    const job = await f.start({}), child = f.children.at(-1); assert.ok(job.timing, 'failure timing is missing');
    tick += 5000;
    if (outcome === 'cancelled') f.manager.cancel(job.id);
    else if (outcome === 'failure') child.send({ type: 'failure', error: { code: 'DEM_FETCH_FAILED', message: '高程读取失败' } });
    else { await writeOutput(child.request.taskDir, { corrupt: true }); child.send({ type: 'complete' }); }
    child.emit('exit', 0); await waitFor(() => ['failed', 'cancelled'].includes(f.manager.get(job.id).state));
    assert.equal(f.manager.get(job.id).timing.totalDurationMs, 5000);
  }
  await f.manager.close();
  await assert.rejects(readFile(join(f.root, 'timing-v1.json')), { code: 'ENOENT' });
  const failed = await fixture(t, { factory: () => { tick += 2000; throw new Error('cannot spawn'); }, timingOptions: { monotonicNow: () => tick, clock: () => new Date(0) } });
  const startup = await failed.start({}); assert.equal(startup.state, 'failed'); assert.equal(startup.timing.totalDurationMs, 2000);
});

test('unreadable timing history never prevents successful modeling, preview, cancellation, or close', async t => {
  const f = await fixture(t); const blocked = join(f.root, 'blocked'); await writeFile(blocked, 'keep');
  // A real unavailable destination exercises storage failure, without replacing model or file validation.
  const manager = createDesktopManager({ taskRoot: join(f.root, 'other-tasks'), coreModuleUrl,
    timingHistoryPath: join(blocked, 'timing.json'), workerFactory: () => { const child = new FakeWorker(false); f.children.push(child); return child; } });
  t.after(() => manager.close());
  const route = await manager.addRoute(f.routePath), dem = await manager.addDem(f.demPath);
  const job = await manager.start({ routeId: route.id, demId: dem.id, imageMode: 'none', options: {} });
  assert.ok(job.timing, 'storage fallback timing is missing'); assert.equal(job.timing.confidence, 'uncalibrated');
  const child = f.children.at(-1); await writeOutput(child.request.taskDir); child.send({ type: 'complete' }); child.emit('exit', 0);
  await waitFor(() => manager.get(job.id).state === 'succeeded'); assert.ok((await manager.preview(job.id)).mesh); assert.ok(manager.get(job.id).timing.totalDurationMs >= 0);
  const second = await manager.start({ routeId: route.id, demId: dem.id, imageMode: 'none', options: {} }); manager.cancel(second.id);
  await waitFor(() => manager.get(second.id).state === 'cancelled'); await manager.close(); assert.equal(await readFile(blocked, 'utf8'), 'keep');
});


test('a preparation timeout during the offline cache probe remains a timed failure rather than cancellation', async t => {
  const f = await fixture(t, { timingOptions: { phaseTimeoutMs: { prepare: 15 } }, coreOverride: () => `
    export async function loadCopernicusDem(bounds, {signal}) {
      await new Promise(done => signal.addEventListener('abort', done, {once:true}));
      throw Object.assign(new Error('probe aborted'), {code:'DEM_CACHE_MISS'});
    }` });
  const job = await f.manager.start({ routeId: f.route.id, demMode: 'auto', imageMode: 'none', options: {} });
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'JOB_TIMEOUT'); assert.ok(job.timing.totalDurationMs >= 0);
  assert.equal(f.children.length, 0);
});
