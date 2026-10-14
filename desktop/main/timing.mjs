import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const TIMING_ESTIMATE_VERSION = 'desktop-total-v3-role-selection';
const MAX_HISTORY_BYTES = 256 * 1024, MAX_SAMPLES = 160;
const PHASES = ['prepare', 'acquire', 'model', 'verify'];
const CACHE_KINDS = ['local', 'none', 'validated-cache', 'network', 'unknown'];
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const hardwareIdentity = () => digest({ platform: platform(), arch: arch(), cpu: cpus().map(cpu => cpu.model), memoryGiB: Math.round(totalmem() / 2 ** 30),
  nodeMajor: process.versions.node.split('.')[0], electronMajor: process.versions.electron?.split('.')[0] });

/** Only workload and acquisition inputs belong here; print colors never change the cohort. */
export function timingFeatures({ route, options = {}, bounds, modelFootprint, demMode, imageMode, imageLookbackMonths = 24, demBytes = 0, imageBytes = 0 }) {
  const result = { pointCount: route?.pointCount ?? 0, segmentCount: route?.segmentCount ?? 0, demMode, imageMode, imageLookbackMonths,
    demBytes, imageBytes };
  for (const name of ['gridColumns', 'widthMm', 'heightMm', 'shape', 'polygonSides', 'cornerRadiusMm', 'bearingDeg', 'baseThicknessMm',
    'zExaggeration', 'smoothing', 'routeWidthMm', 'routeHeightMm', 'frameWidthMm', 'maxMissingFraction', 'snowEnabled',
    'snowCoveragePercent', 'snowMaxThicknessMm', 'baseText', 'baseTextSizeMm', 'routeEnabled', 'textEnabled']) if (options[name] !== undefined) result[name] = options[name];
  if (options.textEnabled === false) result.baseText = '';
  if (imageMode === 'auto') {
    result.grassSensitivity = options.grassSensitivity ?? 50;
    if (modelFootprint) result.modelFootprintKey = digest(modelFootprint);
  }
  if (bounds) {
    // Area and latitude affect raster work without making every shifted view a separate geometry cohort.
    const area = Math.abs((bounds.east - bounds.west) * (bounds.north - bounds.south) * Math.cos((bounds.north + bounds.south) * Math.PI / 360));
    result.areaClass = area > 0 ? Math.round(Math.log2(area * 12321000000)) : 0;
    result.latitudeBand = Math.floor((bounds.north + bounds.south) / 20);
  }
  return result;
}

/** Offline loaders perform their ordinary integrity/date/bounds checks; file existence proves nothing. */
export async function probeTimingCache({ core, bounds, demMode, imageMode, hasLocalImage = false, demCacheDir, imageCacheDir,
  imageLookbackMonths = 24, modelFootprint, grassSensitivity = 50, signal, clock = () => new Date() }) {
  const probe = async (branch, operation) => {
    if (typeof operation !== 'function') return 'unknown';
    try {
      const result = await operation();
      if (branch === 'dem') return result?.metadata?.cacheHit === true && typeof result.sample === 'function' ? 'validated-cache' : 'unknown';
      return result?.source?.cacheHit === true && typeof result?.image?.sample === 'function' ? 'validated-cache' : 'unknown';
    } catch (error) {
      return ['DEM_CACHE_MISS', 'DEM_CACHE_INVALID', 'IMAGE_CACHE_MISS'].includes(error?.code) ? 'network' : 'unknown';
    }
  };
  const [dem, image] = await Promise.all([
    demMode === 'auto' ? probe('dem', typeof core.loadCopernicusDem === 'function' ? () => core.loadCopernicusDem(bounds,
      { cacheDir: demCacheDir, offlineOnly: true, signal }) : undefined) : 'local',
    imageMode === 'auto' ? probe('image', typeof core.loadSentinelColorImage === 'function' ? () => core.loadSentinelColorImage(bounds,
      { cacheDir: imageCacheDir, offlineOnly: true, lookbackMonths: imageLookbackMonths, modelFootprint, grassSensitivity, signal, now: () => new Date(clock()) }) : undefined)
      : hasLocalImage ? 'local' : 'none',
  ]);
  return { dem, image };
}

function referenceEstimate(features, cache, healthy) {
  const grid = Math.max(.03, (features.gridColumns ?? 129) ** 2 / 129 ** 2 * Math.min(5, Math.max(.2, (features.heightMm ?? 80) / (features.widthMm ?? 120) / (80 / 120))));
  const route = features.routeEnabled === false ? 1 : Math.min(5, 1 + (features.pointCount ?? 0) / 10000);
  const text = [...String(features.baseText ?? '')].length;
  // Coarse local reference, based on the recorded Electron 65-column label trial:
  // ~170 ms preparation, ~70 ms local read, ~720 ms model, ~110 ms verification.
  // Broad ranges remain reference-only; machine-specific history supplies calibration.
  const prepare = 180 + text * 2;
  const branch = (kind, source) => kind === 'none' ? 0 : kind === 'local' ? (source === 'dem' ? 80 : 120)
    : kind === 'validated-cache' ? (source === 'dem' ? 2000 : 1200) : source === 'dem' ? 30000 : 90000;
  // Both acquisition branches run together. Their wall time is the larger branch, never their sum.
  const acquire = Math.max(branch(cache.dem, 'dem'), branch(cache.image, 'image'));
  const model = 2000 * grid * route * (features.snowEnabled ? 1.8 : 1) + text * 18;
  const verify = 75 + 175 * grid;
  const estimatedTotalMs = Math.round(prepare + acquire + model + verify);
  const network = [cache.dem, cache.image].some(value => value === 'network' || value === 'unknown');
  return { estimatedTotalMs, estimatedRangeMs: { low: Math.max(1, Math.round(estimatedTotalMs * (network ? .35 : .25))),
    high: Math.round(estimatedTotalMs * 4) }, confidence: network || !healthy ? 'uncalibrated' : 'reference', estimateVersion: TIMING_ESTIMATE_VERSION };
}

function validSample(value) {
  if (!record(value) || !/^[a-f0-9]{64}$/.test(value.key) || !record(value.phaseDurationsMs)
    || !PHASES.every(phase => finite(value.phaseDurationsMs[phase])) || !finite(value.totalDurationMs) || value.totalDurationMs <= 0 || value.totalDurationMs > 86400000
    || !finite(value.initialEstimateMs) || value.initialEstimateMs <= 0 || !finite(value.relativeError)
    || typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt))) return false;
  const sum = PHASES.reduce((total, phase) => total + value.phaseDurationsMs[phase], 0);
  return Math.abs(sum - value.totalDurationMs) <= 1 && Math.abs(value.relativeError - Math.abs(value.initialEstimateMs - value.totalDurationMs) / value.totalDurationMs) < 1e-9;
}
async function checkedParent(path) {
  const entry = await lstat(dirname(path));
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe timing directory');
  return entry;
}
async function readHistory(path) {
  await checkedParent(path);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HISTORY_BYTES) throw new Error('unsafe timing history');
  const handle = await open(path, 'r');
  try {
    const actual = await handle.stat();
    if (actual.ino !== before.ino || actual.size !== before.size) throw new Error('changed timing history');
    const bytes = Buffer.alloc(MAX_HISTORY_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await lstat(path);
    if (bytesRead > MAX_HISTORY_BYTES || bytesRead !== before.size || after.isSymbolicLink() || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('changed timing history');
    const stored = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!record(stored) || stored.schema !== 1 || !Array.isArray(stored.samples) || stored.samples.length > MAX_SAMPLES || !stored.samples.every(validSample)) throw new Error('invalid timing history');
    return stored.samples;
  } finally { await handle.close(); }
}

/** This file is separate from project/session state. All persistence errors only lower confidence. */
export function createTimingHistory({ path, softwareVersion = 'development', hardwareKey = hardwareIdentity() }) {
  const target = resolve(path); let samples = [], healthy = true, writing = Promise.resolve();
  const ready = readHistory(target).then(value => { samples = value; }, error => { if (error?.code !== 'ENOENT') healthy = false; });
  const keyFor = (features, cache) => digest({ estimateVersion: TIMING_ESTIMATE_VERSION, softwareVersion, hardwareKey, features, cache });
  const persist = async () => {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true }); const parent = await checkedParent(target);
      try { const existing = await lstat(target); if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('unsafe timing history'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      let bytes = JSON.stringify({ schema: 1, samples });
      while (Buffer.byteLength(bytes) > MAX_HISTORY_BYTES && samples.length) { samples.shift(); bytes = JSON.stringify({ schema: 1, samples }); }
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      const current = await checkedParent(target); if (current.ino !== parent.ino) throw new Error('changed timing directory');
      await rename(temporary, target);
    } catch { healthy = false; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  };
  return {
    async estimate(features, cache) {
      await ready;
      const cohort = samples.filter(sample => sample.key === keyFor(features, cache)).slice(-12);
      if (!cohort.length || !healthy || [cache.dem, cache.image].includes('unknown')) return referenceEstimate(features, cache, healthy);
      const estimatedTotalMs = Math.max(1, Math.round(PHASES.reduce((total, phase) => total + median(cohort.map(sample => sample.phaseDurationsMs[phase])), 0)));
      const calibrated = cohort.length >= 5 && cohort.slice(-3).every(sample => sample.relativeError <= .1);
      const deviation = Math.max(calibrated ? .1 : .25, ...cohort.map(sample => Math.abs(sample.totalDurationMs - estimatedTotalMs) / estimatedTotalMs));
      return { estimatedTotalMs, estimatedRangeMs: { low: Math.max(1, Math.floor(estimatedTotalMs * Math.max(.1, 1 - deviation))),
        high: Math.ceil(estimatedTotalMs * (1 + deviation)) }, confidence: calibrated ? 'calibrated' : 'reference', estimateVersion: TIMING_ESTIMATE_VERSION };
    },
    async record({ features, cache, totalDurationMs, initialEstimateMs, phaseDurationsMs, finishedAt }) {
      await ready;
      if (!record(cache) || !CACHE_KINDS.includes(cache.dem) || !CACHE_KINDS.includes(cache.image)) return;
      const value = { key: keyFor(features, cache), totalDurationMs, initialEstimateMs, phaseDurationsMs: clone(phaseDurationsMs), finishedAt,
        relativeError: Math.abs(initialEstimateMs - totalDurationMs) / totalDurationMs };
      if (!validSample(value)) return;
      samples.push(value); samples = samples.slice(-MAX_SAMPLES);
      writing = writing.then(persist).catch(() => { healthy = false; }); await writing;
    },
    async flush() { await ready; await writing; },
  };
}

export function createJobTiming({ estimate, monotonicNow = () => performance.now(), clock = () => new Date(), startedAtMs = monotonicNow() }) {
  const initial = clone(estimate), durations = Object.fromEntries(PHASES.map(phase => [phase, 0]));
  let elapsed = 0, phase = 'prepare', phaseStart = 0, finished;
  const readElapsed = () => { const next = monotonicNow() - startedAtMs; if (finite(next)) elapsed = Math.max(elapsed, next); return elapsed; };
  const snapshot = () => ({ ...clone(initial), elapsedMs: finished ? finished.totalDurationMs : readElapsed(), ...(finished ? clone(finished) : {}) });
  return {
    snapshot,
    enterPhase(next) {
      if (finished || !PHASES.includes(next) || PHASES.indexOf(next) <= PHASES.indexOf(phase)) return;
      const now = readElapsed(); durations[phase] += now - phaseStart; phase = next; phaseStart = now;
    },
    finish() {
      if (!finished) { const totalDurationMs = readElapsed(); durations[phase] += totalDurationMs - phaseStart;
        finished = { totalDurationMs, finishedAt: new Date(clock()).toISOString() }; }
      return snapshot();
    },
    phaseDurationsMs() { return clone(durations); },
  };
}


