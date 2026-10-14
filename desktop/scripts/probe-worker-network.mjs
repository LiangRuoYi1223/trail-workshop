import { app, net, utilityProcess } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { createTerrainFrame, parseRouteXml } from '../../dist/src/index.js';

// Only localhost is contacted. Profiles, rasters and output are owned by this probe.
const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = join(root, 'artifacts/desktop-worker-network-probe');
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, 'run-'));
mkdirSync(join(output, 'profile'));
app.setPath('userData', join(output, 'profile'));
app.disableHardwareAcceleration();
const report = { output, runtime: { electron: process.versions.electron, node: process.versions.node }, control: false, cases: [] };
const requests = [], children = [];
let server;
const routeXml = '<gpx><trk><name>Local transport fixture</name><trkseg><trkpt lat="0.00011" lon="3.00010"/><trkpt lat="0.00020" lon="3.00023"/></trkseg></trk></gpx>';
const modelOptions = { shape: 'rectangle', widthMm: 60, heightMm: 60, groundWidthM: 25, center: { lat: .000175, lon: 3.000175 },
  gridColumns: 17, baseThicknessMm: 2, routeWidthMm: 1, routeHeightMm: 1, frameWidthMm: 0, zExaggeration: 1 };
const sourceUrl = 'https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/local-transport-fixture/';
const feature = { id: 'local-transport-fixture', collection: 'sentinel-2-c1-l2a', bbox: [2.99, -.01, 3.01, .01],
  properties: { datetime: '2026-07-01T10:00:00Z', 'eo:cloud_cover': 0 },
  assets: { visual: { href: sourceUrl + 'TCI.tif' }, scl: { href: sourceUrl + 'SCL.tif' } } };
const geo = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32631, GTRasterTypeGeoKey: 1, ModelTiepoint: [0, 0, 0, 500000, 40, 0] };
const visual = Buffer.from(writeArrayBuffer(Uint8Array.from(Array.from({ length: 16 }, () => [30, 140, 40]).flat()),
  { ...geo, width: 4, height: 4, BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PhotometricInterpretation: 2, ModelPixelScale: [10, 10, 0] }));
const scl = Buffer.from(writeArrayBuffer(new Uint8Array([4, 4, 4, 4]),
  { ...geo, width: 2, height: 2, BitsPerSample: [8], SampleFormat: [1], PhotometricInterpretation: 1, ModelPixelScale: [20, 20, 0] }));
const dem = Buffer.from(writeArrayBuffer(Float32Array.from(Array.from({ length: 256 }, (_, i) => 100 + i % 16)),
  { width: 16, height: 16, BitsPerSample: [32], SampleFormat: [3], PhotometricInterpretation: 1,
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, ModelTiepoint: [0, 0, 0, 2.99, .01, 0], ModelPixelScale: [.02 / 16, .02 / 16, 0] }));

async function run() {
  await app.whenReady();
  await writeFile(join(output, 'dem.tif'), dem);
  server = createServer(async (request, response) => {
    const entry = { mode: request.headers['x-network-case'], method: request.method, path: request.url,
      range: request.headers.range, closed: false };
    requests.push(entry);
    response.on('close', () => { entry.closed = true; });
    if (request.url === '/slow') return;
    if (request.url === '/redirect') { entry.status = 302; response.writeHead(302, { Location: '/unexpected-target' }); response.end(); return; }
    if (request.url === '/unexpected-target') { entry.status = 200; response.end('redirect was followed'); return; }
    if (request.url === '/catalog' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      try { const query = JSON.parse(body); entry.catalogValid = query.collections?.[0] === 'sentinel-2-c1-l2a' && query.bbox?.length === 4 && query.bbox.every(Number.isFinite); }
      catch { entry.catalogValid = false; }
      entry.status = 200; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ features: [feature] })); return;
    }
    const bytes = { '/dem.tif': dem, '/TCI.tif': visual, '/SCL.tif': scl }[request.url];
    if (!bytes) { entry.status = 404; response.writeHead(404); response.end(); return; }
    if (request.method === 'HEAD') { entry.status = 200; response.writeHead(200, { 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' }); response.end(); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) { entry.status = 400; response.writeHead(400); response.end('Range required'); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
    if (start > end) { entry.status = 416; response.writeHead(416); response.end(); return; }
    entry.status = 206; response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Accept-Ranges': 'bytes' }); response.end(bytes.subarray(start, end + 1));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controlHeaders = { 'x-network-case': 'control' };
  const catalog = await net.fetch(base + '/catalog', { method: 'POST', headers: controlHeaders, body: JSON.stringify({ collections: ['sentinel-2-c1-l2a'], bbox: [3, 0, 3.001, .001] }), redirect: 'error' });
  assert.equal(catalog.status, 200); assert.equal((await catalog.json()).features.length, 1);
  const head = await net.fetch(base + '/dem.tif', { method: 'HEAD', headers: controlHeaders, redirect: 'error' }); assert.equal(head.status, 200);
  const range = await net.fetch(base + '/dem.tif', { headers: { ...controlHeaders, Range: 'bytes=0-31' }, redirect: 'error' });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32); report.control = true;

  const coreUrl = pathToFileURL(join(root, 'dist/src/index.js')).href;
  const controlledCore = join(output, 'local-acquisition.mjs');
  // Sentinel runs its real catalog, range client, TIFF parsing, cloud selection and cache.
  // Only its public URLs are mapped to localhost. DEM's official 3600x3600 tile
  // acquisition boundary uses a small real remote GeoTIFF; its sampler and all
  // model generation/classification/publication remain production implementations.
  await writeFile(controlledCore, `export * from ${JSON.stringify(coreUrl)};
import { loadSentinelColorImage as realSentinel, loadLocalDem } from ${JSON.stringify(coreUrl)};
import { fromUrl, getDecoder } from 'geotiff';
import assert from 'node:assert/strict';
const base = ${JSON.stringify(base)}, mode = process.env.WORKER_NETWORK_CASE;
const headers = input => { const result = new Headers(input); result.set('x-network-case', mode); return result; };
const localFetch = (path, init = {}) => globalThis.fetch(base + path, { ...init, headers: headers(init.headers) });
export async function loadCopernicusDem(bounds, options) {
  const response = await localFetch('/dem.tif', { method: 'HEAD', signal: options.signal, redirect: 'error' });
  assert.equal(response.status, 200); await response.body?.cancel();
  const tiff = await fromUrl(base + '/dem.tif', { allowFullFile: false, blockSize: 65536, cacheSize: 256, headers: { 'x-network-case': mode } }, options.signal);
  try { const image = await tiff.getImage(), values = await image.readRasters({ window: [0, 0, 4, 4], samples: [0], interleave: true, signal: options.signal });
    assert.deepEqual(Array.from(values).slice(0, 4), [100, 101, 102, 103]);
  } finally { await tiff.close(); }
  return loadLocalDem(${JSON.stringify(join(output, 'dem.tif'))});
}
export async function loadSentinelColorImage(bounds, options) {
  if (mode === 'data') {
    const response = await globalThis.fetch('data:text/plain,local-decoder-resource');
    assert.equal(await response.text(), 'local-decoder-resource');
    process.parentPort.postMessage({ type: 'diagnostic', dataTextRead: true });
  }
  if (mode === 'zstd') {
    // This really imports zstddec, fetches its bundled data: WASM, instantiates
    // WebAssembly and waits for initialization before the worker can publish.
    await getDecoder(50000, {});
    process.parentPort.postMessage({ type: 'diagnostic', zstdInitialized: true });
  }
  if (mode === 'redirect') {
    await assert.rejects(localFetch('/redirect', { redirect: 'error', signal: options.signal }));
    process.parentPort.postMessage({ type: 'diagnostic', redirectRejected: true });
  }
  if (mode === 'abort') {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('local probe cancelled', 'AbortError')), 100);
    try { await assert.rejects(localFetch('/slow', { redirect: 'error', signal: AbortSignal.any([controller.signal, options.signal]) }), error => error?.name === 'AbortError');
      process.parentPort.postMessage({ type: 'diagnostic', abortRejected: true });
    } finally { clearTimeout(timer); }
  }
  const fetch = (input, init) => {
    const url = String(input);
    if (url === 'https://earth-search.aws.element84.com/v1/search') return localFetch('/catalog', init);
    if (url === ${JSON.stringify(sourceUrl + 'TCI.tif')}) return localFetch('/TCI.tif', init);
    if (url === ${JSON.stringify(sourceUrl + 'SCL.tif')}) return localFetch('/SCL.tif', init);
    throw new Error('Probe forbids non-fixture network requests');
  };
  return realSentinel(bounds, { ...options, fetch, now: () => new Date('2026-10-10T12:00:00Z') });
}
`);
  const bootstrap = join(output, 'blocked-node-fetch.mjs');
  await writeFile(bootstrap, `const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!/^https?:/i.test(url)) return nativeFetch(input, init);
  process.parentPort.postMessage({ type: 'blocked-node-fetch', url: String(input), method: init?.method ?? 'GET' });
  throw Object.assign(new Error('Native Node fetch deliberately unavailable in Electron regression'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
};
await import(${JSON.stringify(pathToFileURL(join(root, 'desktop/main/worker.mjs')).href)});
`);
  const route = parseRouteXml(routeXml, { fileName: 'local.gpx' });
  const bounds = createTerrainFrame(route.segments.flatMap(segment => segment.points), modelOptions).bounds;
  for (const mode of ['success', 'redirect', 'abort', 'data', 'zstd']) {
    const taskDir = join(output, mode); await mkdir(taskDir);
    const result = { mode, blockedNodeFetch: [], diagnostics: {}, outputValid: false };
    const child = utilityProcess.fork(bootstrap, [], { cwd: taskDir, stdio: 'pipe', env: { ...process.env, WORKER_NETWORK_CASE: mode } }); children.push(child);
    child.stdout?.on('data', chunk => process.stdout.write(chunk)); child.stderr?.on('data', chunk => process.stderr.write(chunk));
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${mode} worker did not settle`)); }, 15000);
      child.on('message', message => {
        if (message.type === 'blocked-node-fetch') result.blockedNodeFetch.push(message);
        else if (message.type === 'diagnostic') Object.assign(result.diagnostics, message);
        else if (['failure', 'complete'].includes(message.type)) result.message = message;
      });
      child.once('exit', code => { clearTimeout(timer); result.exitCode = code; done(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.postMessage({ type: 'generate', jobId: mode, gpxXml: routeXml, fileName: 'local.gpx', demMode: 'auto', demCacheDir: join(taskDir, 'dem-cache'), offlineOnly: false,
        imageMode: 'auto', imageCacheDir: join(taskDir, 'image-cache'), imageOfflineOnly: false, imageLookbackMonths: 24,
        appearanceOptions: { maxColors: 3, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' },
        bounds, options: modelOptions, taskDir, coreModuleUrl: pathToFileURL(controlledCore).href });
    });
    if (result.message?.type === 'complete') {
      const generated = JSON.parse(await readFile(join(taskDir, 'model.report.json'), 'utf8'));
      result.outputValid = generated.validation.boundaryEdges === 0 && generated.validation.nonManifoldEdges === 0 && generated.validation.connectedComponents === 1;
      result.triangleCount = generated.validation.triangleCount;
    }
    result.requests = requests.filter(request => request.mode === mode); report.cases.push(result);
  }
}
async function main() {
 try { await run(); } catch (error) { report.harnessError = { name: error.name, message: error.message, stack: error.stack }; }
 finally {
  children.forEach(child => child.kill());
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  report.passed = !report.harnessError && report.cases.length === 5 && report.cases.every(result => result.message?.type === 'complete' && result.outputValid && result.blockedNodeFetch.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('WORKER_NETWORK_REPORT ' + JSON.stringify(report));
  app.exit(report.passed ? 0 : 1);
 }
}
void main().catch(error => { console.error(error); app.exit(1); });
