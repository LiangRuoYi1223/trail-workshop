import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generatePrintableTerrain } from '../src/generate-printable-terrain.js';
import { createTerrainFrame } from '../src/geo/frame.js';
import { publishTerrainOutput } from '../src/export/publish.js';
import { assertPrintableMesh } from '../src/mesh/validate.js';
import { validateMaterialParts } from '../src/export/material-parts.js';
import type { PrintableTerrainOptions } from '../src/types.js';

const gpxXml = '<gpx><trk><trkseg><trkpt lat="30.55" lon="104.275"/><trkpt lat="30.57" lon="104.305"/></trkseg></trk></gpx>';
const points = [{ lat: 30.55, lon: 104.275 }, { lat: 30.57, lon: 104.305 }];
type SnowOptions = PrintableTerrainOptions & { snowEnabled?: boolean; snowCoveragePercent?: number; snowMaxThicknessMm?: number };
type Part = { id: string; positions: number[]; indices: number[] };
const partsOf = (mesh: object) => (mesh as { materialParts?: Part[] }).materialParts;
const options: SnowOptions = { widthMm: 40, heightMm: 30, groundWidthM: 4000, gridColumns: 17,
  baseThicknessMm: 3, zExaggeration: 1, routeWidthMm: 1.5, routeHeightMm: 0.75, frameWidthMm: 2,
  snowEnabled: true, snowCoveragePercent: 30, snowMaxThicknessMm: 1 };
function loadDem(config: SnowOptions) {
  const frame = createTerrainFrame(points, config);
  return async () => ({ sample: (lat: number, lon: number) => {
    const p = frame.geoToMm({ lat, lon });
    return 500 + 300 * Math.exp(-((p.x - 4) ** 2 + (p.y - 2) ** 2) / 90);
  }, metadata: { provider: 'snow-generation-analytic-test' } });
}
function volume(mesh: { positions: number[]; indices: number[] }) {
  const p = mesh.positions; let six = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = mesh.indices.slice(i, i + 3).map(v => v * 3);
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return six / 6;
}

test('snow settings reject invalid values before reading DEM, including when disabled', async () => {
  const invalid: Partial<SnowOptions>[] = [
    { snowEnabled: 'yes' as unknown as boolean }, { snowCoveragePercent: -1 }, { snowCoveragePercent: 101 },
    { snowCoveragePercent: NaN }, { snowCoveragePercent: Infinity }, { snowMaxThicknessMm: 0.09 },
    { snowMaxThicknessMm: 10.01 }, { snowMaxThicknessMm: Infinity },
    { snowEnabled: false, snowMaxThicknessMm: NaN },
  ];
  for (const bad of invalid) {
    let loaded = false;
    await assert.rejects(generatePrintableTerrain({ gpxXml, options: { ...options, ...bad },
      loadDem: async () => { loaded = true; return (await loadDem(options)()); } }), { code: 'CONFIG_INVALID' });
    assert.equal(loaded, false);
  }
});

test('enabled snow preserves original heightfield and emits solid snow and route material volumes', async () => {
  const original = await generatePrintableTerrain({ gpxXml, options: { ...options, snowEnabled: false } as SnowOptions, loadDem: loadDem(options) });
  const result = await generatePrintableTerrain({ gpxXml, options, loadDem: loadDem(options) });
  assert.deepEqual(result.heightfield, original.heightfield);
  assert.deepEqual(result.routeSegmentsMm, original.routeSegmentsMm);
  assert.equal((result.report.config as SnowOptions).snowEnabled, true);
  assert.equal((result.report.config as SnowOptions).snowMaxThicknessMm, 1);
  assert.ok(result.report.snow, 'generation must expose measured snow report');
  const parts = partsOf(result.mesh);
  assert.ok(parts, 'snow must have actual closed material volume');
  assert.ok(parts.some(part => part.id === 'snow'));
  assert.ok(parts.some(part => part.id === 'route'));
  assert.ok(parts.some(part => part.id === 'terrain'));
  assert.ok(parts.every(part => volume(part) > 0));
  const outer = assertPrintableMesh(result.mesh);
  assert.equal(outer.connectedComponents, 1);
  assert.equal(outer.boundaryEdges, 0);
  assert.ok(Math.abs(parts.reduce((sum, part) => sum + volume(part), 0) - outer.volumeMm3) < Math.max(0.02, outer.volumeMm3 * 1e-5));
  assert.ok(outer.volumeMm3 > volume(original.mesh));
});

test('zero snow coverage and disabled snow preserve the original unified geometry', async () => {
  const bare = await generatePrintableTerrain({ gpxXml, options: { ...options, snowEnabled: false } as SnowOptions, loadDem: loadDem(options) });
  const zero = await generatePrintableTerrain({ gpxXml, options: { ...options, snowCoveragePercent: 0 } as SnowOptions, loadDem: loadDem(options) });
  assert.deepEqual(zero.mesh.positions, bare.mesh.positions);
  assert.deepEqual(zero.mesh.indices, bare.mesh.indices);
  assert.deepEqual(zero.mesh.faceKinds, bare.mesh.faceKinds);
  assert.equal(partsOf(zero.mesh)?.some(part => part.id === 'snow') ?? false, false);
});

test('snow parts share STL precision at noninteger and large print sizes', async () => {
  for (const widthMm of [123.1234, 240.1234]) {
    const config = { ...options, widthMm, heightMm: 80, frameWidthMm: 3 };
    const result = await generatePrintableTerrain({ gpxXml, options: config, loadDem: loadDem(config) });
    // Desktop preview uses the actual Float32 STL coordinates. Every material must
    // remain within that same exterior, including a frame beyond 64 mm from zero.
    const stlMesh = { ...result.mesh, positions: result.mesh.positions.map(Math.fround) };
    const materials = validateMaterialParts(stlMesh);
    assert.ok(materials && materials.parts.some(part => part.id === 'snow'));
    assert.deepEqual(result.mesh.positions, stlMesh.positions);
    for (const part of result.mesh.materialParts ?? []) assert.deepEqual(part.positions, part.positions.map(Math.fround));
  }
});

test('publication retains physical snow material volumes beside the unified STL', async () => {
  const result = await generatePrintableTerrain({ gpxXml, options, loadDem: loadDem(options) });
  const parent = fileURLToPath(new URL('../artifacts/snow-generation-tests/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(join(parent, 'case-'));
  try {
    await publishTerrainOutput(join(folder, 'model.stl'), result);
    const preview = JSON.parse(await readFile(join(folder, 'model.preview.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(folder, 'model.report.json'), 'utf8'));
    assert.deepEqual(preview.mesh.materialParts, partsOf(result.mesh));
    assert.ok(preview.mesh.materialParts?.some((part: { id: string }) => part.id === 'snow'));
    assert.match(report.materialPartsSha256, /^[0-9a-f]{64}$/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
