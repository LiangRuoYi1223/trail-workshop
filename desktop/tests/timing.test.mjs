import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
const timing = await import('../main/timing.mjs').catch(() => ({}));
const parent = resolve(import.meta.dirname, '../../outputs/desktop-tests');
async function fixture(t) {
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'timing-'));
  t.after(async () => { assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith('timing-')); await rm(root, { recursive: true, force: true }); });
  return { root, path: join(root, 'timing-v1.json') };
}
const features = { pointCount: 2586, segmentCount: 1, gridColumns: 129, widthMm: 120, heightMm: 80,
  shape: 'rectangle', snowEnabled: false, baseText: '', demMode: 'local', imageMode: 'none' };
const profile = { softwareVersion: '0.5.0', hardwareKey: 'cpu-test' };
const local = { dem: 'local', image: 'none' };
const sample = (totalDurationMs = 10000, initialEstimateMs = 10500) => ({ features, cache: local, totalDurationMs, initialEstimateMs,
  phaseDurationsMs: { prepare: 1000, acquire: 2000, model: totalDurationMs - 4000, verify: 1000 }, finishedAt: '2026-10-13T00:00:00.000Z' });

test('job duration uses the monotonic accepted instant and freezes after finish despite wall-clock changes', () => {
  assert.equal(typeof timing.createJobTiming, 'function', 'monotonic job timing is missing');
  let tick = 100, wall = Date.parse('2026-10-13T00:00:00Z');
  const tracker = timing.createJobTiming({ estimate: { estimatedTotalMs: 10000, estimatedRangeMs: { low: 8000, high: 14000 }, confidence: 'reference', estimateVersion: 'test-v1' },
    startedAtMs: tick, monotonicNow: () => tick, clock: () => new Date(wall) });
  tick = 1100; wall -= 3600000; tracker.enterPhase('acquire');
  assert.equal(tracker.snapshot().elapsedMs, 1000);
  tick = 6100; tracker.enterPhase('model'); tick = 8100; tracker.enterPhase('verify'); tick = 10100;
  const final = tracker.finish(); assert.equal(final.totalDurationMs, 10000); assert.equal(final.elapsedMs, 10000);
  assert.equal(final.finishedAt, '2026-10-12T23:00:00.000Z');
  tick = 999999; wall += 7200000; assert.deepEqual(tracker.finish(), final); assert.deepEqual(tracker.snapshot(), final);
  assert.deepEqual(tracker.phaseDurationsMs(), { prepare: 1000, acquire: 5000, model: 2000, verify: 2000 });
});

test('initial prediction stays immutable when callers mutate snapshots or the original estimate', () => {
  assert.equal(typeof timing.createJobTiming, 'function', 'immutable prediction is missing');
  const estimate = { estimatedTotalMs: 10000, estimatedRangeMs: { low: 8000, high: 14000 }, confidence: 'reference', estimateVersion: 'test-v1' };
  let tick = 0; const tracker = timing.createJobTiming({ estimate, monotonicNow: () => tick, clock: () => new Date(0) });
  estimate.estimatedTotalMs = 1; const snapshot = tracker.snapshot(); snapshot.estimatedRangeMs.high = 1; tick = 30000;
  assert.equal(tracker.snapshot().estimatedTotalMs, 10000); assert.equal(tracker.snapshot().estimatedRangeMs.high, 14000);
  assert.equal(tracker.snapshot().elapsedMs, 30000);
});

test('first network estimates are uncalibrated, local and validated-cache estimates are reference ranges', async t => {
  assert.equal(typeof timing.createTimingHistory, 'function', 'timing history is missing');
  const f = await fixture(t), history = timing.createTimingHistory({ path: f.path, ...profile });
  const network = await history.estimate(features, { dem: 'network', image: 'network' });
  assert.equal(network.confidence, 'uncalibrated'); assert.ok(network.estimatedRangeMs.high > network.estimatedTotalMs);
  assert.equal((await history.estimate(features, local)).confidence, 'reference');
  assert.equal((await history.estimate(features, { dem: 'validated-cache', image: 'validated-cache' })).confidence, 'reference');
  assert.ok(network.estimatedTotalMs > (await history.estimate(features, local)).estimatedTotalMs);
});

test('corrupt, oversized, and unsafe history files fall back without becoming calibrated', async t => {
  assert.equal(typeof timing.createTimingHistory, 'function', 'history fallback is missing');
  const f = await fixture(t);
  for (const bytes of ['{broken', JSON.stringify({ schema: 999, samples: [] }), ' '.repeat(300000)]) {
    await writeFile(f.path, bytes); const history = timing.createTimingHistory({ path: f.path, ...profile });
    const estimate = await history.estimate(features, local); assert.equal(estimate.confidence, 'uncalibrated'); assert.ok(estimate.estimatedTotalMs > 0);
    await history.record(sample()); await history.flush(); assert.equal(JSON.parse(await readFile(f.path, 'utf8')).samples.length, 1);
  }
});

test('only sufficiently accurate prior independent samples calibrate, and acquisition duration is counted once', async t => {
  assert.equal(typeof timing.createTimingHistory, 'function', 'sample-based estimates are missing');
  const f = await fixture(t), history = timing.createTimingHistory({ path: f.path, ...profile });
  await history.record(sample()); assert.equal((await history.estimate(features, local)).confidence, 'reference');
  for (const total of [10500, 9800, 10200, 10000]) await history.record(sample(total, 10100));
  const estimate = await history.estimate(features, local);
  assert.equal(estimate.confidence, 'calibrated'); assert.equal(estimate.estimatedTotalMs, 10000);
  // prepare 1000 + parallel acquisition wall time 2000 + model median 6000 + verify 1000.
  await history.record(sample(30000, 10000)); assert.equal((await history.estimate(features, local)).confidence, 'reference');
  await history.flush(); const restored = timing.createTimingHistory({ path: f.path, ...profile });
  assert.equal((await restored.estimate(features, local)).confidence, 'reference');
});

test('history cohorts include cache category, software, hardware, snow, text, and workload but exclude colors', async t => {
  assert.equal(typeof timing.timingFeatures, 'function', 'workload features are missing');
  assert.equal(typeof timing.createTimingHistory, 'function', 'history grouping is missing');
  const f = await fixture(t), input = { route: { pointCount: 2586, segmentCount: 1 }, options: { ...features, routeColor: '#112233', baseColor: '#112233', textColor: '#112233' },
    bounds: { west: 99.6, east: 99.8, south: 29.7, north: 29.9 }, demMode: 'local', imageMode: 'none' };
  const original = timing.timingFeatures(input);
  assert.deepEqual(timing.timingFeatures({ ...input, options: { ...input.options, routeColor: '#ffffff', baseColor: '#ffffff', textColor: '#ffffff', maxColors: 6 } }), original);
  for (const change of [{ gridColumns: 257 }, { snowEnabled: true }, { baseText: '格聂', baseTextSizeMm: 3 }]) assert.notDeepEqual(timing.timingFeatures({ ...input, options: { ...input.options, ...change } }), original);
  const history = timing.createTimingHistory({ path: f.path, ...profile });
  for (let i = 0; i < 5; i++) await history.record(sample()); await history.flush();
  assert.equal((await history.estimate(features, { dem: 'validated-cache', image: 'none' })).confidence, 'reference');
  assert.equal((await timing.createTimingHistory({ path: f.path, ...profile, softwareVersion: '0.6.0' }).estimate(features, local)).confidence, 'reference');
  assert.equal((await timing.createTimingHistory({ path: f.path, ...profile, hardwareKey: 'other-cpu' }).estimate(features, local)).confidence, 'reference');
});

test('history writes are bounded and atomic, and unavailable storage never rejects a task sample', async t => {
  assert.equal(typeof timing.createTimingHistory, 'function', 'bounded persistence is missing');
  const f = await fixture(t), history = timing.createTimingHistory({ path: f.path, ...profile });
  for (let i = 0; i < 180; i++) await history.record(sample()); await history.flush();
  const bytes = await readFile(f.path); assert.ok(bytes.length <= 262144); assert.ok(JSON.parse(bytes).samples.length <= 160);
  const blocked = join(f.root, 'blocked'); await writeFile(blocked, 'unrelated');
  const unavailable = timing.createTimingHistory({ path: join(blocked, 'timing.json'), ...profile });
  await unavailable.record(sample()); await unavailable.flush(); assert.equal(await readFile(blocked, 'utf8'), 'unrelated');
  assert.equal((await unavailable.estimate(features, local)).confidence, 'uncalibrated');
});

test('an empty or invalid automatic cache is never classified as validated merely because its directory exists', async t => {
  assert.equal(typeof timing.probeTimingCache, 'function', 'cache validation is missing');
  const f = await fixture(t), core = await import('../../dist/src/index.js');
  const bounds = { west: 104.28, east: 104.30, south: 30.56, north: 30.57 };
  const cache = await timing.probeTimingCache({ core, bounds, demMode: 'auto', imageMode: 'auto', demCacheDir: join(f.root, 'dem'), imageCacheDir: join(f.root, 'image'), imageLookbackMonths: 24 });
  assert.deepEqual(cache, { dem: 'network', image: 'network' });
  await mkdir(join(f.root, 'image'), { recursive: true }); await writeFile(join(f.root, 'image', 'sentinel-fake.json'), '{broken');
  const again = await timing.probeTimingCache({ core, bounds, demMode: 'auto', imageMode: 'auto', demCacheDir: join(f.root, 'dem'), imageCacheDir: join(f.root, 'image'), imageLookbackMonths: 24 });
  assert.deepEqual(again, { dem: 'network', image: 'network' });
});

test('unknown cache integrity keeps prediction uncalibrated even with accurate timing history', async t => {
  const f = await fixture(t), history = timing.createTimingHistory({ path: f.path, ...profile });
  const cache = { dem: 'unknown', image: 'none' };
  for (let i = 0; i < 5; i++) await history.record({ ...sample(), cache });
  assert.equal((await history.estimate(features, cache)).confidence, 'uncalibrated');
});

test('first local reference range includes the measured short Electron workload while remaining reference only', async t => {
  const f = await fixture(t), history = timing.createTimingHistory({ path: f.path, ...profile });
  // The recorded first trial was 1126.0401 ms: 172 prepare + 75 local read + 732 model + 147 verify.
  // This is a coarse-reference regression; it is not an independent accuracy or calibration claim.
  const estimate = await history.estimate({ ...features, gridColumns: 65, baseText: '格聂牧场 · 2026', baseTextSizeMm: 3 }, local);
  assert.equal(estimate.confidence, 'reference');
  assert.ok(estimate.estimatedRangeMs.low < 1126.0401 && estimate.estimatedRangeMs.high > 1126.0401);
  assert.ok(estimate.estimatedTotalMs > 500 && estimate.estimatedTotalMs < 2500);
});
