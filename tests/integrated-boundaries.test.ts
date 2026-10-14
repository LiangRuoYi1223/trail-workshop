import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntegratedTerrainMesh } from '../src/mesh/integrated-model.js';
import { assertPrintableMesh } from '../src/mesh/validate.js';
import { buildHeightfieldTerrainMesh } from '../src/vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload } from '../src/vendor/trailprint/types.js';

type Point = { x: number; y: number };
type Shape = 'rectangle' | 'circle' | 'rounded' | 'pentagon';
const geographic = { centerLat: 30, centerLon: 104, bearingDeg: 0, minLat: 29.99, maxLat: 30.01, minLon: 103.99, maxLon: 104.01 };

function terrain(shape: Shape, size: number, cols: number, flat = false): TerrainMeshPayload {
  const crop: TerrainCropRegion = {
    ...geographic, shape: shape === 'rounded' ? 'rectangle' : shape === 'pentagon' ? 'polygon' : shape,
    widthMm: size, heightMm: size, radiusMm: size / 2,
    ...(shape === 'rounded' ? { cornerRadiusMm: size * 0.15 } : {}),
    ...(shape === 'pentagon' ? { polygonSides: 5 } : {}),
  };
  const heights = new Float64Array(cols * cols);
  if (!flat) for (let row = 0; row < cols; row++) for (let col = 0; col < cols; col++) {
    heights[row * cols + col] = 0.15 * col + 0.05 * row + Math.max(0, 2 * Math.sin(col * 1.3) * Math.cos(row * 0.8));
  }
  const source = buildHeightfieldTerrainMesh(crop, heights, cols, cols, 2);
  for (let i = 2; i < source.positions.length; i += 3) source.positions[i] += 2;
  source.minSurfaceZ += 2;
  source.bottomZ = 0;
  return source;
}

function projectedArea(mesh: TerrainMeshPayload, face: number): number {
  const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3).map(index => index * 3);
  const p = mesh.positions;
  return ((p[b]! - p[a]!) * (p[c + 1]! - p[a + 1]!) - (p[b + 1]! - p[a + 1]!) * (p[c]! - p[a]!)) / 2;
}

/** Check closure after actual STL Float32 conversion and independently conserve surface area/volume. */
function check(source: TerrainMeshPayload, result: ReturnType<typeof buildIntegratedTerrainMesh>): void {
  const original = assertPrintableMesh(source), final = assertPrintableMesh(result.mesh);
  assert.equal(final.connectedComponents, 1);
  assert.equal(final.boundaryEdges, 0);
  assert.equal(final.nonManifoldEdges, 0);
  assert.equal(final.bounds.min.z, 0);
  let sourceArea = 0, surfaceArea = 0, routeArea = 0, frameArea = 0;
  for (let face = 0; face < source.indices.length / 3; face++) sourceArea += Math.max(0, projectedArea(source, face));
  for (let face = 0; face < result.mesh.indices.length / 3; face++) {
    const kind = result.mesh.faceKinds?.[face], area = projectedArea(result.mesh, face);
    if (kind === 'route' || kind === 'terrain'||kind==='base'&&area>0) { assert.ok(area > 0); surfaceArea += area; }
    if (kind === 'route') routeArea += area;
    if (kind === 'frame') frameArea += area;
  }
  assert.ok(Math.abs(surfaceArea - sourceArea) < Math.max(1e-4, sourceArea * 1e-8));
  const addedVolume = final.volumeMm3 - original.volumeMm3;
  assert.ok(Math.abs(addedVolume - routeArea - 2 * frameArea) < Math.max(1e-4, original.volumeMm3 * 1e-8));
  assert.ok(result.report.surfaceCheck.routeErrorMm <= 0.001);
  assert.ok(result.report.surfaceCheck.routeStlErrorMm <= 0.001);
  assert.ok(result.report.surfaceCheck.terrainErrorMm <= 0.001);
  assert.ok(result.report.surfaceCheck.terrainStlErrorMm <= 0.001);
}

test('ordinary circle boundary crossings retain the default 1 mm relief in one STL solid', () => {
  const source = terrain('circle', 120, 17, true);
  for (const path of [
    [{ x: -70, y: 0 }, { x: 70, y: 0 }],
    [{ x: -65, y: 35 }, { x: 40, y: 0 }],
    [{ x: 12, y: 36 }, { x: 70, y: -56 }],
  ]) {
    const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [path] });
    check(source, result);
    assert.equal(result.report.route.widthMm, 1);
    assert.equal(result.report.frame.widthMm, 3);
    for (let face = 0; face < result.mesh.indices.length / 3; face++) if (result.mesh.faceKinds?.[face] === 'route') {
      for (const vertex of result.mesh.indices.slice(face * 3, face * 3 + 3)) assert.equal(result.mesh.positions[vertex * 3 + 2], 3);
    }
  }
});

test('a narrow crossing polyline at the circle rim produces neither self-intersecting cuts nor slivers', () => {
  const source = terrain('circle', 20, 5);
  const path = [
    { x: -6.061033599078655, y: -0.2858750503510237 },
    { x: 7.497445810586214, y: 3.65349736623466 },
    { x: 7.36916309595108, y: 1.8679193202406168 },
    { x: 4.072154860943556, y: 9.235543420538306 },
    { x: 6.57770287245512, y: 4.539404707029462 },
  ];
  for (const points of [path.slice(0, 4), path]) check(source, buildIntegratedTerrainMesh({
    terrainMesh: source, routeSegmentsMm: [points], routeWidthMm: 0.4, frameWidthMm: 2,
  }));
});

function seededMatrix(size: number, gridSizes: number[], widths: number[]): void {
  let seed = 0x31ca7761, caseIndex = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const shape of ['rectangle', 'circle', 'rounded', 'pentagon'] as const) for (const cols of gridSizes) for (const width of widths) {
    const path: Point[] = Array.from({ length: 5 }, () => ({ x: (random() - 0.5) * size * 1.2, y: (random() - 0.5) * size * 1.2 }));
    const frame = size === 120 ? 3 : caseIndex % 2 ? 0 : 2;
    const label = `seed=0x31ca7761 case=${caseIndex++} shape=${shape} size=${size} grid=${cols} width=${width} frame=${frame}`;
    try {
      const source = terrain(shape, size, cols);
      check(source, buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [path], routeWidthMm: width, frameWidthMm: frame }));
    } catch (error) {
      assert.fail(`${label}; route=${JSON.stringify(path)}; ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.equal(caseIndex, 4 * gridSizes.length * widths.length);
}

test('fixed seed coarse-grid boundary matrix: 48 rectangles, circles, rounded rectangles and pentagons', () => {
  seededMatrix(20, [3, 5, 9], [0.4, 1, 3, 5]);
});

test('fixed seed production-grid boundary matrix: 24 cases preserve original DEM planes and STL precision', () => {
  seededMatrix(120, [17, 33], [0.4, 1, 3]);
});
