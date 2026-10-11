import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHeightfieldTerrainMesh, estimateTriangleCount, getHeightfieldSampleWeights, MAX_MESH_TRIANGLES,
} from '../src/vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload } from '../src/vendor/trailprint/types.js';
import { assertPrintableMesh } from '../src/mesh/validate.js';

const geographic = { centerLat: 30, centerLon: 104, bearingDeg: 0, minLat: 29.99, maxLat: 30.01, minLon: 103.99, maxLon: 104.01 };
const circle: TerrainCropRegion = { ...geographic, shape: 'circle', widthMm: 120, heightMm: 120, radiusMm: 60 };
const rounded: TerrainCropRegion = { ...geographic, shape: 'rectangle', widthMm: 120, heightMm: 120, cornerRadiusMm: 20 };
const pentagon: TerrainCropRegion = { ...geographic, shape: 'polygon', widthMm: 120, heightMm: 120, radiusMm: 60, polygonSides: 5 };

function maxZ(mesh: TerrainMeshPayload): number {
  let result = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) result = Math.max(result, mesh.positions[i]!);
  return result;
}

test('circle clipping retains the original single-grid mountain peak that polar resampling lost', () => {
  const cols = 129, rows = 129, heights = new Float64Array(cols * rows);
  // Interior point (29.0625, 19.6875): old circle mesh retained only 1.468869 mm of this 10 mm peak.
  heights[85 * cols + 95] = 10;
  const mesh = buildHeightfieldTerrainMesh(circle, heights, cols, rows, 2);
  assert.equal(maxZ(mesh), 10);
  const peak = mesh.positions.findIndex((value, i) => i % 3 === 2 && value === 10);
  assert.equal(mesh.positions[peak - 2], 29.0625);
  assert.equal(mesh.positions[peak - 1], 19.6875);
  assert.equal(assertPrintableMesh(mesh).connectedComponents, 1);
});

test('circle, rounded rectangle and odd polygon retain narrow grid ridges without resampling', () => {
  const cols = 33, rows = 33;
  const heights = new Float64Array(cols * rows);
  for (let row = 0; row < rows; row++) heights[row * cols + 22] = 9;
  for (const crop of [circle, rounded, pentagon]) {
    const mesh = buildHeightfieldTerrainMesh(crop, heights, cols, rows, 2);
    assert.equal(maxZ(mesh), 9);
    // Check several source ridge vertices, not merely a global maximum.
    for (const y of [-15, 0, 15]) {
      let found = false;
      for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i] === 22.5 && mesh.positions[i + 1] === y && mesh.positions[i + 2] === 9) found = true;
      assert.ok(found, `${crop.shape}: missing ridge vertex at 22.5, ${y}`);
    }
    assert.equal(assertPrintableMesh(mesh).connectedComponents, 1);
  }
});

test('boundary height weights match the original triangle planes and omit zero-weight grid support', () => {
  const crop: TerrainCropRegion = { ...geographic, shape: 'rectangle', widthMm: 20, heightMm: 20 };
  const weights = getHeightfieldSampleWeights(-5, -5, crop, 2, 2);
  assert.deepEqual(weights, [{ index: 0, weight: 0.5 }, { index: 1, weight: 0.25 }, { index: 2, weight: 0.25 }]);
  const otherHalf = getHeightfieldSampleWeights(5, 5, crop, 2, 2);
  assert.deepEqual(otherHalf, [{ index: 1, weight: 0.25 }, { index: 3, weight: 0.5 }, { index: 2, weight: 0.25 }]);
  assert.deepEqual(getHeightfieldSampleWeights(10, 10, crop, 2, 2), [{ index: 3, weight: 1 }]);
  assert.deepEqual(getHeightfieldSampleWeights(0, 0, crop, 2, 2), [{ index: 1, weight: 0.5 }, { index: 2, weight: 0.5 }]);
  const clipped = buildHeightfieldTerrainMesh({ ...crop, shape: 'circle', radiusMm: 10 }, [0, 0, 0, 10], 2, 2, 2);
  for (let i = 0; i < clipped.positions.length; i += 6) {
    const x = clipped.positions[i]!, y = clipped.positions[i + 1]!, expected = 10 * Math.max(0, (x + y) / 20);
    assert.ok(Math.abs(clipped.positions[i + 2]! - expected) < 1e-10, 'boundary vertex is off the source triangle plane');
  }
  assert.equal(assertPrintableMesh(clipped).connectedComponents, 1);
});

test('low grids and tangencies remain closed after clipping, including maximum rounded corners', () => {
  const crops: TerrainCropRegion[] = [circle,
    { ...geographic, shape: 'rectangle', widthMm: 500, heightMm: 10, cornerRadiusMm: 0.01 },
    { ...geographic, shape: 'rectangle', widthMm: 500, heightMm: 10, cornerRadiusMm: 5 },
    { ...geographic, shape: 'rectangle', widthMm: 10, heightMm: 10, cornerRadiusMm: 5 },
  ];
  for (const sides of [3, 4, 5, 6, 7, 8]) for (const cornerRadiusMm of [0, 0.01, 60 * Math.cos(Math.PI / sides)])
    crops.push({ ...geographic, shape: 'polygon', widthMm: 120, heightMm: 120, radiusMm: 60, polygonSides: sides, cornerRadiusMm });
  for (const crop of crops) for (const cols of [3, 4, 17, 18]) {
    const rows = crop.widthMm === 500 ? 3 : cols;
    const heights = new Float64Array(cols * rows);
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) heights[row * cols + col] = 3 + col / 4 + row / 8;
    const mesh = buildHeightfieldTerrainMesh(crop, heights, cols, rows, 2);
    const validation = assertPrintableMesh(mesh);
    assert.equal(validation.connectedComponents, 1);
    assert.equal(validation.boundaryEdges, 0);
    assert.equal(validation.nonManifoldEdges, 0);
    assert.ok(validation.triangleCount <= estimateTriangleCount(crop, cols, rows));
  }
});

test('circle includes cardinal extrema even for odd or non-quarter grid resolutions', () => {
  for (const cols of [17, 18, 33]) {
    const mesh = buildHeightfieldTerrainMesh(circle, new Float64Array(cols * cols), cols, cols, 2);
    const report = assertPrintableMesh(mesh);
    assert.equal(report.bounds.size.x, 120);
    assert.equal(report.bounds.size.y, 120);
  }
});

test('clipping adds boundary work without multiplying the whole grid by perimeter samples', () => {
  for (const crop of [circle, rounded, pentagon]) {
    const sizes: number[] = [];
    for (const grid of [33, 65]) {
      const mesh = buildHeightfieldTerrainMesh(crop, new Float64Array(grid * grid), grid, grid, 2);
      const triangles = mesh.indices.length / 3;
      assert.ok(triangles <= estimateTriangleCount(crop, grid, grid));
      assert.ok(triangles < 6 * grid * grid, `${crop.shape} produced excessive triangles`);
      sizes.push(triangles);
    }
    assert.ok(sizes[1]! / sizes[0]! < 4, 'mesh growth exceeded grid area growth');
  }
});

test('large clipped grids are rejected by the triangle budget before creating a huge mesh', () => {
  assert.equal(MAX_MESH_TRIANGLES, 500_000);
  const crop = { ...rounded, widthMm: 500, heightMm: 500, cornerRadiusMm: 5 };
  assert.ok(estimateTriangleCount(crop, 513, 513) > MAX_MESH_TRIANGLES);
  // This only scans a 263k heightfield; the builder rejects before allocating a 513-grid mesh.
  assert.throws(() => buildHeightfieldTerrainMesh(crop, new Float64Array(513 * 513), 513, 513, 2), /estimate.*exceeds.*triangles/);
});
