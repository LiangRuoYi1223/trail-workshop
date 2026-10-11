import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { validateOptions } from '../main/files.mjs';
import { createDesktopManager } from '../main/manager.mjs';
import { createSessionStore } from '../main/session.mjs';
import { appearanceColor, geometryOptions, printPaletteCount } from '../renderer/route-color.ts';

const project = resolve(import.meta.dirname, '../..');
const parent = join(project, 'artifacts', 'desktop-snow-settings-tests');
const coreModuleUrl = pathToFileURL(join(project, 'dist/src/index.js')).href;
const snowOptions = { maxColors: 4, snowEnabled: true, snowCoveragePercent: 42.5, snowMaxThicknessMm: 2.6 };

async function fixture(t) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')), data = join(root, 'profile');
  const routePath = join(root, '雪山路线.gpx'), sessionPath = join(data, 'session-v1.json');
  await writeFile(routePath, '<gpx><trk><name>雪山路线</name><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>');
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
  const request = { routeId: route.id, demMode: 'auto', imageMode: 'none', offlineOnly: false, options: snowOptions };
  return { ...first, request, fresh, sessionPath, workerCount: () => workers };
}

test('missing snow fields default to disabled snow without replacing an existing two-color choice', () => {
  const options = validateOptions({ maxColors: 2, widthMm: 150 });
  assert.equal(options.snowEnabled, false);
  assert.equal(options.snowCoveragePercent, 30);
  assert.equal(options.snowMaxThicknessMm, 1);
  assert.equal(options.maxColors, 2);
  assert.equal(options.widthMm, 150);
});

test('four-color snow accepts the boundary coverage and finished-model thickness values', () => {
  for (const [coverage, thickness] of [[0, .1], [30, 1], [100, 10]]) {
    const options = validateOptions({ maxColors: 4, snowEnabled: true, snowCoveragePercent: coverage, snowMaxThicknessMm: thickness });
    assert.equal(options.snowEnabled, true);
    assert.equal(options.snowCoveragePercent, coverage);
    assert.equal(options.snowMaxThicknessMm, thickness);
    assert.equal(options.maxColors, 4);
  }
  assert.equal(validateOptions({ maxColors: 4, snowEnabled: false }).maxColors, 4);
});

test('snow settings reject wrong types, non-finite values and values outside the supported ranges', () => {
  for (const patch of [
    { snowEnabled: 'true' }, { snowEnabled: 1 }, { snowEnabled: null },
    { snowCoveragePercent: -.1 }, { snowCoveragePercent: 100.1 }, { snowCoveragePercent: NaN }, { snowCoveragePercent: Infinity }, { snowCoveragePercent: '30' },
    { snowMaxThicknessMm: 0 }, { snowMaxThicknessMm: .09 }, { snowMaxThicknessMm: 10.1 }, { snowMaxThicknessMm: NaN }, { snowMaxThicknessMm: '1' },
  ]) assert.throws(() => validateOptions({ ...snowOptions, ...patch }), { code: 'CONFIG_INVALID' });
});

test('snow cannot be enabled under the legacy two-color or three-color budget', () => {
  for (const maxColors of [2, 3]) assert.throws(() => validateOptions({ ...snowOptions, maxColors }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateOptions({ ...snowOptions, maxColors: 5 }), { code: 'CONFIG_INVALID' });
});

test('snow changes invalidate generated geometry while four-color recoloring preserves it', () => {
  const options = { ...snowOptions, routeColor: '#c84832', grassColor: '#799278', rockColor: '#a9aa92' };
  assert.deepEqual(geometryOptions(options), { snowEnabled: true, snowCoveragePercent: 42.5, snowMaxThicknessMm: 2.6 });
  for (const patch of [{ snowEnabled: false }, { snowCoveragePercent: 60 }, { snowMaxThicknessMm: 4 }]) {
    assert.notDeepEqual(geometryOptions({ ...options, ...patch }), geometryOptions(options));
  }
  assert.deepEqual(geometryOptions({ ...options, routeColor: '#0000ff', grassColor: '#227733', rockColor: '#999999' }), geometryOptions(options));
});

test('snow previews remain white and actual RGB duplicates reduce the displayed material count', () => {
  const colors = { maxColors: 4, grassColor: '#227733', rockColor: '#999999', routeColor: '#dd2233' };
  assert.equal(appearanceColor('snow', colors), '#ffffff');
  assert.equal(appearanceColor('snow', { ...colors, routeColor: '#123456', grassColor: '#ffffff' }), '#ffffff');
  assert.equal(printPaletteCount(['grass', 'rock', 'snow', 'route'], colors), 4);
  assert.equal(printPaletteCount(['grass', 'rock', 'snow', 'route'], { ...colors, routeColor: '#ffffff' }), 3);
  assert.equal(printPaletteCount(['grass', 'rock', 'route'], colors), 3);
});

test('snow options persist in preferences and the recent project then restore without computing', async t => {
  const f = await fixture(t);
  await f.store.saveSession(f.request); await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const options of [stored.preferences.options, stored.recentProject.options]) {
    assert.equal(options.snowEnabled, true); assert.equal(options.snowCoveragePercent, 42.5);
    assert.equal(options.snowMaxThicknessMm, 2.6); assert.equal(options.maxColors, 4);
  }
  const next = f.fresh(), startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const options of [startup.preferences.options, restored.options]) {
    assert.equal(options.snowEnabled, true); assert.equal(options.snowCoveragePercent, 42.5);
    assert.equal(options.snowMaxThicknessMm, 2.6); assert.equal(options.maxColors, 4);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []); assert.equal(f.workerCount(), 0);
});

for (const maxColors of [2, 3]) test(`old ${maxColors}-color projects gain disabled snow defaults and keep their color choice`, async t => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.request, options: { widthMm: 150, maxColors } }); await f.store.close();
  const stored = JSON.parse(await readFile(f.sessionPath, 'utf8'));
  for (const options of [stored.preferences.options, stored.recentProject.options]) {
    delete options.snowEnabled; delete options.snowCoveragePercent; delete options.snowMaxThicknessMm;
  }
  await writeFile(f.sessionPath, JSON.stringify(stored));
  const before = await readFile(f.sessionPath), next = f.fresh();
  const startup = await next.store.getSession(), restored = await next.store.restoreSession();
  for (const options of [startup.preferences.options, restored.options]) {
    assert.equal(options.snowEnabled, false); assert.equal(options.snowCoveragePercent, 30);
    assert.equal(options.snowMaxThicknessMm, 1); assert.equal(options.maxColors, maxColors); assert.equal(options.widthMm, 150);
  }
  assert.ok(restored.route); assert.deepEqual(restored.warnings, []);
  assert.deepEqual(await readFile(f.sessionPath), before); assert.equal(f.workerCount(), 0);
});

test('invalid snow edits leave the previous saved project intact', async t => {
  const f = await fixture(t); await f.store.saveSession(f.request);
  const before = await readFile(f.sessionPath);
  for (const patch of [{ maxColors: 3 }, { snowCoveragePercent: 101 }, { snowMaxThicknessMm: 0 }, { snowEnabled: 'true' }]) {
    await assert.rejects(f.store.saveSession({ ...f.request, options: { ...snowOptions, ...patch } }), { code: 'CONFIG_INVALID' });
  }
  assert.deepEqual(await readFile(f.sessionPath), before);
});
