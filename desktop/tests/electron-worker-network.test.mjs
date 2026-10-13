import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Removing the Electron worker's transport adaptation must break real acquisition,
// even when the corresponding requests work through Chromium in the main process.
test('Electron worker acquires and publishes with Node fetch unavailable, preserving redirects and aborts', { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, '../..');
  const profiles = join(root, 'artifacts/desktop-worker-network-launch');
  await mkdir(profiles, { recursive: true });
  const profile = await mkdtemp(join(profiles, 'profile-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [resolve(root, 'desktop/scripts/probe-worker-network.mjs'), `--user-data-dir=${profile}`, '--disable-gpu'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 55000);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  clearTimeout(timer);
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('WORKER_NETWORK_REPORT '));
  assert.ok(line, `Electron probe did not report: exit=${code}\n${stdout}\n${stderr}`);
  const report = JSON.parse(line.slice('WORKER_NETWORK_REPORT '.length));
  assert.equal(report.harnessError, undefined, JSON.stringify(report));
  assert.equal(report.control, true, 'localhost server must first work through Electron net.fetch');
  for (const result of report.cases) {
    assert.equal(result.message?.type, 'complete', `${result.mode}: worker must complete when native Node fetch fails; ${JSON.stringify(result)}`);
    assert.equal(result.blockedNodeFetch.length, 0, `${result.mode}: acquisition used native Node fetch`);
    assert.equal(result.outputValid, true, `${result.mode}: real worker must publish a closed, verified mesh`);
    assert.ok(result.requests.some(request => request.path === '/catalog' && request.method === 'POST' && request.catalogValid), `${result.mode}: real Sentinel catalog POST missing`);
    assert.ok(result.requests.some(request => request.path === '/dem.tif' && request.method === 'HEAD'), `${result.mode}: DEM HEAD missing`);
    for (const path of ['/dem.tif', '/TCI.tif', '/SCL.tif']) {
      assert.ok(result.requests.some(request => request.path === path && request.method === 'GET' && request.range && request.status === 206), `${result.mode}: real GeoTIFF Range missing for ${path}`);
    }
    if (result.mode === 'redirect') {
      assert.equal(result.diagnostics.redirectRejected, true, 'redirect:error must reject');
      assert.equal(result.requests.some(request => request.path === '/unexpected-target'), false, 'redirect:error must never follow the target');
    }
    if (result.mode === 'abort') {
      assert.equal(result.diagnostics.abortRejected, true, 'AbortSignal must reject the request');
      assert.ok(result.requests.some(request => request.path === '/slow' && request.closed), 'aborting must close the outstanding HTTP response');
    }
    if (result.mode === 'data') assert.equal(result.diagnostics.dataTextRead, true, 'local data: resources must remain readable');
    if (result.mode === 'zstd') assert.equal(result.diagnostics.zstdInitialized, true, 'real GeoTIFF ZSTD decoder must initialize its bundled WASM');
  }
  assert.equal(code, 0, `Electron probe exit=${code}: ${stderr}`);
});
