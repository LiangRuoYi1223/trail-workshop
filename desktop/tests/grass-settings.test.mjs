import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { validateOptions } from '../main/files.mjs';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';

const project = resolve(import.meta.dirname, '../..');
const parent = join(project, 'artifacts', 'desktop-grass-settings-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;

async function fixture(t) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')), data = join(root, 'profile');
  const routePath = join(root, '草地路线.gpx'), sessionPath = join(data, 'session-v1.json');
  await writeFile(routePath, '<gpx><trk><name>草地路线</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>');
  const managers = [], stores = [];
  let workers = 0;
  const fresh = () => {
    const manager = createDesktopManager({ taskRoot: join(root, `tasks-${managers.length}`), coreModuleUrl,
      workerFactory: () => { workers++; throw new Error('Settings restoration must not generate a model'); } });
    const store = createSessionStore({ userDataDirectory: data, manager });
    managers.push(manager); stores.push(store);
    return { manager, store };
  };
  t.after(async () => {
    await Promise.all(stores.map(store => store.close()));
    await Promise.all(managers.map(manager => manager.close()));
    assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith('case-'));
    await rm(root, { recursive: true, force: true });
  });
  const first = fresh(), route = await first.manager.addRoute(routePath);
  const request = { routeId: route.id, demMode: 'auto', imageMode: 'none', offlineOnly: false, options: { grassSensitivity: 72.5 } };
  return { ...first, request, fresh, sessionPath, workerCount: () => workers };
}

test('missing grass sensitivity keeps the existing classification default', () => {
  const options = validateOptions({ maxColors: 2, widthMm: 150 });
  assert.equal(options.grassSensitivity, 50);
  assert.equal(options.maxColors, 6); assert.equal(options.grassEnabled, true); assert.equal(options.rockEnabled, false); assert.equal(options.widthMm, 150);
});

test('grass sensitivity accepts finite percentage values including both endpoints', () => {
  for (const grassSensitivity of [0, 42.5, 50, 100]) {
    assert.equal(validateOptions({ grassSensitivity }).grassSensitivity, grassSensitivity);
  }
});

test('grass sensitivity rejects invalid types, non-finite values and values outside its range', () => {
  for (const grassSensitivity of [-.1, 100.1, NaN, Infinity, -Infinity, '50', null, false, undefined]) {
    assert.throws(() => validateOptions({ grassSensitivity }), { code: 'CONFIG_INVALID' });
  }
});

test('grass sensitivity survives preferences and recent project restoration without computing', async t => {
  const f = await fixture(t);
  await f.store.saveSession(f.request); await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const options of [stored.preferences.options, stored.recentProject.options]) assert.equal(options.grassSensitivity, 72.5);
  const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const options of [startup.preferences.options, restored.options]) assert.equal(options.grassSensitivity, 72.5);
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []); assert.equal(f.workerCount(), 0);
});

test('old projects missing grass sensitivity gain the default while preserving their settings', async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, options: { maxColors: 2, widthMm: 150 } }); await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const options of [stored.preferences.options, stored.recentProject.options]) delete options.grassSensitivity;
  await writeFile(f.sessionPath, JSON.stringify(stored));
  const before = await readFile(f.sessionPath), next = f.fresh();
  const startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const options of [startup.preferences.options, restored.options]) {
    assert.equal(options.grassSensitivity, 50); assert.equal(options.maxColors, 6); assert.equal(options.grassEnabled, true); assert.equal(options.rockEnabled, false); assert.equal(options.widthMm, 150);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []);
  assert.deepEqual(await readFile(f.sessionPath), before); assert.equal(f.workerCount(), 0);
});

test('invalid grass sensitivity cannot replace the last saved project', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  const before = await readFile(f.sessionPath);
  for (const grassSensitivity of [-1, 101, NaN, Infinity, '50', null]) {
    await assert.rejects(f.store.saveSession({ ...f.request, options: { grassSensitivity } }), { code: 'CONFIG_INVALID' });
  }
  assert.deepEqual(await readFile(f.sessionPath), before);
});

test('missing grass continuity restores the desktop default without changing sensitivity', () => {
  const options = validateOptions({ grassSensitivity: 72.5, maxColors: 2, widthMm: 150 });
  assert.equal(options.grassContinuity, 50);
  assert.equal(options.grassSensitivity, 72.5);
  assert.equal(options.maxColors, 6); assert.equal(options.grassEnabled, true); assert.equal(options.rockEnabled, false); assert.equal(options.widthMm, 150);
});

test('grass continuity accepts finite percentages including disabled and strongest endpoints', () => {
  for (const grassContinuity of [0, 42.5, 50, 100]) {
    assert.equal(validateOptions({ grassContinuity }).grassContinuity, grassContinuity);
  }
});

test('grass continuity rejects invalid types, non-finite values and values outside its range', () => {
  for (const grassContinuity of [-.1, 100.1, NaN, Infinity, -Infinity, '50', null, false, undefined]) {
    assert.throws(() => validateOptions({ grassContinuity }), { code: 'CONFIG_INVALID' });
  }
});

test('grass continuity survives preferences and project restoration independently of sensitivity', async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, options: { grassSensitivity: 72.5, grassContinuity: 0 } });
  await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const options of [stored.preferences.options, stored.recentProject.options]) {
    assert.equal(options.grassSensitivity, 72.5); assert.equal(options.grassContinuity, 0);
  }
  const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const options of [startup.preferences.options, restored.options]) {
    assert.equal(options.grassSensitivity, 72.5); assert.equal(options.grassContinuity, 0);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []); assert.equal(f.workerCount(), 0);
});

test('legacy projects missing grass continuity keep sensitivity and gain the desktop continuity default', async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, options: { grassSensitivity: 72.5, maxColors: 2, widthMm: 150 } });
  await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const options of [stored.preferences.options, stored.recentProject.options]) delete options.grassContinuity;
  await writeFile(f.sessionPath, JSON.stringify(stored));
  const before = await readFile(f.sessionPath), next = f.fresh();
  const startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const options of [startup.preferences.options, restored.options]) {
    assert.equal(options.grassContinuity, 50); assert.equal(options.grassSensitivity, 72.5);
    assert.equal(options.maxColors, 6); assert.equal(options.grassEnabled, true); assert.equal(options.rockEnabled, false); assert.equal(options.widthMm, 150);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []);
  assert.deepEqual(await readFile(f.sessionPath), before); assert.equal(f.workerCount(), 0);
});

test('invalid grass continuity cannot replace either saved setting or project', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  const before = await readFile(f.sessionPath);
  for (const grassContinuity of [-1, 101, NaN, Infinity, '50', null]) {
    await assert.rejects(f.store.saveSession({ ...f.request, options: { grassContinuity } }), { code: 'CONFIG_INVALID' });
  }
  assert.deepEqual(await readFile(f.sessionPath), before);
});
