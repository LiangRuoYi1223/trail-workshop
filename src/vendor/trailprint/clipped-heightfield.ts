// Grid clipping replaces TrailPrint's polar/concentric resampling; the source DEM triangles remain intact.
import { buildFootprintPolygonMm } from './footprint.js';
import { circleClipPolygon, type Vec2 } from './mesh-clip.js';
import type { TerrainCropRegion, TerrainMeshPayload } from './types.js';

export const MAX_MESH_TRIANGLES = 500_000;
const WELD_MM = 1e-6;
const AREA_EPSILON = 1e-12;

export interface HeightfieldSampleWeight { index: number; weight: number }

/** The two original XY grid triangles share the diagonal from southeast to northwest. */
export function getHeightfieldSampleWeights(
  x: number, y: number, crop: TerrainCropRegion, cols: number, rows: number,
): HeightfieldSampleWeight[] {
  const cf = Math.max(0, Math.min(cols - 1, (x + crop.widthMm / 2) / crop.widthMm * (cols - 1)));
  const rf = Math.max(0, Math.min(rows - 1, (y + crop.heightMm / 2) / crop.heightMm * (rows - 1)));
  const col = Math.min(cols - 2, Math.floor(cf)), row = Math.min(rows - 2, Math.floor(rf));
  const u = cf - col, v = rf - row, i = row * cols + col;
  const weights = u + v <= 1
    ? [{ index: i, weight: 1 - u - v }, { index: i + 1, weight: u }, { index: i + cols, weight: v }]
    : [{ index: i + 1, weight: 1 - v }, { index: i + cols + 1, weight: u + v - 1 }, { index: i + cols, weight: 1 - u }];
  return weights.filter(p => p.weight > 0);
}

function outlineFor(crop: TerrainCropRegion, cols: number, rows: number): Vec2[] {
  if (crop.shape !== 'circle') {
    const polygon = buildFootprintPolygonMm(crop);
    if (!polygon || polygon.length < 3) throw new Error('Invalid convex terrain footprint');
    return polygon;
  }
  const radius = crop.radiusMm ?? Math.min(crop.widthMm, crop.heightMm) / 2;
  // Chord sagitta <= 0.05 mm and <= one eighth of the source grid step. Include all four extrema.
  const tolerance = Math.min(0.05, crop.widthMm / (cols - 1) / 8, crop.heightMm / (rows - 1) / 8);
  const needed = Math.ceil(Math.PI / Math.acos(1 - Math.min(tolerance / radius, 1)));
  const segments = Math.max(32, Math.min(512, Math.ceil(needed / 4) * 4));
  return circleClipPolygon(radius, segments);
}
/** Exact convex footprint used to clip the source grid, shared with model-space previews. */
export {outlineFor as buildTerrainFootprintPolygonMm};

/** Conservative preflight bound: original grid plus boundary intersections and boundary fans. */
export function estimateTriangleCount(crop: TerrainCropRegion, cols: number, rows: number): number {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) throw new Error('Invalid terrain grid dimensions');
  if (crop.shape === 'rectangle' && (crop.cornerRadiusMm ?? 0) <= 1e-6)
    return 4 * (cols - 1) * (rows - 1) + 4 * (cols + rows - 2);
  // A convex outline meets each horizontal, vertical and parallel grid diagonal at most twice.
  // Each clipped triangle adds at most one centre vertex; no concentric copies of the perimeter.
  return 4 * cols * rows + 48 * (cols + rows) + 8 * outlineFor(crop, cols, rows).length;
}

function cross(a: Vec2, b: Vec2, p: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Logarithmic point classification in a strictly convex CCW outline, including its boundary. */
function inside(p: Vec2, polygon: Vec2[]): boolean {
  const first = polygon[0]!;
  if (cross(first, polygon[1]!, p) < -AREA_EPSILON || cross(first, polygon[polygon.length - 1]!, p) > AREA_EPSILON) return false;
  let lo = 1, hi = polygon.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cross(first, polygon[mid]!, p) >= 0) lo = mid; else hi = mid;
  }
  return cross(polygon[lo]!, polygon[hi]!, p) >= -AREA_EPSILON;
}

/** Standard Sutherland–Hodgman order; shared grid edges generate identical intersections. */
function clipTriangle(subject: Vec2[], polygon: Vec2[]): Vec2[] {
  let output = subject;
  for (let i = 0; i < polygon.length && output.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    const input = output; output = [];
    let previous = input[input.length - 1]!, prevDistance = cross(a, b, previous);
    for (const point of input) {
      const distance = cross(a, b, point), prevIn = prevDistance >= 0, pointIn = distance >= 0;
      if (prevIn !== pointIn) {
        const t = prevDistance / (prevDistance - distance);
        output.push({ x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t });
      }
      if (pointIn) output.push(point);
      previous = point; prevDistance = distance;
    }
  }
  return output;
}

/** The outline's intersection with a horizontal cell strip bounds the cells worth processing. */
function stripBounds(polygon: Vec2[], low: number, high: number): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  const include = (x: number) => { min = Math.min(min, x); max = Math.max(max, x); };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    if (a.y >= low && a.y <= high) include(a.x);
    if (b.y !== a.y) for (const y of [low, high]) {
      const t = (y - a.y) / (b.y - a.y);
      if (t >= 0 && t <= 1) include(a.x + (b.x - a.x) * t);
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** Clip each original grid triangle, mirror its floor, then close every unmatched top edge. */
export function buildClippedHeightfieldMesh(
  crop: TerrainCropRegion, heights: ArrayLike<number>, cols: number, rows: number,
  baseThicknessMm: number, fallback: number,
): TerrainMeshPayload {
  const estimate = estimateTriangleCount(crop, cols, rows);
  if (estimate > MAX_MESH_TRIANGLES) throw new Error(`Terrain mesh estimate ${estimate} exceeds ${MAX_MESH_TRIANGLES} triangles`);
  const polygon = outlineFor(crop, cols, rows), positions: number[] = [], indices: number[] = [];
  const bottomZ = -baseThicknessMm, dx = crop.widthMm / (cols - 1), dy = crop.heightMm / (rows - 1);
  const xs = Array.from({ length: cols }, (_, col) => -crop.widthMm / 2 + col * dx);
  const ys = Array.from({ length: rows }, (_, row) => -crop.heightMm / 2 + row * dy);
  const classified = new Int8Array(cols * rows).fill(-1);
  const coordinates = new Map<string, number>();
  const boundary = new Map<string, { a: number; b: number }>();

  function vertex(p: Vec2): number {
    // Canonical XY is also exactly what STL will store. Cache by XY so adjacent triangles share Z.
    const x = Math.fround(p.x), y = Math.fround(p.y);
    const key = `${Math.round(x / WELD_MM)},${Math.round(y / WELD_MM)}`;
    const previous = coordinates.get(key);
    if (previous !== undefined) return previous;
    const weights = getHeightfieldSampleWeights(x, y, crop, cols, rows);
    const firstHeight = heights[weights[0]!.index]!;
    const reference = Number.isFinite(firstHeight) ? firstHeight : fallback;
    let z = reference;
    // Difference form preserves constant fields exactly and reduces cancellation at high elevations.
    for (const sample of weights) {
      const h = heights[sample.index]!;
      z += sample.weight * ((Number.isFinite(h) ? h : fallback) - reference);
    }
    const index = positions.length / 3;
    positions.push(x, y, z, x, y, bottomZ);
    coordinates.set(key, index);
    return index;
  }

  function addTriangle(a: number, b: number, c: number): void {
    if (a === b || b === c || c === a) return;
    const area = (positions[b * 3]! - positions[a * 3]!) * (positions[c * 3 + 1]! - positions[a * 3 + 1]!)
      - (positions[b * 3 + 1]! - positions[a * 3 + 1]!) * (positions[c * 3]! - positions[a * 3]!);
    if (area <= AREA_EPSILON) return;
    indices.push(a, b, c, a + 1, c + 1, b + 1);
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = from! < to! ? `${from},${to}` : `${to},${from}`;
      const existing = boundary.get(key);
      if (existing) {
        if (existing.a !== to || existing.b !== from) throw new Error('Inconsistent clipped terrain edge orientation');
        boundary.delete(key);
      } else boundary.set(key, { a: from!, b: to! });
    }
    if (indices.length / 3 > MAX_MESH_TRIANGLES) throw new Error('Clipped terrain exceeds triangle budget');
  }

  function gridPoint(row: number, col: number): Vec2 { return { x: xs[col]!, y: ys[row]! }; }
  function gridInside(row: number, col: number): boolean {
    const index = row * cols + col;
    if (classified[index] === -1) classified[index] = inside(gridPoint(row, col), polygon) ? 1 : 0;
    return classified[index] === 1;
  }
  function triangle(points: Vec2[], entirelyInside: boolean): void {
    if (entirelyInside) { addTriangle(vertex(points[0]!), vertex(points[1]!), vertex(points[2]!)); return; }
    const clipped = clipTriangle(points, polygon);
    const verts: number[] = [];
    for (const point of clipped) {
      const index = vertex(point);
      if (verts[verts.length - 1] !== index) verts.push(index);
    }
    if (verts.length > 1 && verts[0] === verts[verts.length - 1]) verts.pop();
    if (verts.length < 3) return;
    if (verts.length === 3) { addTriangle(verts[0]!, verts[1]!, verts[2]!); return; }
    // An interior fan retains every boundary subdivision; deleting collinear edge vertices makes T-junctions.
    const center = { x: 0, y: 0 };
    for (const index of verts) { center.x += positions[index * 3]! / verts.length; center.y += positions[index * 3 + 1]! / verts.length; }
    const centerIndex = vertex(center);
    for (let i = 0; i < verts.length; i++) addTriangle(centerIndex, verts[i]!, verts[(i + 1) % verts.length]!);
  }

  for (let row = 0; row < rows - 1; row++) {
    const strip = stripBounds(polygon, ys[row]!, ys[row + 1]!);
    if (!strip) continue;
    const first = Math.max(0, Math.floor((strip.min + crop.widthMm / 2) / dx) - 1);
    const last = Math.min(cols - 2, Math.floor((strip.max + crop.widthMm / 2) / dx) + 1);
    for (let col = first; col <= last; col++) {
      const sw = gridPoint(row, col), se = gridPoint(row, col + 1), nw = gridPoint(row + 1, col), ne = gridPoint(row + 1, col + 1);
      const swi = gridInside(row, col), sei = gridInside(row, col + 1), nwi = gridInside(row + 1, col), nei = gridInside(row + 1, col + 1);
      triangle([sw, se, nw], swi && sei && nwi);
      triangle([se, ne, nw], sei && nei && nwi);
    }
  }
  for (const { a, b } of boundary.values()) indices.push(a + 1, b + 1, b, a + 1, b, a);
  if (indices.length / 3 > MAX_MESH_TRIANGLES) throw new Error('Clipped terrain exceeds triangle budget');
  // Clipping can create a zero-area contact before its polygon is discarded. Such unused vertices
  // must not influence the support/extrema pass that consumes the zero-height geometry template.
  const used = new Uint8Array(positions.length / 3);
  for (const index of indices) used[index] = 1;
  const remap = new Int32Array(used.length).fill(-1), compact: number[] = [];
  let minSurfaceZ = Infinity;
  for (let index = 0; index < used.length; index += 2) if (used[index] || used[index + 1]) {
    remap[index] = compact.length / 3; remap[index + 1] = remap[index]! + 1;
    compact.push(...positions.slice(index * 3, index * 3 + 6));
    minSurfaceZ = Math.min(minSurfaceZ, positions[index * 3 + 2]!);
  }
  for (let i = 0; i < indices.length; i++) indices[i] = remap[indices[i]!]!;
  return { positions: compact, indices, minSurfaceZ: Number.isFinite(minSurfaceZ) ? minSurfaceZ : fallback, bottomZ, gridCols: cols, gridRows: rows };
}
