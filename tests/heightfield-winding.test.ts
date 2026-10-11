import assert from "node:assert/strict";
import test from "node:test";
import { buildHeightfieldTerrainMesh } from "../src/vendor/trailprint/heightfield-mesh.js";
import type { TerrainCropRegion } from "../src/vendor/trailprint/types.js";
import { assertPrintableMesh } from "../src/mesh/validate.js";

const geographicFields = { centerLat: 30, centerLon: 104, bearingDeg: 0, minLat: 29.99, maxLat: 30.01, minLon: 103.99, maxLon: 104.01 };
const crops: Array<{ name: string; crop: TerrainCropRegion }> = [
  { name: "rectangle", crop: { ...geographicFields, shape: "rectangle", widthMm: 20, heightMm: 12 } },
  { name: "circle", crop: { ...geographicFields, shape: "circle", widthMm: 20, heightMm: 20, radiusMm: 10 } },
  { name: "rounded rectangle", crop: { ...geographicFields, shape: "rectangle", widthMm: 20, heightMm: 12, cornerRadiusMm: 2 } },
  { name: "odd polygon", crop: { ...geographicFields, shape: "polygon", widthMm: 20, heightMm: 20, radiusMm: 10, polygonSides: 5 } },
];

for (const { name, crop } of crops) {
  test(`${name}: flat cap, floor and side walls all face outward`, () => {
    const mesh = buildHeightfieldTerrainMesh(crop, new Float64Array(9 * 7).fill(5), 9, 7, 2);
    const report = assertPrintableMesh(mesh);
    assert.equal(report.connectedComponents, 1);
    assert.equal(report.bounds.min.z, -2);
    assert.equal(report.bounds.max.z, 5);
    assert.ok(report.volumeMm3 > 0);
    let caps = 0;
    let floors = 0;
    let walls = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i]! * 3;
      const b = mesh.indices[i + 1]! * 3;
      const c = mesh.indices[i + 2]! * 3;
      const ax = mesh.positions[a]!; const ay = mesh.positions[a + 1]!; const az = mesh.positions[a + 2]!;
      const bx = mesh.positions[b]!; const by = mesh.positions[b + 1]!; const bz = mesh.positions[b + 2]!;
      const cx = mesh.positions[c]!; const cy = mesh.positions[c + 1]!; const cz = mesh.positions[c + 2]!;
      const ux = bx - ax; const uy = by - ay; const uz = bz - az;
      const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (az === 5 && bz === 5 && cz === 5) {
        caps++;
        assert.ok(nz > 0, `top face ${i / 3} points down`);
      } else if (az === -2 && bz === -2 && cz === -2) {
        floors++;
        assert.ok(nz < 0, `floor face ${i / 3} points up`);
      } else {
        walls++;
        assert.ok(nx * (ax + bx + cx) + ny * (ay + by + cy) > 0, `wall face ${i / 3} points inward`);
      }
    }
    assert.ok(caps > 0 && floors > 0 && walls > 0);
    if (name === "rectangle") assert.ok(Math.abs(report.volumeMm3 - 20 * 12 * 7) < 1e-9);
  });

  test(`${name}: sloped terrain remains consistently oriented and closed`, () => {
    const heights = new Float64Array(9 * 7);
    for (let row = 0; row < 7; row++) for (let col = 0; col < 9; col++) heights[row * 9 + col] = 3 + col / 4 + row / 3;
    const mesh = buildHeightfieldTerrainMesh(crop, heights, 9, 7, 2);
    assert.equal(assertPrintableMesh(mesh).connectedComponents, 1);
  });
}
