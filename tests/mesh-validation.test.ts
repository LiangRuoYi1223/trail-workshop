import assert from "node:assert/strict";
import test from "node:test";
import { assertPrintableMesh, type PrintableMesh } from "../src/mesh/validate.js";

function tetrahedron(offsetX = 0): PrintableMesh {
  return {
    positions: [offsetX, 0, 0, offsetX + 1, 0, 0, offsetX, 1, 0, offsetX, 0, 1],
    indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
  };
}

function facetSoup(mesh: PrintableMesh): PrintableMesh {
  const positions: number[] = [];
  for (const index of mesh.indices) positions.push(...mesh.positions.slice(index * 3, index * 3 + 3));
  return { positions, indices: mesh.indices.map((_, index) => index) };
}

test("reports a closed outward tetrahedron in millimetres", () => {
  const report = assertPrintableMesh(tetrahedron());
  assert.equal(report.vertexCount, 4);
  assert.equal(report.triangleCount, 4);
  assert.equal(report.connectedComponents, 1);
  assert.equal(report.boundaryEdges, 0);
  assert.equal(report.nonManifoldEdges, 0);
  assert.ok(Math.abs(report.volumeMm3 - 1 / 6) < 1e-12);
  assert.deepEqual(report.bounds, {
    min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 },
  });
});

test("welds repeated independent vertices such as STL triangle soup", () => {
  const report = assertPrintableMesh(facetSoup(tetrahedron()));
  assert.equal(report.vertexCount, 12);
  assert.equal(report.connectedComponents, 1);
  assert.equal(report.boundaryEdges, 0);
});

test("rejects a missing face", () => {
  const mesh = tetrahedron();
  mesh.indices.splice(-3);
  assert.throws(() => assertPrintableMesh(mesh), /boundary edges/);
});

test("rejects one reversed face even when edge incidence is two", () => {
  const mesh = tetrahedron();
  [mesh.indices[1], mesh.indices[2]] = [mesh.indices[2]!, mesh.indices[1]!];
  assert.throws(() => assertPrintableMesh(mesh), /same-direction faces/);
});

test("rejects consistently inward faces with negative volume", () => {
  const mesh = tetrahedron();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    [mesh.indices[i + 1], mesh.indices[i + 2]] = [mesh.indices[i + 2]!, mesh.indices[i + 1]!];
  }
  assert.throws(() => assertPrintableMesh(mesh), /volume must be positive/);
});

test("rejects disjoint closed bodies", () => {
  const first = tetrahedron();
  const second = tetrahedron(3);
  const mesh = {
    positions: [...first.positions, ...second.positions],
    indices: [...first.indices, ...second.indices.map((index) => index + 4)],
  };
  assert.throws(() => assertPrintableMesh(mesh), /2 connected components/);
});

test("vertex-only contact does not make two shells one printable surface", () => {
  const first = tetrahedron();
  // Shares only the origin; the second outward tetrahedron lies in the opposite octant.
  const second = tetrahedron();
  second.positions = second.positions.map((coordinate) => -coordinate);
  for (let i = 0; i < second.indices.length; i += 3) {
    [second.indices[i + 1], second.indices[i + 2]] = [second.indices[i + 2]!, second.indices[i + 1]!];
  }
  assert.throws(() => assertPrintableMesh({
    positions: [...first.positions, ...second.positions],
    indices: [...first.indices, ...second.indices.map((index) => index + 4)],
  }), /2 connected components/);
});

test("rejects bad, fractional and negative indices", () => {
  for (const index of [99, 0.5, -1]) {
    const mesh = tetrahedron();
    mesh.indices[0] = index;
    assert.throws(() => assertPrintableMesh(mesh), /invalid index/);
  }
});

test("rejects NaN and infinite coordinates", () => {
  for (const coordinate of [NaN, Infinity, -Infinity]) {
    const mesh = tetrahedron();
    mesh.positions[0] = coordinate;
    assert.throws(() => assertPrintableMesh(mesh), /non-finite coordinate/);
  }
});

test("rejects a collinear triangle", () => {
  const mesh = tetrahedron();
  mesh.positions.splice(6, 3, 2, 0, 0);
  assert.throws(() => assertPrintableMesh(mesh), /degenerate face/);
});

test("rejects a repeated face regardless of winding", () => {
  const mesh = tetrahedron();
  mesh.indices.push(0, 1, 2);
  assert.throws(() => assertPrintableMesh(mesh), /duplicate face/);
});

test("rejects three triangles incident on one edge", () => {
  const mesh = tetrahedron();
  mesh.positions.push(0, 0, -1);
  mesh.indices.push(0, 1, 4);
  assert.throws(() => assertPrintableMesh(mesh), /non-manifold edges/);
});

test("rejects a valid double mesh that collapses when written to Float32 STL", () => {
  const mesh = tetrahedron(100_000_000);
  assert.throws(() => assertPrintableMesh(mesh), /STL Float32: degenerate face/);
});

test("checks complete coordinate and index tuples", () => {
  assert.throws(() => assertPrintableMesh({ positions: [0, 0], indices: [0, 0, 0] }), /complete xyz/);
  const mesh = tetrahedron();
  mesh.indices.pop();
  assert.throws(() => assertPrintableMesh(mesh), /complete triangles/);
});
