import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntegratedTerrainMesh } from '../src/mesh/integrated-model.js';
import { assertPrintableMesh } from '../src/mesh/validate.js';
import { buildHeightfieldTerrainMesh } from '../src/vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload } from '../src/vendor/trailprint/types.js';

const geographic = { centerLat: 30, centerLon: 104, bearingDeg: 0, minLat: 29.99, maxLat: 30.01, minLon: 103.99, maxLon: 104.01 };
const rectangle: TerrainCropRegion = { ...geographic, shape: 'rectangle', widthMm: 20, heightMm: 20 };
type Point = { x: number; y: number };
type TaggedMesh = TerrainMeshPayload & { faceKinds: string[] };

function terrain(crop = rectangle, cols = 5, rows = cols, heightAt: (x: number, y: number) => number = () => 0): TerrainMeshPayload {
  const heights = new Float64Array(cols * rows);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = (col / (cols - 1) - 0.5) * crop.widthMm;
    const y = (row / (rows - 1) - 0.5) * crop.heightMm;
    heights[row * cols + col] = heightAt(x, y);
  }
  const mesh = buildHeightfieldTerrainMesh(crop, heights, cols, rows, 2);
  for (let i = 2; i < mesh.positions.length; i += 3) mesh.positions[i] += 2;
  mesh.minSurfaceZ += 2;
  mesh.bottomZ = 0;
  return mesh;
}

function xyArea(mesh: TerrainMeshPayload, face: number): number {
  const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3).map(index => index * 3);
  const p = mesh.positions;
  return ((p[b!]! - p[a!]!) * (p[c! + 1]! - p[a! + 1]!) - (p[b! + 1]! - p[a! + 1]!) * (p[c!]! - p[a!]!)) / 2;
}

/** Independent signed-volume integral; do not use the implementation's report. */
function signedVolume(mesh: TerrainMeshPayload): number {
  let six = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3, b = mesh.indices[i + 1]! * 3, c = mesh.indices[i + 2]! * 3;
    six += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      + p[a + 1]! * (p[b + 2]! * p[c]! - p[b]! * p[c + 2]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return six / 6;
}

function topHeightAt(mesh: TerrainMeshPayload, point: Point): number {
  let bestDistance = Infinity, bestHeight = NaN;
  for (let face = 0; face < mesh.indices.length / 3; face++) {
    const area = xyArea(mesh, face);
    if (area <= 1e-12) continue;
    const [a, b, c] = mesh.indices.slice(face * 3, face * 3 + 3).map(index => index * 3);
    const p = mesh.positions;
    const weightB = ((point.x - p[a!]!) * (p[c! + 1]! - p[a! + 1]!) - (point.y - p[a! + 1]!) * (p[c!]! - p[a!]!)) / (2 * area);
    const weightC = ((p[b!]! - p[a!]!) * (point.y - p[a! + 1]!) - (p[b! + 1]! - p[a! + 1]!) * (point.x - p[a!]!)) / (2 * area);
    const weightA = 1 - weightB - weightC;
    const height = weightA * p[a! + 2]! + weightB * p[b! + 2]! + weightC * p[c! + 2]!;
    if (Math.min(weightA, weightB, weightC) >= -1e-12) return height;
    for (const [from, to] of [[a!, b!], [b!, c!], [c!, a!]]) {
      const dx = p[to]! - p[from]!, dy = p[to + 1]! - p[from + 1]!;
      const t = Math.max(0, Math.min(1, ((point.x - p[from]!) * dx + (point.y - p[from + 1]!) * dy) / (dx * dx + dy * dy)));
      const distance = Math.hypot(point.x - p[from]! - t * dx, point.y - p[from + 1]! - t * dy);
      if (distance < bestDistance) { bestDistance = distance; bestHeight = height; }
    }
  }
  // Integer corridor clipping may move a terrain outline point by a few micrometres.
  // Permit only a physical boundary distance; evaluate the original triangle plane,
  // rather than relaxing barycentric weights (which magnify on sliver triangles).
  if (bestDistance <= 5e-5 && Number.isFinite(bestHeight)) return bestHeight;
  throw new Error(`No top face covers ${point.x}, ${point.y}`);
}

function close(actual: number, expected: number, tolerance = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}

function checkIntegrated(source: TerrainMeshPayload, result: ReturnType<typeof buildIntegratedTerrainMesh>): void {
  const mesh = result.mesh as TaggedMesh;
  assert.equal(mesh.faceKinds.length, mesh.indices.length / 3);
  const validation = assertPrintableMesh(mesh);
  assert.equal(validation.connectedComponents, 1);
  assert.equal(validation.boundaryEdges, 0);
  assert.equal(validation.nonManifoldEdges, 0);
  assert.equal(validation.bounds.min.z, 0);
  let routeArea = 0, frameArea = 0, terrainArea = 0;
  const routeVertices = new Set<number>();
  for (let face = 0; face < mesh.faceKinds.length; face++) {
    const kind = mesh.faceKinds[face], area = xyArea(mesh, face);
    if (kind === 'route') routeArea += area;
    else if (kind === 'frame') frameArea += area;
    else if (kind === 'terrain') terrainArea += area;
    if (kind !== 'route' && kind !== 'terrain') continue;
    assert.ok(area > 0, `${kind} top must face upwards`);
    for (const vertex of mesh.indices.slice(face * 3, face * 3 + 3)) {
      const x = mesh.positions[vertex * 3]!, y = mesh.positions[vertex * 3 + 1]!, z = mesh.positions[vertex * 3 + 2]!;
      const original = topHeightAt(source, { x, y });
      close(z - original, kind === 'route' ? 1 : 0);
      close(Math.fround(z) - original, kind === 'route' ? 1 : 0, 5e-5);
      if (kind === 'route') routeVertices.add(vertex);
    }
  }
  let sourceArea = 0;
  for (let face = 0; face < source.indices.length / 3; face++) sourceArea += Math.max(0, xyArea(source, face));
  close(routeArea + terrainArea, sourceArea, 1e-4);
  close(routeArea, result.report.route.areaMm2, 1e-4);
  close(frameArea, result.report.frame.areaMm2, 1e-4);
  close(signedVolume(mesh) - signedVolume(source), routeArea + 2 * frameArea, 2e-4);
  assert.equal(result.report.route.heightMm, 1);
  assert.ok(routeVertices.size > 0);
  assert.equal(result.report.route.topVertexCount, routeVertices.size);
  assert.ok(result.report.route.maxHeightErrorMm <= 1e-5);
  assert.ok(result.report.route.maxStlHeightErrorMm <= 5e-5);
}

test('narrow 1 mm relief survives a coarse DEM grid and is integral with the source terrain', () => {
  const source = terrain(rectangle, 3);
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[{ x: -8, y: 0 }, { x: 8, y: 0 }]], frameWidthMm: 0 });
  checkIntegrated(source, result);
  close(result.report.route.areaMm2, 16 + Math.PI / 4, 0.04);
  assert.equal(result.report.route.widthMm, 1);
  close(topHeightAt(result.mesh, { x: 0, y: 0 }), 3);
  close(topHeightAt(result.mesh, { x: 0, y: 2 }), 2);
  close(assertPrintableMesh(result.mesh).bounds.size.x, 20);
});

test('selected route thickness changes relief and volume without changing the terrain or corridor width', () => {
  const source = terrain(rectangle, 5, 5, (x, y) => 0.2 * (x + 10) + 0.1 * (y + 10));
  const request = { terrainMesh: source, routeSegmentsMm: [[{ x: -8, y: 0 }, { x: 8, y: 0 }]], routeWidthMm: 2, frameWidthMm: 0 };
  const defaultResult = buildIntegratedTerrainMesh(request);
  for (const routeHeightMm of [0.1, 2.5, 10]) {
    const result = buildIntegratedTerrainMesh({ ...request, routeHeightMm });
    close(topHeightAt(result.mesh, { x: 0, y: 0 }), 5 + routeHeightMm);
    close(topHeightAt(result.mesh, { x: 0, y: 2 }), 5.2);
    close(result.report.route.areaMm2, defaultResult.report.route.areaMm2);
    assert.equal(result.report.route.widthMm, 2);
    assert.equal(result.report.route.heightMm, routeHeightMm);
    for (let face = 0; face < result.mesh.indices.length / 3; face++) {
      const kind = result.mesh.faceKinds?.[face];
      if (kind !== 'route' && kind !== 'terrain') continue;
      for (const vertex of result.mesh.indices.slice(face * 3, face * 3 + 3)) {
        const [x, y, z] = result.mesh.positions.slice(vertex * 3, vertex * 3 + 3);
        close(z - (5 + 0.2 * x + 0.1 * y), kind === 'route' ? routeHeightMm : 0);
      }
    }
    close(signedVolume(result.mesh) - signedVolume(source), result.report.route.areaMm2 * routeHeightMm, 2e-4);
    close(result.report.expectedAddedVolumeMm3, result.report.route.areaMm2 * routeHeightMm);
    const validation = assertPrintableMesh(result.mesh);
    assert.equal(validation.connectedComponents, 1);
    assert.equal(validation.boundaryEdges, 0);
    assert.equal(validation.nonManifoldEdges, 0);
    close(validation.bounds.size.x, 20);
    close(validation.bounds.size.y, 20);
  }
});

test('integrated mesh rejects unprintable or nonfinite route thickness', () => {
  const request = { terrainMesh: terrain(), routeSegmentsMm: [[{ x: -4, y: 0 }, { x: 4, y: 0 }]] };
  for (const routeHeightMm of [0.099, 10.001, NaN, Infinity, -Infinity]) {
    assert.throws(() => buildIntegratedTerrainMesh({ ...request, routeHeightMm }), { code: 'CONFIG_INVALID' });
  }
});

test('new route vertices follow the original tilted DEM triangle planes before adding 1 mm', () => {
  const source = terrain(rectangle, 5, 5, (x, y) => 0.2 * (x + 10) + 0.1 * (y + 10));
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[{ x: -7, y: -5 }, { x: 7, y: 5 }]], frameWidthMm: 0 });
  checkIntegrated(source, result);
  close(topHeightAt(result.mesh, { x: 0, y: 0 }), 6);
  close(topHeightAt(result.mesh, { x: 5, y: -5 }), 5.5);
});

test('route splitting preserves a nonplanar DEM peak rather than replacing it with bilinear samples', () => {
  const source = terrain(rectangle, 3, 3, (x, y) => x === 0 && y === 0 ? 8 : 0);
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[{ x: -8, y: -1 }, { x: 8, y: 5 }]], frameWidthMm: 0 });
  checkIntegrated(source, result);
  close(topHeightAt(result.mesh, { x: 0, y: 0 }), 10);
});

test('a closed loop retains an ordinary-terrain hole in its centre', () => {
  const source = terrain(rectangle, 5);
  const loop = [{ x: -6, y: -6 }, { x: 6, y: -6 }, { x: 6, y: 6 }, { x: -6, y: 6 }, { x: -6, y: -6 }];
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [loop], frameWidthMm: 0 });
  checkIntegrated(source, result);
  close(topHeightAt(result.mesh, { x: 0, y: 0 }), 2);
  close(topHeightAt(result.mesh, { x: 6, y: 0 }), 3);
  close(result.report.route.areaMm2, 47 + Math.PI / 4, 0.05);
});

test('separate GPX segments are not bridged across their gap', () => {
  const source = terrain(rectangle, 5);
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [
    [{ x: -8, y: -4 }, { x: -4, y: -4 }], [{ x: 4, y: 4 }, { x: 8, y: 4 }],
  ], frameWidthMm: 0 });
  checkIntegrated(source, result);
  close(topHeightAt(result.mesh, { x: 0, y: 0 }), 2);
  close(topHeightAt(result.mesh, { x: -6, y: -4 }), 3);
  close(topHeightAt(result.mesh, { x: 6, y: 4 }), 3);
  close(result.report.route.areaMm2, 8 + Math.PI / 2, 0.05);
});

test('crossings and reversed traversal raise the corridor once, not twice', () => {
  const source = terrain(rectangle, 5);
  const horizontal = [{ x: -6, y: 0 }, { x: 6, y: 0 }];
  const forward = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [horizontal], frameWidthMm: 0 });
  const retraced = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[...horizontal, horizontal[0]!]], frameWidthMm: 0 });
  const crossed = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [horizontal, [{ x: 0, y: -6 }, { x: 0, y: 6 }]], frameWidthMm: 0 });
  for (const result of [forward, retraced, crossed]) checkIntegrated(source, result);
  close(retraced.report.route.areaMm2, forward.report.route.areaMm2, 1e-5);
  close(signedVolume(retraced.mesh), signedVolume(forward.mesh), 1e-5);
  close(crossed.report.route.areaMm2, 23 + Math.PI / 2, 0.05);
  close(topHeightAt(crossed.mesh, { x: 0, y: 0 }), 3);
});

test('a route can leave and re-enter the crop without an invented shortcut through the terrain', () => {
  const source = terrain(rectangle, 5);
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[
    { x: -8, y: -4 }, { x: -13, y: -4 }, { x: -13, y: 4 }, { x: -8, y: 4 },
  ]], frameWidthMm: 0 });
  checkIntegrated(source, result);
  close(topHeightAt(result.mesh, { x: -9, y: -4 }), 3);
  close(topHeightAt(result.mesh, { x: -9, y: 4 }), 3);
  close(topHeightAt(result.mesh, { x: -9, y: 0 }), 2);
});

test('source grid diagonals, exact grid edges and duplicate GPX positions remain conforming', () => {
  const source = terrain(rectangle, 5);
  for (const path of [
    [{ x: -9, y: 9 }, { x: 9, y: -9 }],
    [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: -10, y: -10 }, { x: 10, y: 10 }],
  ]) checkIntegrated(source, buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [path], frameWidthMm: 0 }));
});

test('wide corridors retain exact height even on a 3-point grid', () => {
  const source = terrain(rectangle, 3);
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[{ x: -7, y: 0 }, { x: 7, y: 0 }]], routeWidthMm: 4, frameWidthMm: 0 });
  checkIntegrated(source, result);
  assert.equal(result.report.route.widthMm, 4);
  close(topHeightAt(result.mesh, { x: 0, y: 1.5 }), 3);
  close(topHeightAt(result.mesh, { x: 0, y: 3 }), 2);
});

test('flat border and terrain form one closed solid with correctly conserved added volume', () => {
  const source = terrain(rectangle, 5);
  const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[{ x: -8, y: 0 }, { x: 8, y: 0 }]] });
  checkIntegrated(source, result);
  assert.equal(result.report.frame.widthMm, 3);
  const bounds = assertPrintableMesh(result.mesh).bounds;
  close(bounds.size.x, 26, 1e-4);
  close(bounds.size.y, 26, 1e-4);
  close(topHeightAt(result.mesh, { x: 11, y: 0 }), 2);
  assert.ok(result.report.frame.areaMm2 > 200);
});

test('circle, rounded rectangle and pentagon support route relief and an integral frame', () => {
  const crops: TerrainCropRegion[] = [
    { ...rectangle, shape: 'circle', radiusMm: 10 },
    { ...rectangle, cornerRadiusMm: 3 },
    { ...rectangle, shape: 'polygon', radiusMm: 10, polygonSides: 5 },
  ];
  for (const crop of crops) {
    const source = terrain(crop, 5);
    const result = buildIntegratedTerrainMesh({ terrainMesh: source, routeSegmentsMm: [[{ x: -4, y: 0 }, { x: 4, y: 0 }]], frameWidthMm: 2 });
    checkIntegrated(source, result);
    close(topHeightAt(result.mesh, { x: 0, y: 0 }), 3);
  }
});

test('cancellation is checked before constructing the integrated mesh', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => buildIntegratedTerrainMesh({ terrainMesh: terrain(), routeSegmentsMm: [[{ x: -4, y: 0 }, { x: 4, y: 0 }]], signal: controller.signal }), { name: 'AbortError' });
});
