import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DesktopError } from './files.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_TILE = 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

// realpath detects a junction in any existing ancestor, not only at the leaf.
// Missing directories are created one level at a time after checking their parent.
async function checkedCacheDirectory(path, create = false) {
  const target = resolve(path);
  let entry;
  try { entry = await lstat(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(target);
    if (parent === target) throw new DesktopError('CACHE_PATH_INVALID', '缓存目录根路径无效');
    await checkedCacheDirectory(parent, create);
    if (!create) return false;
    try { await mkdir(target); } catch (creation) { if (creation.code !== 'EEXIST') throw creation; }
    entry = await lstat(target);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await realpath(target), target)) {
    throw new DesktopError('CACHE_PATH_INVALID', '缓存目录已被替换，请检查缓存位置');
  }
  return true;
}

export function parseMapTileUrl(input) {
  const url = new URL(input);
  const match = /^\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/.exec(url.pathname);
  if (url.protocol !== 'terrain-map:' || url.hostname !== 'tiles' || url.port || url.username || url.password || url.search || url.hash || !match) {
    throw new DesktopError('MAP_TILE_INVALID', '底图请求格式无效');
  }
  const [z, x, y] = match.slice(1).map(Number);
  if (z > 18 || x >= 2 ** z || y >= 2 ** z) throw new DesktopError('MAP_TILE_INVALID', '底图范围无效');
  return { z, x, y, key: `${z}-${x}-${y}`, remoteUrl: `https://tile.openstreetmap.org/${z}/${x}/${y}.png` };
}

function validatePng(bytes) {
  if (bytes.length < 24 || bytes.length > MAX_TILE || !bytes.subarray(0, 8).equals(PNG)
    || bytes.readUInt32BE(16) !== 256 || bytes.readUInt32BE(20) !== 256) throw new Error('Invalid map image');
}
function expiry(headers, now) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get('cache-control') ?? '');
  if (match) return now + Math.min(Number(match[1]), 31536000) * 1000;
  const expires = Date.parse(headers.get('expires') ?? '');
  return Number.isFinite(expires) ? Math.max(now, expires) : now + 7 * 86400000;
}

/** Native map service. Requests come only from the visible Leaflet viewport. */
export function createMapCache({ cacheDir, fetchImpl = fetch, now = Date.now, version = '0.3.2' }) {
  const directory = resolve(cacheDir), requests = new Map(), controllers = new Set();
  let suspended = false, closed = false, epoch = 0, active = 0;
  const queue = [];
  const acquire = async () => { if (active < 4 && !queue.length) active++; else await new Promise(resolve => queue.push(resolve)); };
  const release = () => { const next = queue.shift(); if (next) next(); else active--; };
  const store = async (key, contents, metadata, generation) => {
    if (generation !== epoch || suspended) return;
    await checkedCacheDirectory(directory, true);
    const pngPath = join(directory, `${key}.png`), jsonPath = join(directory, `${key}.json`);
    const suffix = `.${randomUUID()}.tmp`, pngTemp = pngPath + suffix, jsonTemp = jsonPath + suffix;
    try {
      await writeFile(pngTemp, contents, { flag: 'wx' });
      await checkedCacheDirectory(directory);
      await writeFile(jsonTemp, JSON.stringify(metadata), { flag: 'wx' });
      if (generation !== epoch || suspended) return;
      await checkedCacheDirectory(directory);
      await rename(pngTemp, pngPath);
      await checkedCacheDirectory(directory);
      await rename(jsonTemp, jsonPath);
    } finally {
      // If the folder was redirected, never remove the identically named file
      // in its replacement. A temporary file in the old folder can be kept.
      await checkedCacheDirectory(directory);
      await Promise.all([unlink(pngTemp), unlink(jsonTemp)].map(promise => promise.catch(error => { if (error.code !== 'ENOENT') throw error; })));
    }
  };
  const readCached = async key => {
    try {
      if (!await checkedCacheDirectory(directory)) return;
      const pngPath = join(directory, `${key}.png`), jsonPath = join(directory, `${key}.json`);
      const [pngStat, jsonStat] = await Promise.all([lstat(pngPath), lstat(jsonPath)]);
      if (pngStat.isSymbolicLink() || jsonStat.isSymbolicLink()) throw new DesktopError('CACHE_PATH_INVALID', '底图缓存文件已被替换');
      if (!pngStat.isFile() || pngStat.size > MAX_TILE || !jsonStat.isFile() || jsonStat.size > 8192) return;
      await checkedCacheDirectory(directory);
      const [contents, json] = await Promise.all([readFile(pngPath), readFile(jsonPath, 'utf8')]);
      const metadata = JSON.parse(json); validatePng(contents);
      if (metadata.sha256 !== sha(contents) || !Number.isFinite(metadata.expiresAt)) return;
      return { contents, metadata };
    } catch (error) {
      if (['ENOENT'].includes(error.code) || error instanceof SyntaxError || error.message === 'Invalid map image') return;
      throw error;
    }
  };
  const load = async tile => {
    const generation = epoch;
    const cached = await readCached(tile.key);
    if (cached?.metadata.expiresAt > now()) return cached.contents;
    await acquire();
    const controller = new AbortController(); controllers.add(controller);
    try {
      if (generation !== epoch || suspended) throw new Error('Map cache is being cleared');
      const response = await fetchImpl(tile.remoteUrl, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        headers: { 'User-Agent': `TerrainWorkshop/${version} (Windows desktop; interactive hiking terrain modeller)`,
          ...(cached?.metadata.etag ? { 'If-None-Match': cached.metadata.etag } : {}),
          ...(cached?.metadata.modified ? { 'If-Modified-Since': cached.metadata.modified } : {}) }, });
      if (response.status === 304 && cached) {
        await store(tile.key, cached.contents, { ...cached.metadata, expiresAt: expiry(response.headers, now()) }, generation);
        return cached.contents;
      }
      if (!response.ok || !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Map service unavailable'); }
      if (Number(response.headers.get('content-length') ?? 0) > MAX_TILE) { await response.body?.cancel(); throw new Error('Map image too large'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Map service returned empty image');
      const chunks = []; let total = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.length;
          if (total > MAX_TILE) throw new Error('Map image too large');
          chunks.push(Buffer.from(part.value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const contents = Buffer.concat(chunks); validatePng(contents);
      await store(tile.key, contents, { sha256: sha(contents), expiresAt: expiry(response.headers, now()),
        etag: response.headers.get('etag'), modified: response.headers.get('last-modified') }, generation);
      return contents;
    } finally { controllers.delete(controller); release(); }
  };
  return {
    async get(url) {
      const tile = parseMapTileUrl(url);
      if (suspended) throw new DesktopError('CACHE_BUSY', '正在清理缓存，请稍后加载底图');
      let pending = requests.get(tile.key);
      if (!pending) {
        pending = load(tile).finally(() => requests.delete(tile.key)); requests.set(tile.key, pending);
      }
      return pending;
    },
    async clear() {
      if (closed) throw new DesktopError('APP_CLOSED', '软件正在退出');
      suspended = true; epoch++;
      try {
        for (const controller of controllers) controller.abort();
        await Promise.allSettled([...requests.values()]);
        await clearOwnedCacheDirectory(dirname(directory), basename(directory));
      } finally { suspended = closed; }
    },
    async close() {
      closed = true; suspended = true; epoch++;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...requests.values()]);
    },
  };
}

export async function cacheDirectoryBytes(directory) {
  let total = 0;
  try {
    if (!await checkedCacheDirectory(directory)) return 0;
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) total += await cacheDirectoryBytes(path);
      else if (child.isFile()) {
        const entry = await lstat(path);
        if (entry.isFile() && !entry.isSymbolicLink()) total += entry.size;
      }
    }
    return total;
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

export async function clearOwnedCacheDirectory(userDataDirectory, name) {
  const parent = resolve(userDataDirectory), target = resolve(parent, name);
  if (!['map-tiles', 'elevation-cache'].includes(name) || dirname(target) !== parent) throw new DesktopError('CACHE_PATH_INVALID', '缓存目录检查失败');
  await checkedCacheDirectory(parent, true);
  await checkedCacheDirectory(target);
  await checkedCacheDirectory(parent);
  await checkedCacheDirectory(target);
  await rm(target, { recursive: true, force: true });
  await checkedCacheDirectory(parent);
  await checkedCacheDirectory(target, true);
}
