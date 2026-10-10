import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGeotiffSampler, DemGeotiffError } from './geotiff.js';
import { TerrainError } from '../errors.js';
import type { Bounds, DemSampler } from '../types.js';

const MAX_BYTES = 256 * 1024 * 1024;
const cacheWrites = new Map<string, Promise<void>>();

async function writeCacheExclusively(path: string, write: () => Promise<void>): Promise<void> {
  const identity = resolve(path);
  const previous = cacheWrites.get(identity) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  cacheWrites.set(identity, current);
  await previous;
  try {
    await write();
  } finally {
    release();
    if (cacheWrites.get(identity) === current) cacheWrites.delete(identity);
  }
}

export async function loadLocalDem(path: string): Promise<DemSampler> {
  if ((await stat(path)).size > MAX_BYTES) {
    throw new TerrainError('DEM_TOO_LARGE', '阶段 1 单个 DEM 文件不能超过 256 MB，请先裁剪');
  }
  const bytes = await readFile(path);
  const sampler = await createGeotiffSampler(Uint8Array.from(bytes).buffer);
  return {
    sample: sampler.sample,
    metadata: {
      ...sampler.metadata, provider: 'local-geotiff',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

function checkDownloadSignal(userSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): void {
  // Keep the caller's cancellation reason; do not report cancellation as a network error.
  userSignal?.throwIfAborted();
  if (timeoutSignal.aborted) {
    throw new TerrainError('DEM_FETCH_TIMEOUT', 'OpenTopography DEM 下载超时，请重试或使用本地 GeoTIFF');
  }
}

function downloadFailure(error: unknown, userSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): never {
  checkDownloadSignal(userSignal, timeoutSignal);
  if (error instanceof TerrainError) throw error;
  // Fetch and body errors can include the request URL, so never forward their messages or causes.
  throw new TerrainError('DEM_FETCH_FAILED', '无法下载 OpenTopography DEM，请检查网络并重试');
}

export async function loadOpenTopographyDem(
  bounds: Bounds,
  options: { dataset?: string; cacheDir: string; apiKey?: string; signal?: AbortSignal },
): Promise<DemSampler> {
  options.signal?.throwIfAborted();
  const dataset = options.dataset ?? 'COP30';
  if (!['COP30', 'COP90', 'NASADEM', 'SRTMGL1', 'SRTMGL3'].includes(dataset)) {
    throw new TerrainError('CONFIG_INVALID', '不支持的 OpenTopography 数据集');
  }
  const pad = 0.001;
  const bbox = { west: bounds.west - pad, south: bounds.south - pad, east: bounds.east + pad, north: bounds.north + pad };
  const hash = createHash('sha256').update(JSON.stringify({ dataset, bbox, version: 1 })).digest('hex');
  await mkdir(options.cacheDir, { recursive: true });
  options.signal?.throwIfAborted();
  const path = join(options.cacheDir, `${dataset}_${hash}.tif`);
  let invalidCache: DemGeotiffError | undefined;
  try {
    const cached = await loadLocalDem(path);
    options.signal?.throwIfAborted();
    return { sample: cached.sample, metadata: { ...cached.metadata, provider: 'opentopography', dataset, cacheHit: true } };
  } catch (error) {
    options.signal?.throwIfAborted();
    // Only parser failures are recoverable. Permission and other filesystem errors must remain visible.
    if (error instanceof DemGeotiffError) invalidCache = error;
    else if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const key = options.apiKey?.trim() || process.env.OPENTOPOGRAPHY_API_KEY?.trim();
  if (!key) {
    if (invalidCache) throw invalidCache;
    throw new TerrainError('DEM_API_KEY_REQUIRED', '请在本机环境变量 OPENTOPOGRAPHY_API_KEY 配置个人 Key，或使用本地 GeoTIFF；请勿把 Key 写入公开配置');
  }
  options.signal?.throwIfAborted();
  const url = new URL('https://portal.opentopography.org/API/globaldem');
  for (const [name, value] of Object.entries({ demtype: dataset, ...bbox, outputFormat: 'GTiff', API_Key: key })) {
    url.searchParams.set(name, String(value));
  }
  const timeoutSignal = AbortSignal.timeout(120000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  try {
    checkDownloadSignal(options.signal, timeoutSignal);
    response = await fetch(url, { signal });
    checkDownloadSignal(options.signal, timeoutSignal);
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    return downloadFailure(error, options.signal, timeoutSignal);
  }
  if (!response) throw new TerrainError('DEM_FETCH_FAILED', 'DEM 下载返回空响应');
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    checkDownloadSignal(options.signal, timeoutSignal);
    throw new TerrainError('DEM_FETCH_FAILED', `OpenTopography 请求失败（HTTP ${response.status}），请检查 Key、额度和请求区域`);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    checkDownloadSignal(options.signal, timeoutSignal);
    throw new TerrainError('DEM_TOO_LARGE', '下载的 DEM 过大，请缩小选区');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TerrainError('DEM_FETCH_FAILED', 'DEM 下载返回空内容');
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Cancel the pending read as well as fetch, including a stream supplied by another fetch implementation.
  const cancelReader = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    for (;;) {
      checkDownloadSignal(options.signal, timeoutSignal);
      const { done, value } = await reader.read();
      checkDownloadSignal(options.signal, timeoutSignal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new TerrainError('DEM_TOO_LARGE', 'DEM 超过 256 MB');
      chunks.push(value);
    }
  } catch (error) {
    return downloadFailure(error, options.signal, timeoutSignal);
  } finally {
    signal.removeEventListener('abort', cancelReader);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  const sampler = await createGeotiffSampler(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  options.signal?.throwIfAborted();
  // Only cache parsed valid rasters. A UUID keeps simultaneous requests in one process independent.
  const temporary = path + `.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    options.signal?.throwIfAborted();
    // Windows cannot reliably replace the same destination concurrently, even with unique sources.
    await writeCacheExclusively(path, async () => {
      options.signal?.throwIfAborted();
      await rename(temporary, path);
    });
    options.signal?.throwIfAborted();
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return {
    sample: sampler.sample,
    metadata: {
      ...sampler.metadata, provider: 'opentopography', dataset, cacheHit: false,
      ...(invalidCache ? { cacheRecovered: true } : {}),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
