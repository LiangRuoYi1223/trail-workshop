import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainError } from '../src/errors.js';
import { createTerrainFrame } from '../src/geo/frame.js';
import { generateTerrain } from '../src/generate-terrain.js';
import { generatePrintableTerrain } from '../src/generate-printable-terrain.js';
import { buildIntegratedTerrainMesh } from '../src/mesh/integrated-model.js';
import { assertPrintableMesh, type PrintableMeshReport } from '../src/mesh/validate.js';
import type { GenerationResult, PrintableTerrainOptions } from '../src/types.js';
import type { TerrainMeshPayload } from '../src/vendor/trailprint/types.js';

const points = [{ lat: 30.55, lon: 104.275 }, { lat: 30.57, lon: 104.305 }];
const gpxXml = '<gpx version="1.1"><trk><trkseg><trkpt lat="30.55" lon="104.275"/><trkpt lat="30.57" lon="104.305"/></trkseg></trk></gpx>';
const options: PrintableTerrainOptions = {
  widthMm: 40, heightMm: 30, gridColumns: 17, groundWidthM: 4000, baseThicknessMm: 3,
};
type IntegratedReport = ReturnType<typeof buildIntegratedTerrainMesh>['report'] & {
  sourceTerrainVolumeMm3: number; addedVolumeMm3: number; volumeErrorMm3: number; volumeToleranceMm3: number;
};

function near(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected} by ${Math.abs(actual - expected)} (tolerance ${tolerance})`);
}

function integratedReport(result: GenerationResult): IntegratedReport {
  return result.report.integratedModel as IntegratedReport;
}

function planeDem(config: PrintableTerrainOptions) {
  const frame = createTerrainFrame(points, config);
  return {
    sample: (lat: number, lon: number) => {
      const p = frame.geoToMm({ lat, lon });
      return 500 + 2 * p.x + 3 * p.y;
    },
    metadata: { provider: 'analytic-printable-test-only' },
  };
}

function xyArea(mesh: TerrainMeshPayload, face: number): number {
  const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3).map(index => index * 3);
  const p = mesh.positions;
  return ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
}

/** Independently integrate the actual emitted triangles, not the generation report. */
function signedVolume(mesh: TerrainMeshPayload): number {
  let six = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3;
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return six / 6;
}

test('stage 2 defaults produce a single closed terrain, 1 mm route and integral 3 mm frame', async () => {
  const result = await generatePrintableTerrain({ gpxXml, options, loadDem: async () => planeDem(options) });
  assert.equal(result.report.stage, 2);
  assert.equal(result.report.modelKind, 'integrated-terrain-route-and-base');
  assert.equal(result.report.unit, 'mm');
  const config = result.report.config as PrintableTerrainOptions & { routeHeightMm: number };
  assert.equal(config.routeWidthMm, 1);
  assert.equal(config.routeHeightMm, 1);
  assert.equal(config.frameWidthMm, 3);
  const report = integratedReport(result);
  assert.equal(report.route.widthMm, 1);
  assert.equal(report.route.heightMm, 1);
  assert.equal(report.frame.widthMm, 3);
  assert.equal(report.frame.topZMm, 3);
  assert.equal(report.frame.style, 'flat-integral-ledge');
  assert.ok(report.route.topVertexCount > 0);
  assert.ok(report.route.areaMm2 > 0);
  assert.ok(report.frame.areaMm2 > 0);
  const validation = assertPrintableMesh(result.mesh);
  assert.deepEqual(result.report.validation, validation);
  assert.equal(validation.connectedComponents, 1);
  assert.equal(validation.boundaryEdges, 0);
  assert.equal(validation.nonManifoldEdges, 0);
  near(validation.bounds.min.z, 0);
  near(validation.bounds.size.x, 46);
  near(validation.bounds.size.y, 36);
  assert.equal(result.mesh.faceKinds?.length, result.mesh.indices.length / 3);
});

test('custom frame width expands actual exterior dimensions by twice its width; zero removes the ledge', async () => {
  for (const frameWidthMm of [0, 1.25, 20]) {
    const config = { ...options, frameWidthMm, routeWidthMm: 0.4 };
    const result = await generatePrintableTerrain({ gpxXml, options: config, loadDem: async () => planeDem(config) });
    const validation = result.report.validation as PrintableMeshReport;
    near(validation.bounds.size.x, options.widthMm! + 2 * frameWidthMm);
    near(validation.bounds.size.y, options.heightMm! + 2 * frameWidthMm);
    const report = integratedReport(result);
    assert.equal(report.route.widthMm, 0.4);
    assert.equal(report.frame.widthMm, frameWidthMm);
    assert.equal(report.frame.style, frameWidthMm === 0 ? 'none' : 'flat-integral-ledge');
    assert.equal(report.frame.areaMm2 === 0, frameWidthMm === 0);
    assert.equal(result.mesh.faceKinds?.includes('frame'), frameWidthMm > 0);
  }
});

test('route stays exactly 1 mm above the original plane for every terrain Z exaggeration', async () => {
  for (const zExaggeration of [0.5, 2, 6]) {
    const config = { ...options, zExaggeration, routeWidthMm: 5, frameWidthMm: 0 };
    const source = await generateTerrain({ gpxXml, options: config, loadDem: async () => planeDem(config) });
    const result = await generatePrintableTerrain({ gpxXml, options: config, loadDem: async () => planeDem(config) });
    assert.deepEqual(result.heightfield, source.heightfield);
    assert.deepEqual(result.report.elevation, source.report.elevation);
    assert.deepEqual(result.routeSegmentsMm, source.routeSegmentsMm);
    assert.equal(source.report.stage, 1);
    assert.equal(source.report.modelKind, 'closed-terrain-without-route-relief');
    assert.equal(source.report.integratedModel, undefined);
    const scale = (options.widthMm! / options.groundWidthM!) * zExaggeration;
    let routeFaces = 0, terrainFaces = 0;
    for (let face = 0; face < result.mesh.indices.length / 3; face++) {
      const kind = result.mesh.faceKinds?.[face];
      if (kind !== 'route' && kind !== 'terrain') continue;
      if (kind === 'route') routeFaces++; else terrainFaces++;
      for (const vertex of result.mesh.indices.slice(face * 3, face * 3 + 3)) {
        const [x, y, z] = result.mesh.positions.slice(vertex * 3, vertex * 3 + 3);
        const originalZ = options.baseThicknessMm! + (500 + 2 * x + 3 * y - source.heightfield.minimumElevationM) * scale;
        near(z - originalZ, kind === 'route' ? 1 : 0, 1e-5);
        near(Math.fround(z) - (options.baseThicknessMm!
          + (500 + 2 * Math.fround(x) + 3 * Math.fround(y) - source.heightfield.minimumElevationM) * scale),
        kind === 'route' ? 1 : 0, 1e-5);
      }
    }
    assert.ok(routeFaces > 0);
    assert.ok(terrainFaces > 0);
    const report = integratedReport(result);
    assert.equal(report.route.heightMm, 1);
    for (const residual of [report.surfaceCheck.routeErrorMm, report.surfaceCheck.routeStlErrorMm,
      report.surfaceCheck.terrainErrorMm, report.surfaceCheck.terrainStlErrorMm]) {
      assert.ok(Number.isFinite(residual) && residual <= report.surfaceCheck.toleranceMm);
    }
  }
});

test('final signed volume equals original terrain plus the route and flat frame volumes', async () => {
  const config = { ...options, zExaggeration: 3, routeWidthMm: 2.5, frameWidthMm: 4.25 };
  const source = await generateTerrain({ gpxXml, options: config, loadDem: async () => planeDem(config) });
  const result = await generatePrintableTerrain({ gpxXml, options: config, loadDem: async () => planeDem(config) });
  let routeArea = 0, frameArea = 0;
  for (let face = 0; face < result.mesh.indices.length / 3; face++) {
    if (result.mesh.faceKinds?.[face] === 'route') routeArea += xyArea(result.mesh, face);
    if (result.mesh.faceKinds?.[face] === 'frame') frameArea += xyArea(result.mesh, face);
  }
  const originalVolume = signedVolume(source.mesh), finalVolume = signedVolume(result.mesh);
  const expectedAddedVolume = routeArea + frameArea * options.baseThicknessMm!;
  const actualAddedVolume = finalVolume - originalVolume, report = integratedReport(result);
  near(actualAddedVolume, expectedAddedVolume, 1e-4);
  near(report.sourceTerrainVolumeMm3, originalVolume);
  near(report.addedVolumeMm3, actualAddedVolume);
  near(report.expectedAddedVolumeMm3, expectedAddedVolume);
  near(report.volumeErrorMm3, Math.abs(actualAddedVolume - expectedAddedVolume));
  assert.ok(report.volumeErrorMm3 <= report.volumeToleranceMm3);
  assert.ok(report.volumeToleranceMm3 > 0);
  near((result.report.validation as PrintableMeshReport).volumeMm3, finalVolume);
});

test('invalid printable or terrain options fail before DEM loading', async () => {
  const invalid: PrintableTerrainOptions[] = [
    ...[0.399, 5.001, NaN, Infinity, -Infinity].map(routeWidthMm => ({ routeWidthMm })),
    ...[-0.001, 20.001, NaN, Infinity, -Infinity].map(frameWidthMm => ({ frameWidthMm })),
    { baseThicknessMm: 0.49 }, { zExaggeration: 0 }, { widthMm: 9.9 }, { gridColumns: 16 },
  ];
  for (const bad of invalid) {
    let loaded = false;
    await assert.rejects(generatePrintableTerrain({ gpxXml, options: { ...options, ...bad }, loadDem: async () => {
      loaded = true; return planeDem(options);
    } }), (error: unknown) => error instanceof TerrainError && error.code === 'CONFIG_INVALID');
    assert.equal(loaded, false, `loaded DEM with ${JSON.stringify(bad)}`);
  }
});

test('already cancelled generation stops before DEM loading', async () => {
  const controller = new AbortController();
  controller.abort();
  let loaded = false;
  await assert.rejects(generatePrintableTerrain({ gpxXml, options, signal: controller.signal, loadDem: async () => {
    loaded = true; return planeDem(options);
  } }), { name: 'AbortError' });
  assert.equal(loaded, false);
});

test('DEM-time cancellation stops before sampling and never announces an integrated model', async () => {
  const controller = new AbortController();
  let sampled = false;
  const phases: string[] = [];
  await assert.rejects(generatePrintableTerrain({ gpxXml, options, signal: controller.signal,
    onProgress: progress => phases.push(progress.phase), loadDem: async (_bounds, context) => {
      assert.equal(context.signal, controller.signal);
      controller.abort();
      return { sample: () => { sampled = true; return 500; }, metadata: {} };
    } }), { name: 'AbortError' });
  assert.equal(sampled, false);
  assert.equal(phases.includes('route'), false);
  assert.equal(phases.includes('done'), false);
});

test('successful progress terminates only after the integrated model passes its checks', async () => {
  const events: Array<{ phase: string; progress: number }> = [];
  await generatePrintableTerrain({ gpxXml, options, loadDem: async () => planeDem(options),
    onProgress: progress => events.push(progress) });
  assert.equal(events.at(-1)?.phase, 'done');
  assert.equal(events.at(-1)?.progress, 1);
  assert.equal(events.filter(event => event.phase === 'done').length, 1);
  const routeIndex = events.findIndex(event => event.phase === 'route');
  assert.ok(routeIndex > 0);
  assert.ok(events.every((event, index) => index === 0 || event.progress >= events[index - 1].progress));
  assert.ok(events.slice(0, -1).every(event => event.progress < 1));
});

test('cancelling at the final 90 percent mesh check rejects and never announces completion', async () => {
  const controller = new AbortController();
  const events: Array<{ phase: string; progress: number }> = [];
  await assert.rejects(generatePrintableTerrain({ gpxXml, options, signal: controller.signal,
    loadDem: async () => planeDem(options), onProgress: progress => {
      events.push(progress);
      if (progress.phase === 'mesh' && progress.progress === 0.9) controller.abort();
    } }), { name: 'AbortError' });
  assert.equal(controller.signal.aborted, true);
  assert.ok(events.some(event => event.phase === 'mesh' && event.progress === 0.9));
  assert.equal(events.some(event => event.phase === 'done'), false);
  assert.ok(events.every(event => event.progress < 1));
});
