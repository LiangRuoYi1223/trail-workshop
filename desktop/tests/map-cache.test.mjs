import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, rename, symlink, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createMapCache, parseMapTileUrl, clearOwnedCacheDirectory, cacheDirectoryBytes } from '../main/map-cache.mjs';

const parent = resolve('artifacts', 'desktop-map-cache-tests');
await mkdir(parent, { recursive: true });
async function fixture(t) {
  const root = await mkdtemp(join(parent, 'case-'));
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  return { root, cacheDir: join(root, 'map-tiles') };
}
const png = Buffer.alloc(32);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(256,16); png.writeUInt32BE(256,20);
const response = (headers = {}) => new Response(png, { headers: { 'content-type': 'image/png', ...headers } });
async function directoryLink(t, target, path) {
  try { await symlink(target, path, 'junction'); return true; }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('Current sandbox does not permit directory junction creation'); return false;
  }
}

test('fixed map URL restricts origin, path and tile coordinates', () => {
  assert.equal(parseMapTileUrl('terrain-map://tiles/5/10/20.png').remoteUrl, 'https://tile.openstreetmap.org/5/10/20.png');
  for (const bad of ['terrain-map://other/1/0/0.png', 'https://tiles/1/0/0.png', 'terrain-map://tiles/19/0/0.png', 'terrain-map://tiles/1/2/0.png', 'terrain-map://tiles/1/0/0.png?url=foo']) assert.throws(() => parseMapTileUrl(bad));
});
test('map requests identify the app and reuse verified cache for at least seven days', async t => {
  const { cacheDir } = await fixture(t); let calls = 0;
  const cache = createMapCache({ cacheDir, fetchImpl: async (_url, opts) => { calls++; assert.match(opts.headers['User-Agent'], /^TerrainWorkshop\//); assert.equal(opts.headers['Cache-Control'], undefined); return response(); } });
  const url = 'terrain-map://tiles/1/1/1.png';
  assert.deepEqual(await cache.get(url), png); assert.deepEqual(await cache.get(url), png); assert.equal(calls, 1);
  assert.ok(await cacheDirectoryBytes(cacheDir) > 32);
});
test('expired tile is conditionally revalidated using the origin ETag', async t => {
  const { cacheDir } = await fixture(t); let time = 1000, calls = 0;
  const cache = createMapCache({ cacheDir, now: () => time, fetchImpl: async (_url, opts) => {
    calls++; if (calls === 1) return response({ etag: 'sample', 'cache-control': 'max-age=1' });
    assert.equal(opts.headers['If-None-Match'], 'sample'); return new Response(null, { status: 304, headers: { 'cache-control': 'max-age=100' } });
  } });
  const url = 'terrain-map://tiles/1/1/1.png'; await cache.get(url); time = 3000;
  assert.deepEqual(await cache.get(url), png); await cache.get(url); assert.equal(calls, 2);
});
test('simultaneous tile reads share one download and HTML error pages are rejected', async t => {
  const { cacheDir } = await fixture(t); let calls = 0;
  const cache = createMapCache({ cacheDir, fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return response(); } });
  await Promise.all([cache.get('terrain-map://tiles/1/1/1.png'), cache.get('terrain-map://tiles/1/1/1.png')]); assert.equal(calls, 1);
  const bad = createMapCache({ cacheDir, fetchImpl: async () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(bad.get('terrain-map://tiles/2/1/1.png'));
});
test('corrupt cached bytes are replaced and user cache clearing stays inside named directories', async t => {
  const { root, cacheDir } = await fixture(t); const cache = createMapCache({ cacheDir, fetchImpl: async () => response() });
  const url = 'terrain-map://tiles/1/1/1.png'; await cache.get(url); await writeFile(join(cacheDir,'1-1-1.png'),'bad');
  assert.deepEqual(await cache.get(url), png); await writeFile(join(root,'keep.txt'),'user file');
  await assert.rejects(clearOwnedCacheDirectory(root, '..'));
  await cache.clear(); assert.equal(await cacheDirectoryBytes(cacheDir),0); assert.equal(await readFile(join(root,'keep.txt'),'utf8'),'user file');
});

test('surface cache bytes are counted and clearing removes imagery without touching saved project or other sources', async t => {
  const { root } = await fixture(t), surface = join(root, 'surface-cache'), crop = join(surface, 'crop-1');
  await Promise.all([mkdir(crop, { recursive: true }), mkdir(join(root, 'elevation-cache')), mkdir(join(root, 'map-tiles'))]);
  await Promise.all([writeFile(join(crop, 'rgb.bin'), Buffer.alloc(17)), writeFile(join(crop, 'metadata.json'), Buffer.alloc(31)),
    writeFile(join(root, 'session-v1.json'), 'saved project'), writeFile(join(root, 'imported-image.tif'), 'user source'),
    writeFile(join(root, 'elevation-cache/dem.bin'), Buffer.alloc(5)), writeFile(join(root, 'map-tiles/tile.png'), Buffer.alloc(7))]);
  const info = async () => ({ imageBytes: await cacheDirectoryBytes(surface),
    elevationBytes: await cacheDirectoryBytes(join(root, 'elevation-cache')), mapBytes: await cacheDirectoryBytes(join(root, 'map-tiles')) });
  assert.deepEqual(await info(), { imageBytes: 48, elevationBytes: 5, mapBytes: 7 });
  await clearOwnedCacheDirectory(root, 'surface-cache');
  assert.deepEqual(await info(), { imageBytes: 0, elevationBytes: 5, mapBytes: 7 });
  assert.deepEqual(await readdir(surface), []);
  assert.equal(await readFile(join(root, 'session-v1.json'), 'utf8'), 'saved project');
  assert.equal(await readFile(join(root, 'imported-image.tif'), 'utf8'), 'user source');
  for (const name of ['surface-cache/../', '../surface-cache', 'surface-cache-copy', 'session-v1.json']) {
    await assert.rejects(clearOwnedCacheDirectory(root, name), { code: 'CACHE_PATH_INVALID' });
  }
});

test('redirected cache directory cannot be read, written, counted or cleared', async t => {
  const { root, cacheDir } = await fixture(t);
  const outside = join(root, 'outside-cache'); await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'user file');
  if (!await directoryLink(t, outside, cacheDir)) return;
  let calls = 0;
  const cache = createMapCache({ cacheDir, fetchImpl: async () => { calls++; return response(); } });
  await assert.rejects(cache.get('terrain-map://tiles/1/1/1.png'), { code: 'CACHE_PATH_INVALID' });
  await assert.rejects(cacheDirectoryBytes(cacheDir), { code: 'CACHE_PATH_INVALID' });
  await assert.rejects(cache.clear(), { code: 'CACHE_PATH_INVALID' });
  assert.equal(calls, 0); assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'user file');
});

test('a junction in the parent chain is rejected even when the final cache folder is missing', async t => {
  const { root } = await fixture(t);
  const actual = join(root, 'actual-user-data'), alias = join(root, 'aliased-user-data');
  await mkdir(actual); await writeFile(join(actual, 'keep.txt'), 'user file');
  if (!await directoryLink(t, actual, alias)) return;
  const cacheDir = join(alias, 'map-tiles'); let calls = 0;
  const cache = createMapCache({ cacheDir, fetchImpl: async () => { calls++; return response(); } });
  await assert.rejects(cache.get('terrain-map://tiles/1/1/1.png'), { code: 'CACHE_PATH_INVALID' });
  await assert.rejects(clearOwnedCacheDirectory(alias, 'elevation-cache'), { code: 'CACHE_PATH_INVALID' });
  assert.equal(calls, 0); assert.deepEqual(await readdir(actual), ['keep.txt']);
});

test('replacement of the directory during a download prevents publication into the redirected folder', async t => {
  const { root, cacheDir } = await fixture(t);
  const moved = join(root, 'original-cache'), outside = join(root, 'outside-cache');
  await mkdir(cacheDir); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'user file');
  const probe = join(root, 'junction-probe');
  if (!await directoryLink(t, outside, probe)) return;
  await unlink(probe);
  const cache = createMapCache({ cacheDir, fetchImpl: async () => {
    await rename(cacheDir, moved); await symlink(outside, cacheDir, 'junction');
    return response();
  } });
  await assert.rejects(cache.get('terrain-map://tiles/1/1/1.png'), { code: 'CACHE_PATH_INVALID' });
  assert.deepEqual(await readdir(outside), ['keep.txt']); assert.deepEqual(await readdir(moved), []);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'user file');
});

test('closing aborts downloads and drains queued requests without reopening the cache', async t => {
  const { cacheDir } = await fixture(t); let started = 0;
  let allActive; const fourActive = new Promise(resolve => { allActive = resolve; });
  const cache = createMapCache({ cacheDir, fetchImpl: async (_url, options) => {
    if (++started === 4) allActive();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  } });
  const pending = Array.from({ length: 8 }, (_, index) => cache.get(`terrain-map://tiles/4/${index}/1.png`));
  const settled = Promise.allSettled(pending);
  await fourActive; await cache.close();
  assert.equal(started, 4); assert.ok((await settled).every(value => value.status === 'rejected'));
  await assert.rejects(cache.get('terrain-map://tiles/1/1/1.png'), { code: 'CACHE_BUSY' });
  await assert.rejects(cache.clear(), { code: 'APP_CLOSED' });
});

test('finishing an overlapping cache clear cannot undo permanent shutdown', async t => {
  const { cacheDir } = await fixture(t);
  const cache = createMapCache({ cacheDir, fetchImpl: async () => response() });
  await cache.get('terrain-map://tiles/1/1/1.png');
  await Promise.all([cache.clear(), cache.close()]);
  assert.equal(await cacheDirectoryBytes(cacheDir), 0);
  await assert.rejects(cache.get('terrain-map://tiles/1/1/1.png'), { code: 'CACHE_BUSY' });
});
