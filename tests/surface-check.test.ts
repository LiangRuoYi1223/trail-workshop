import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainError } from '../src/errors.js';
import { buildIntegratedTerrainMesh } from '../src/mesh/integrated-model.js';
import { checkIntegratedSurfaceHeights } from '../src/mesh/surface-check.js';
import { buildHeightfieldTerrainMesh } from '../src/vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload } from '../src/vendor/trailprint/types.js';

const crop: TerrainCropRegion = {
  centerLat: 30, centerLon: 104, bearingDeg: 0,
  minLat: 29.99, maxLat: 30.01, minLon: 103.99, maxLon: 104.01,
  shape: 'rectangle', widthMm: 10.000011, heightMm: 10.000019,
};

function flatTriangle(): TerrainMeshPayload {
  return {
    positions: [0, 0, 2, 1, 0, 2, 0, 1, 2], indices: [0, 1, 2],
    minSurfaceZ: 2, bottomZ: 0, gridCols: 17, gridRows: 17,
  };
}

function raisedTriangle(): TerrainMeshPayload {
  return { ...flatTriangle(), positions: [0, 0, 3, 1, 0, 3, 0, 1, 3], faceKinds: ['route'] };
}

test('400 mm peak preserves original planes and honestly reports the nonzero Float32 residual', () => {
  const heights = new Float64Array(17 * 17);
  heights[8 * 17 + 8] = 400;
  const source = buildHeightfieldTerrainMesh(crop, heights, 17, 17, 2);
  for (let offset = 2; offset < source.positions.length; offset += 3) source.positions[offset] += 2;
  source.minSurfaceZ += 2;
  source.bottomZ = 0;
  const result = buildIntegratedTerrainMesh({
    terrainMesh: source, frameWidthMm: 0,
    routeSegmentsMm: [[{ x: -4, y: -1.3 }, { x: 4, y: 2.2 }]],
  });
  const measured = checkIntegratedSurfaceHeights(source, result.mesh);
  assert.deepEqual(result.report.surfaceCheck, measured);
  assert.equal(measured.toleranceMm, 0.001);
  assert.ok(measured.routeVertexCount > 0);
  assert.ok(measured.terrainVertexCount > 0);
  // The six source triangles around the isolated centre peak form a hexagonal tent.
  // Its closed-form height is independent of the production plane lookup and mesh report.
  const originalZ = (x: number, y: number) => {
    const u = x / (crop.widthMm / 16), v = y / (crop.heightMm / 16);
    return 2 + 400 * Math.max(0, 1 - Math.max(Math.abs(u), Math.abs(v), Math.abs(u + v)));
  };
  const independent = { routeErrorMm: 0, routeStlErrorMm: 0, terrainErrorMm: 0, terrainStlErrorMm: 0 };
  for (let face = 0; face < result.mesh.indices.length / 3; face++) {
    const kind = result.mesh.faceKinds?.[face];
    if (kind !== 'route' && kind !== 'terrain') continue;
    const errorKey = kind === 'route' ? 'routeErrorMm' : 'terrainErrorMm';
    const stlErrorKey = kind === 'route' ? 'routeStlErrorMm' : 'terrainStlErrorMm';
    for (const vertex of result.mesh.indices.slice(face * 3, face * 3 + 3)) {
      const [x, y, z] = result.mesh.positions.slice(vertex * 3, vertex * 3 + 3), raised = kind === 'route' ? 1 : 0;
      independent[errorKey] = Math.max(independent[errorKey], Math.abs(z - originalZ(x, y) - raised));
      independent[stlErrorKey] = Math.max(independent[stlErrorKey],
        Math.abs(Math.fround(z) - originalZ(Math.fround(x), Math.fround(y)) - raised));
    }
  }
  for (const key of ['routeErrorMm', 'routeStlErrorMm', 'terrainErrorMm', 'terrainStlErrorMm'] as const) {
    assert.ok(Math.abs(measured[key] - independent[key]) < 1e-9, `${key} does not match independent measurement`);
    assert.ok(measured[key] <= measured.toleranceMm);
  }
  assert.ok(measured.routeErrorMm < 1e-9);
  assert.ok(measured.terrainErrorMm < 1e-9);
  for (const residual of [measured.routeStlErrorMm, measured.terrainStlErrorMm]) {
    // Preserving Double XY now removes the old clipping residual; actual STL storage
    // still changes this steep plane (~0.000006127 mm), which must never be reported as zero.
    assert.ok(residual > 1e-7 && residual <= measured.toleranceMm, `unexpected Float32 residual ${residual}`);
  }
  assert.equal(result.report.route.maxHeightErrorMm, measured.routeErrorMm);
  assert.equal(result.report.route.maxStlHeightErrorMm, measured.routeStlErrorMm);
});

test('surface checks scan large coordinate arrays without spreading them into function arguments', () => {
  const source = flatTriangle();
  // A legal 257×257 integrated model was also checked manually (272,424 faces).
  // This recreates its large-array failure condition while keeping daily tests cheap.
  // These unused source vertices do not add source faces or change their plane.
  source.positions.length = 180_000 * 3;
  source.positions.fill(0, 9);
  const measured = checkIntegratedSurfaceHeights(source, raisedTriangle());
  assert.equal(measured.routeVertexCount, 3);
  assert.equal(measured.routeErrorMm, 0);
  assert.equal(measured.routeStlErrorMm, 0);
  assert.equal(measured.terrainVertexCount, 0);
});

test('height checks reject terrain or route offsets exceeding 0.001 mm in either direction', () => {
  for (const kind of ['terrain', 'route'] as const) for (const offset of [-0.002, 0.002]) {
    const mesh = kind === 'route' ? raisedTriangle() : { ...flatTriangle(), faceKinds: [kind] };
    mesh.positions[2] += offset;
    assert.throws(() => checkIntegratedSurfaceHeights(flatTriangle(), mesh),
      (error: unknown) => error instanceof TerrainError && error.code === 'MODEL_SURFACE_MISMATCH');
  }
});

test('height checks reject terrain vertices with no corresponding original surface plane', () => {
  const mesh = raisedTriangle();
  mesh.positions[0] = 2;
  assert.throws(() => checkIntegratedSurfaceHeights(flatTriangle(), mesh),
    (error: unknown) => error instanceof TerrainError && error.code === 'MODEL_SURFACE_MISMATCH');
});
