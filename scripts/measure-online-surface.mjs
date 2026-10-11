import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadSentinelColorImage } from '../dist/src/index.js';

// Measure real public acquisition separately from geometry generation. Each cold
// run gets its own cache; the next two runs exercise exact and overlapping views.
const output = resolve(process.argv[2] ?? `artifacts/generation-speed/live-${Date.now()}`);
await mkdir(output, { recursive: true });
const cacheDir = join(output, 'surface-cache');
const bounds = { west: 114.1, south: 27.4, east: 114.23, north: 27.51 };
const previous = JSON.parse(await readFile(new URL('../artifacts/live-surface-check/result.json', import.meta.url), 'utf8'));
const resume = process.argv.includes('--resume');
const report = resume ? JSON.parse(await readFile(join(output, 'result.json'), 'utf8')) : { passed: false, bounds, baseline: { elapsedMs: previous.elapsedMs,
  requestCount: previous.requests.length, bytes: previous.requests.reduce((sum, item) => sum + item.bytes, 0),
  imageSha256: previous.metadata.sha256 }, runs: [] };
const diagnostic = error => ({ code: error?.code, name: error?.name, message: error?.message,
  ...(error?.cause ? { cause: { code: error.cause.code, name: error.cause.name, message: error.cause.message,
    ...(error.cause.cause ? { cause: { code: error.cause.cause.code, message: error.cause.cause.message } } : {}) } } : {}) });

async function measure(name, view, offlineOnly = false) {
  const start = performance.now(), requests = [], progress = [];
  const transport = async (url, options) => {
    if (offlineOnly) throw new Error('Exact offline cache unexpectedly requested the network');
    const requestStart = performance.now();
    const item = { host: new URL(url).hostname, range: new Headers(options?.headers).get('range'),
      status: null, bytes: 0, elapsedMs: 0 };
    requests.push(item);
    let response;
    try { response = await fetch(url, options); item.status = response.status; }
    catch(error) { item.elapsedMs = Math.round(performance.now() - requestStart); item.error = diagnostic(error); throw error; }
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { item.bytes += chunk.byteLength; controller.enqueue(chunk); },
      flush() { item.elapsedMs = Math.round(performance.now() - requestStart); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  try {
    const result = await loadSentinelColorImage(view, { cacheDir, offlineOnly, fetch: transport,
      onProgress: event => progress.push({ ...event, elapsedMs: Math.round(performance.now() - start) }) });
    const run = { name, passed: true, elapsedMs: Math.round(performance.now() - start),
      requestCount: requests.length, bytes: requests.reduce((sum, item) => sum + item.bytes, 0),
      imageSha256: result.image.metadata.sha256, metadata: result.image.metadata,
      source: result.source, lastProgress: progress.at(-1), requests, progress };
    report.runs.push(run);
    console.log(JSON.stringify({ name, elapsedMs: run.elapsedMs, requestCount: run.requestCount, bytes: run.bytes,
      cacheHit: run.source.cacheHit, imageSha256: run.imageSha256, lastProgress: run.lastProgress }));
    return run;
  } catch (error) {
    report.runs.push({ name, passed: false, elapsedMs: Math.round(performance.now() - start),
      error: diagnostic(error), requests, progress });
    throw error;
  } finally { await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
}

try {
  const first = await measure(resume ? 'retry-after-failure' : 'cold', bounds);
  const exact = await measure('exact-offline', bounds, true);
  if (exact.requestCount !== 0 || exact.imageSha256 !== first.imageSha256) throw new Error('Exact cached imagery changed');
  const overlap = await measure('overlap', { ...bounds, west: bounds.west + 0.001, east: bounds.east + 0.001 });
  report.comparison = { cachedRetry: resume, elapsedReductionPercent: Math.round((1 - first.elapsedMs / report.baseline.elapsedMs) * 1000) / 10,
    requestReductionPercent: Math.round((1 - first.requestCount / report.baseline.requestCount) * 1000) / 10,
    originalImageryIdentical: first.imageSha256 === report.baseline.imageSha256,
    exactCacheIdentical: true, overlapDownloadedBytes: overlap.bytes,
    overlapCacheBytes: overlap.lastProgress?.cacheBytes ?? 0 };
  report.passed = true;
  delete report.error;
  console.log(JSON.stringify({ passed: true, output, comparison: report.comparison }));
} catch (error) {
  report.error = diagnostic(error);
  console.error(JSON.stringify(report.error));
  process.exitCode = 1;
} finally { await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
