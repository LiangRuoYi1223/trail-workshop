/** Printing checks in millimetres. Weld quantisation is deliberately fixed. */
const WELD_EPSILON_MM = 1e-6;
const MIN_CROSS_LENGTH_MM2 = WELD_EPSILON_MM * WELD_EPSILON_MM;

export interface PrintableMesh {
  positions: number[];
  indices: number[];
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface PrintableMeshReport {
  vertexCount: number;
  triangleCount: number;
  connectedComponents: number;
  volumeMm3: number;
  bounds: { min: Vector3; max: Vector3; size: Vector3 };
  boundaryEdges: number;
  nonManifoldEdges: number;
}

interface EdgeRecord {
  count: number;
  direction: number;
  firstFace: number;
}

class DisjointFaces {
  private readonly parents: Uint32Array;
  private readonly ranks: Uint8Array;

  constructor(count: number) {
    this.parents = new Uint32Array(count);
    this.ranks = new Uint8Array(count);
    for (let i = 0; i < count; i++) this.parents[i] = i;
  }

  find(index: number): number {
    let root = index;
    while (this.parents[root] !== root) root = this.parents[root]!;
    while (index !== root) {
      const next = this.parents[index]!;
      this.parents[index] = root;
      index = next;
    }
    return root;
  }

  join(left: number, right: number): void {
    let a = this.find(left);
    let b = this.find(right);
    if (a === b) return;
    if (this.ranks[a]! < this.ranks[b]!) [a, b] = [b, a];
    this.parents[b] = a;
    if (this.ranks[a] === this.ranks[b]) this.ranks[a] = this.ranks[a]! + 1;
  }

  componentCount(): number {
    const roots = new Set<number>();
    for (let i = 0; i < this.parents.length; i++) roots.add(this.find(i));
    return roots.size;
  }
}

function fail(representation: string, message: string): never {
  throw new Error(`${representation}: ${message}`);
}

function boundsFor(positions: number[], representation: string): PrintableMeshReport["bounds"] {
  const min: Vector3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vector3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (![x, y, z].every(Number.isFinite)) {
      fail(representation, `non-finite coordinate at vertex ${i / 3}`);
    }
    min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  if (![size.x, size.y, size.z].every(Number.isFinite)) fail(representation, "non-finite bounds");
  return { min, max, size };
}

/** Edge adjacency counts surface components; merely touching at a vertex is insufficient. */
function validateRepresentation(mesh: PrintableMesh, representation: string): PrintableMeshReport {
  const { positions, indices } = mesh;
  if (!positions.length || positions.length % 3 !== 0) {
    fail(representation, "positions must contain complete xyz vertices");
  }
  if (!indices.length || indices.length % 3 !== 0) {
    fail(representation, "indices must contain complete triangles");
  }
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  if (triangleCount > 0xffffffff) fail(representation, "too many triangles");
  const bounds = boundsFor(positions, representation);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      fail(representation, `invalid index ${index} at position ${i}`);
    }
  }

  const weldByCoordinate = new Map<string, number>();
  const weldedIndices = new Uint32Array(vertexCount);
  const weldedPositions: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const offset = i * 3;
    const x = positions[offset]!;
    const y = positions[offset + 1]!;
    const z = positions[offset + 2]!;
    const qx = Math.round(x / WELD_EPSILON_MM);
    const qy = Math.round(y / WELD_EPSILON_MM);
    const qz = Math.round(z / WELD_EPSILON_MM);
    if (![qx, qy, qz].every(Number.isSafeInteger)) {
      fail(representation, "coordinate exceeds safe 1e-6 mm weld quantisation range");
    }
    const key = `${qx},${qy},${qz}`;
    let id = weldByCoordinate.get(key);
    if (id === undefined) {
      id = weldedPositions.length / 3;
      weldByCoordinate.set(key, id);
      weldedPositions.push(x, y, z);
    }
    weldedIndices[i] = id;
  }

  const faces = new Set<string>();
  const edges = new Map<string, EdgeRecord>();
  const connected = new DisjointFaces(triangleCount);
  // Translate volume integration to a local origin to avoid cancellation for distant coordinates.
  const origin = bounds.min;
  let signedSixVolume = 0;
  let compensation = 0;

  for (let face = 0; face < triangleCount; face++) {
    const offset = face * 3;
    const a = weldedIndices[indices[offset]!]!;
    const b = weldedIndices[indices[offset + 1]!]!;
    const c = weldedIndices[indices[offset + 2]!]!;
    if (a === b || b === c || c === a) fail(representation, `degenerate face ${face} after coordinate welding`);

    const faceKey = [a, b, c].sort((left, right) => left - right).join(",");
    if (faces.has(faceKey)) fail(representation, `duplicate face ${face}`);
    faces.add(faceKey);

    const ax = weldedPositions[a * 3]! - origin.x;
    const ay = weldedPositions[a * 3 + 1]! - origin.y;
    const az = weldedPositions[a * 3 + 2]! - origin.z;
    const bx = weldedPositions[b * 3]! - origin.x;
    const by = weldedPositions[b * 3 + 1]! - origin.y;
    const bz = weldedPositions[b * 3 + 2]! - origin.z;
    const cx = weldedPositions[c * 3]! - origin.x;
    const cy = weldedPositions[c * 3 + 1]! - origin.y;
    const cz = weldedPositions[c * 3 + 2]! - origin.z;
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const crossLength = Math.hypot(
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    );
    if (!Number.isFinite(crossLength) || crossLength <= MIN_CROSS_LENGTH_MM2) {
      fail(representation, `degenerate face ${face} (zero or negligible area)`);
    }

    const sixVolume = ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx);
    const corrected = sixVolume - compensation;
    const next = signedSixVolume + corrected;
    compensation = (next - signedSixVolume) - corrected;
    signedSixVolume = next;

    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const low = Math.min(from!, to!);
      const high = Math.max(from!, to!);
      const key = `${low},${high}`;
      const direction = from! < to! ? 1 : -1;
      const existing = edges.get(key);
      if (existing) {
        existing.count++;
        existing.direction += direction;
        connected.join(existing.firstFace, face);
      } else {
        edges.set(key, { count: 1, direction, firstFace: face });
      }
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let sameDirectionEdges = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) boundaryEdges++;
    else if (edge.count !== 2) nonManifoldEdges++;
    else if (edge.direction !== 0) sameDirectionEdges++;
  }
  if (nonManifoldEdges) fail(representation, `${nonManifoldEdges} non-manifold edges`);
  if (sameDirectionEdges) fail(representation, `${sameDirectionEdges} edges have same-direction faces`);
  if (boundaryEdges) fail(representation, `${boundaryEdges} boundary edges; mesh is not closed`);

  const connectedComponents = connected.componentCount();
  if (connectedComponents !== 1) fail(representation, `${connectedComponents} connected components; expected one solid surface`);
  const volumeMm3 = signedSixVolume / 6;
  if (!Number.isFinite(volumeMm3) || volumeMm3 <= 0) {
    fail(representation, `volume must be positive, got ${volumeMm3} mm3`);
  }
  return { vertexCount, triangleCount, connectedComponents, volumeMm3, bounds, boundaryEdges, nonManifoldEdges };
}

/**
 * Check both the input and coordinates as actually stored by binary STL (Float32).
 * Does not perform global triangle/triangle intersection or printer process checks.
 */
export function assertPrintableMesh(mesh: PrintableMesh): PrintableMeshReport {
  const report = validateRepresentation(mesh, "Mesh");
  const stlPositions = mesh.positions.map(Math.fround);
  validateRepresentation({ positions: stlPositions, indices: mesh.indices }, "STL Float32");
  return report;
}
