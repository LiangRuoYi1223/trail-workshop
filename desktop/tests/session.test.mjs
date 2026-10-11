import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';

const project = resolve(import.meta.dirname, '../..'), parent = join(project, 'artifacts', 'desktop-session-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const gpx = '<gpx><trk><name>恢复测试山路</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>';
const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>恢复测试山路</name><Placemark><LineString><coordinates>104.28,30.56,100 104.30,30.57,120</coordinates></LineString></Placemark></Document></kml>';
const options = { widthMm: 130, heightMm: 90, bearingDeg: 26, gridColumns: 65, center: { lat: 30.565, lon: 104.29 }, groundWidthM: 3500 };
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { routeXml = gpx, routeFileName = '中文 路线.gpx' } = {}) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')), data = join(root, 'profile'), routePath = join(root, routeFileName), demPath = join(root, '地形.tif');
  await Promise.all([mkdir(data), writeFile(routePath, routeXml), copyFile(join(project, 'data/copernicus-longquanshan.tif'), demPath)]);
  const managers = [], stores = []; let workers = 0;
  const fresh = () => {
    const manager = createDesktopManager({ taskRoot: join(root, `tasks-${managers.length}`), coreModuleUrl, demCacheDir: join(data, 'elevation-cache'),
      workerFactory: () => { workers++; throw new Error('Restoring must never create a generation worker'); } });
    const store = createSessionStore({ userDataDirectory: data, manager });
    managers.push(manager); stores.push(store); return { manager, store };
  };
  t.after(async () => {
    await Promise.all(stores.map(store => store.close())); await Promise.all(managers.map(manager => manager.close()));
    assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith('case-'));
    await rm(root, { recursive: true, force: true });
  });
  const first = fresh(), route = await first.manager.addRoute(routePath), dem = await first.manager.addDem(demPath);
  const request = { routeId: route.id, demId: dem.id, demMode: 'local', offlineOnly: true, options };
  return { root, data, routePath, demPath, sessionPath: join(data, 'session-v1.json'), ...first, fresh, route, dem, request, workerCount: () => workers };
}

test('restart restores validated project with new opaque ids and geography only after explicit request', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); await f.store.close();
  const next = f.fresh(), startup = await next.store.getSession();
  assert.equal(startup.preferences.options.widthMm, 130); assert.equal(startup.preferences.options.center, undefined);
  assert.equal(startup.preferences.options.groundWidthM, undefined); assert.equal(startup.preferences.offlineOnly, true);
  assert.equal(startup.recentProject.routeFileName, '中文 路线.gpx'); assert.equal(startup.recentProject.demFileName, '地形.tif');
  assert.equal(f.workerCount(), 0); assert.ok(!JSON.stringify(startup).includes(f.root));
  const restored = await next.store.restoreSession();
  assert.equal(restored.route.name, '恢复测试山路'); assert.notEqual(restored.route.id, f.route.id); assert.notEqual(restored.dem.id, f.dem.id);
  assert.deepEqual(restored.options.center, options.center); assert.equal(restored.options.groundWidthM, 3500);
  assert.equal(restored.demMode, 'local'); assert.deepEqual(restored.warnings, []); assert.equal(f.workerCount(), 0);
  assert.ok(!JSON.stringify(restored).includes(f.root));
  const inspection = await next.manager.inspect({ routeId: restored.route.id, options: restored.options });
  assert.equal(inspection.selection.groundWidthM, 3500); assert.equal(inspection.selection.bearingDeg, 26);
});

test('existing schema-v1 KML project is offered without rewriting its saved record', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); await f.store.close();
  const path = join(f.root, '中文 路线.KML'); await writeFile(path, kml);
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  stored.recentProject.route = { ...stored.recentProject.route, path, fileName: '中文 路线.KML',
    bytes: Buffer.byteLength(kml), sha256: sha(kml) };
  await writeFile(f.sessionPath, JSON.stringify(stored));
  const before = await readFile(f.sessionPath), startup = await f.fresh().store.getSession();
  assert.equal(startup.schemaVersion, 1); assert.equal(startup.recentProject?.routeFileName, '中文 路线.KML');
  assert.deepEqual(startup.warnings, []); assert.ok(!JSON.stringify(startup).includes(f.root));
  assert.deepEqual(await readFile(f.sessionPath), before); assert.equal(f.workerCount(), 0);
});

test('KML save, reopen and explicit restoration retain options, file checks and opaque route ids', async t => {
  const f = await fixture(t, { routeXml: kml, routeFileName: '中文 路线.KML' });
  const routeBefore = await readFile(f.routePath), demBefore = await readFile(f.demPath);
  await f.store.saveSession(f.request); await f.store.close();
  const sessionBefore = await readFile(f.sessionPath), stored = JSON.parse(sessionBefore.toString('utf8'));
  assert.equal(stored.schemaVersion, 1); assert.equal(stored.recentProject.route.sha256, sha(routeBefore));
  const next = f.fresh(), startup = await next.store.getSession();
  assert.equal(startup.recentProject.routeFileName, '中文 路线.KML'); assert.equal(startup.preferences.options.center, undefined);
  const restored = await next.store.restoreSession();
  assert.equal(restored.route.name, '恢复测试山路'); assert.equal(restored.route.fileName, '中文 路线.KML');
  assert.notEqual(restored.route.id, f.route.id); assert.notEqual(restored.dem.id, f.dem.id);
  assert.deepEqual(restored.options.center, options.center); assert.equal(restored.options.groundWidthM, 3500);
  assert.equal(restored.demMode, 'local'); assert.deepEqual(restored.warnings, []); assert.equal(f.workerCount(), 0);
  assert.ok(!JSON.stringify(restored).includes(f.root));
  const inspection = await next.manager.inspect({ routeId: restored.route.id, options: restored.options });
  assert.equal(inspection.selection.groundWidthM, 3500); assert.equal(inspection.selection.bearingDeg, 26);
  assert.deepEqual(await readFile(f.routePath), routeBefore); assert.deepEqual(await readFile(f.demPath), demBefore);
  assert.deepEqual(await readFile(f.sessionPath), sessionBefore);
});

for (const change of ['missing', 'modified']) {
  test(`${change} KML keeps saved metadata and preferences while refusing to restore its DEM project`, async t => {
    const f = await fixture(t, { routeXml: kml, routeFileName: '中文 路线.kml' });
    await f.store.saveSession(f.request);
    const sessionBefore = await readFile(f.sessionPath), changed = kml.replace('104.28', '105.28');
    if (change === 'missing') await unlink(f.routePath); else await writeFile(f.routePath, changed);
    const restored = await f.fresh().store.restoreSession();
    assert.equal(restored.route, undefined); assert.equal(restored.dem, undefined);
    assert.equal(restored.options.widthMm, 130); assert.equal(restored.options.center, undefined);
    assert.ok(restored.warnings.some(item => item.includes('路线无法恢复')));
    if (change === 'modified') {
      assert.ok(restored.warnings.some(item => item.includes('文件已改变')));
      assert.equal(await readFile(f.routePath, 'utf8'), changed);
    }
    assert.deepEqual(await readFile(f.sessionPath), sessionBefore); assert.equal(f.workerCount(), 0);
  });
}

test('legacy KML sample project stays suppressed while keeping its usable preferences', async t => {
  const f = await fixture(t, { routeXml: kml, routeFileName: '旧示例.kml' });
  const sample = await f.manager.addRoute(f.routePath, { isSample: true });
  await f.store.saveSession({ ...f.request, routeId: sample.id }); await f.store.close();
  const before = await readFile(f.sessionPath), next = f.fresh(), startup = await next.store.getSession();
  assert.equal(startup.recentProject, undefined); assert.equal(startup.preferences.options.widthMm, 130);
  assert.ok(startup.warnings.some(item => item.includes('示例')));
  const restored = await next.store.restoreSession();
  assert.equal(restored.route, undefined); assert.equal(restored.dem, undefined);
  assert.equal(restored.options.widthMm, 130); assert.equal(restored.options.center, undefined);
  assert.deepEqual(await readFile(f.sessionPath), before); assert.equal(f.workerCount(), 0);
});

test('default startup is usable and recovery never starts computation', async t => {
  const f = await fixture(t), startup = await f.store.getSession();
  assert.equal(startup.preferences.options.widthMm, 120); assert.equal(startup.recentProject, undefined);
  const restored = await f.store.restoreSession(); assert.equal(restored.route, undefined); assert.ok(restored.warnings.some(item => item.includes('没有可恢复')));
  assert.equal(f.workerCount(), 0);
});

test('route color, width and height survive restart and explicit project restoration', async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, options: { ...options, routeColor: '#12ABF0', routeWidthMm: 2.4, routeHeightMm: 3.5 } });
  await f.store.close();
  const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const settings of [startup.preferences.options, restored.options]) {
    assert.equal(settings.routeColor, '#12abf0');
    assert.equal(settings.routeWidthMm, 2.4);
    assert.equal(settings.routeHeightMm, 3.5);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []); assert.equal(f.workerCount(), 0);
});

test('legacy sessions missing route appearance fields restore the existing red one-millimeter relief', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const settings of [stored.preferences.options, stored.recentProject.options]) {
    delete settings.routeColor; delete settings.routeHeightMm;
  }
  await writeFile(f.sessionPath, JSON.stringify(stored));
  const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const settings of [startup.preferences.options, restored.options]) {
    assert.equal(settings.routeColor, '#c84832'); assert.equal(settings.routeHeightMm, 1);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []);
});

for (const [sampleSource, demMode] of [['route', 'local'], ['dem', 'local'], ['dem', 'auto']]) {
  test(`legacy sample ${sampleSource} in ${demMode} mode is not offered or read during project recovery`, async t => {
    const f = await fixture(t);
    await f.store.saveSession({ ...f.request, options: { ...options, routeColor: '#12abf0', routeWidthMm: 2.4, routeHeightMm: 3.5 } });
    await f.store.close();
    const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
    stored.recentProject[sampleSource].isSample = true;
    stored.recentProject.demMode = demMode;
    await writeFile(f.sessionPath, JSON.stringify(stored));
    const persisted = await readFile(f.sessionPath);
    const next = f.fresh();
    let routeReads = 0, demReads = 0;
    const addRoute = next.manager.addRoute, addDem = next.manager.addDem;
    next.manager.addRoute = (...args) => { routeReads++; return addRoute(...args); };
    next.manager.addDem = (...args) => { demReads++; return addDem(...args); };
    const startup = await next.store.getSession();
    assert.equal(startup.recentProject, undefined);
    assert.ok(startup.warnings.some(item => item.includes('示例') && item.includes('GPX')));
    const restored = await next.store.restoreSession();
    assert.equal(restored.route, undefined); assert.equal(restored.dem, undefined);
    for (const settings of [startup.preferences.options, restored.options]) {
      assert.equal(settings.widthMm, 130); assert.equal(settings.heightMm, 90); assert.equal(settings.bearingDeg, 26);
      assert.equal(settings.routeColor, '#12abf0'); assert.equal(settings.routeWidthMm, 2.4); assert.equal(settings.routeHeightMm, 3.5);
      assert.equal(settings.center, undefined); assert.equal(settings.groundWidthM, undefined);
    }
    assert.equal(restored.demMode, 'local'); assert.equal(restored.offlineOnly, true);
    assert.equal(routeReads, 0); assert.equal(demReads, 0); assert.equal(f.workerCount(), 0);
    assert.deepEqual(await readFile(f.sessionPath), persisted, 'recovery must not rewrite a legacy project implicitly');
    await next.store.saveSession({ demMode: 'auto', offlineOnly: false, options: { widthMm: 160 } });
    assert.equal(JSON.parse(await readFile(f.sessionPath, 'utf8')).recentProject, undefined);
    assert.equal((await f.fresh().store.getSession()).recentProject, undefined);
  });
}

test('invalid route color or height never replaces the last saved project', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); const before = await readFile(f.sessionPath);
  for (const patch of [{ routeColor: '#ff' }, { routeColor: 'rgb(10,20,30)' }, { routeHeightMm: 0 }, { routeHeightMm: 10.1 }]) {
    await assert.rejects(f.store.saveSession({ ...f.request, options: { ...options, ...patch } }), { code: 'CONFIG_INVALID' });
  }
  assert.deepEqual(await readFile(f.sessionPath), before);
});

test('preference-only saves preserve the last imported project without applying its geography', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  await f.store.saveSession({ demMode: 'auto', offlineOnly: false, options: { widthMm: 200, center: { lat: 40, lon: 110 }, groundWidthM: 20000 } });
  const startup = await f.fresh().store.getSession(); assert.equal(startup.preferences.options.widthMm, 200);
  assert.equal(startup.preferences.options.center, undefined); assert.equal(startup.recentProject.routeName, '恢复测试山路');
  const restored = await f.fresh().store.restoreSession(); assert.equal(restored.options.widthMm, 130); assert.equal(restored.options.groundWidthM, 3500);
});

test('concurrent saves snapshot their requests, retain order and finish before close returns', async t => {
  const f = await fixture(t), first = { ...f.request, options: { ...options, center: { ...options.center }, widthMm: 140 } };
  const firstSave = f.store.saveSession(first); first.options.widthMm = 499; first.options.center.lon = 150;
  const secondSave = f.store.saveSession({ ...f.request, options: { ...options, widthMm: 180 } });
  const closing = f.store.close(); const a = await firstSave, b = await secondSave; await closing;
  assert.equal(a.preferences.options.widthMm, 140); assert.equal(b.preferences.options.widthMm, 180);
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  assert.equal(stored.preferences.options.widthMm, 180); assert.equal(stored.recentProject.options.center.lon, 104.29);
  assert.deepEqual(await readdir(f.data), ['session-v1.json']);
  await assert.rejects(f.store.saveSession(f.request), { code: 'APP_CLOSED' });
});

test('untrusted ids, renderer paths and invalid options cannot replace a valid saved project', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); const before = await readFile(f.sessionPath);
  for (const patch of [{ routeId: 'unknown-route' }, { demId: 'unknown-dem' }, { routeId: f.routePath }, { routePath: f.routePath },
    { demMode: 'remote' }, { offlineOnly: 'true' }, { options: { widthMm: Infinity } }, { options: { center: { lat: 100, lon: 0 } } },
    { options: { arbitraryPath: f.root } }]) await assert.rejects(f.store.saveSession({ ...f.request, ...patch }));
  assert.deepEqual(await readFile(f.sessionPath), before); assert.equal(f.workerCount(), 0);
});

test('missing GPX keeps usable preferences and does not restore a misleading DEM project', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); await unlink(f.routePath);
  const next = f.fresh(), restored = await next.store.restoreSession();
  assert.equal(restored.route, undefined); assert.equal(restored.dem, undefined); assert.equal(restored.options.widthMm, 130);
  assert.equal(restored.options.center, undefined); assert.ok(restored.warnings.some(item => item.includes('路线无法恢复')));
  assert.equal(f.workerCount(), 0);
});

test('same-length modified GPX is rejected rather than silently using a different trail', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); await writeFile(f.routePath, gpx.replace('104.28', '105.28'));
  const restored = await f.fresh().store.restoreSession(); assert.equal(restored.route, undefined);
  assert.ok(restored.warnings.some(item => item.includes('文件已改变')));
});

test('a missing or altered local DEM leaves the valid route usable with a clear warning', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  const original = await readFile(f.demPath); await unlink(f.demPath);
  const missing = await f.fresh().store.restoreSession(); assert.ok(missing.route); assert.equal(missing.dem, undefined);
  assert.ok(missing.warnings.some(item => item.includes('高程无法恢复')));
  const changed = Buffer.from(original); changed[100] ^= 255; await writeFile(f.demPath, changed);
  const altered = await f.fresh().store.restoreSession(); assert.ok(altered.route); assert.equal(altered.dem, undefined);
  assert.ok(altered.warnings.some(item => item.includes('文件已改变')));
});

test('saved but invalid GeoTIFF is parsed and rejected during project restoration', async t => {
  const f = await fixture(t); await writeFile(f.demPath, 'invalid TIFF content');
  const invalid = await f.manager.addDem(f.demPath); await f.store.saveSession({ ...f.request, demId: invalid.id });
  const restored = await f.fresh().store.restoreSession(); assert.ok(restored.route); assert.equal(restored.dem, undefined);
  assert.ok(restored.warnings.some(item => item.includes('高程无法恢复'))); assert.equal(f.workerCount(), 0);
});

test('a saved route still undergoes XML and resource-limit validation on restore', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  const broken = '<gpx><trk>'; await writeFile(f.routePath, broken);
  const json = JSON.parse(await readFile(f.sessionPath, 'utf8')); json.recentProject.route.sha256 = sha(broken); json.recentProject.route.bytes = Buffer.byteLength(broken);
  await writeFile(f.sessionPath, JSON.stringify(json));
  const malformed = await f.fresh().store.restoreSession(); assert.equal(malformed.route, undefined); assert.ok(malformed.warnings.some(item => item.includes('路线无法恢复')));
  await writeFile(f.routePath, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  const oversized = await f.fresh().store.restoreSession(); assert.equal(oversized.route, undefined); assert.ok(oversized.warnings.some(item => item.includes('超过 2 MB')));
});

test('corrupt and oversized settings show a warning, remain usable and can be replaced atomically', async t => {
  const f = await fixture(t);
  for (const bytes of ['{broken JSON', Buffer.alloc(65537, 32)]) {
    await writeFile(f.sessionPath, bytes); const next = f.fresh(), startup = await next.store.getSession();
    assert.equal(startup.preferences.options.widthMm, 120); assert.ok(startup.warnings.length > 0);
    await next.store.saveSession({ demMode: 'auto', offlineOnly: false, options: { widthMm: 150 } });
    assert.equal(JSON.parse(await readFile(f.sessionPath, 'utf8')).preferences.options.widthMm, 150);
  }
});

test('invalid recent metadata does not erase valid preferences and incompatible schema is explicit', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request); const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  stored.recentProject.route.path = 'relative.gpx'; await writeFile(f.sessionPath, JSON.stringify(stored));
  const startup = await f.fresh().store.getSession(); assert.equal(startup.preferences.options.widthMm, 130); assert.equal(startup.recentProject, undefined);
  assert.ok(startup.warnings.some(item => item.includes('项目记录无效')));
  stored.schemaVersion = 99; await writeFile(f.sessionPath, JSON.stringify(stored));
  const incompatible = await f.fresh().store.getSession(); assert.equal(incompatible.preferences.options.widthMm, 120);
  assert.ok(incompatible.warnings.some(item => item.includes('版本不兼容')));
});

test('auto mode records no stale local DEM and local mode without a DEM prompts for selection', async t => {
  const f = await fixture(t); await f.store.saveSession({ ...f.request, demMode: 'auto' });
  const auto = await f.fresh().store.restoreSession(); assert.ok(auto.route); assert.equal(auto.dem, undefined); assert.equal(auto.demMode, 'auto'); assert.deepEqual(auto.warnings, []);
  await f.store.saveSession({ ...f.request, demId: undefined });
  const local = await f.fresh().store.restoreSession(); assert.ok(local.route); assert.equal(local.dem, undefined);
  assert.ok(local.warnings.some(item => item.includes('未选择本地高程')));
});

test('a redirected settings directory cannot read, replace or remove unrelated files', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  const moved = join(f.root, 'original-profile'), outside = join(f.root, 'other-files'); await mkdir(outside);
  const sentinel = '{"keep":"user file"}'; await writeFile(join(outside, 'session-v1.json'), sentinel);
  await rename(f.data, moved);
  try { await symlink(outside, f.data, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { await rename(moved, f.data); t.skip('Current sandbox does not permit directory junction creation'); return; } throw error; }
  t.after(() => unlink(f.data).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  await assert.rejects(f.store.saveSession(f.request), { code: 'SESSION_PATH_INVALID' });
  const startup = await f.fresh().store.getSession(); assert.ok(startup.warnings.some(item => item.includes('目录已被替换')));
  assert.equal(await readFile(join(outside, 'session-v1.json'), 'utf8'), sentinel); assert.deepEqual(await readdir(outside), ['session-v1.json']);
});
