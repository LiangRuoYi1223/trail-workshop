import { TerrainError } from '../errors.js';
import {
  buildHeightfieldTerrainMesh,
  getHeightfieldSampleWeights,
} from '../vendor/trailprint/heightfield-mesh.js';
import type { TerrainCropRegion, TerrainMeshPayload, TerrainSmoothing } from '../vendor/trailprint/types.js';

const SMOOTHING_PASSES: Record<TerrainSmoothing, number> = { raw: 0, light: 1, medium: 2, heavy: 4 };

export interface TerrainSampleDomain {
  template: TerrainMeshPayload;
  surfaceSamples: Array<{ vertexIndex: number; weights: ReturnType<typeof getHeightfieldSampleWeights> }>;
  required: Uint8Array;
  surfaceSupportCount: number;
  requiredCount: number;
}

/** Use the real surface topology, including clipped boundary vertices, to find its raster dependencies. */
export function createTerrainSampleDomain(
  crop: TerrainCropRegion,
  cols: number,
  rows: number,
  smoothing: TerrainSmoothing,
): TerrainSampleDomain {
  const template = buildHeightfieldTerrainMesh(crop, new Float64Array(cols * rows), cols, rows, 1);
  const surfaceSamples: TerrainSampleDomain['surfaceSamples'] = [];
  let required = new Uint8Array(cols * rows);
  for (let offset = 0; offset < template.positions.length; offset += 3) {
    if (template.positions[offset + 2] !== 0) continue;
    const weights = getHeightfieldSampleWeights(template.positions[offset], template.positions[offset + 1], crop, cols, rows);
    surfaceSamples.push({ vertexIndex: offset / 3, weights });
    for (const { index, weight } of weights) {
      if (weight > 0) required[index] = 1;
    }
  }
  const surfaceSupportCount = required.reduce((sum, value) => sum + value, 0);
  // Each 3x3 blur pass needs one more ring of original DEM samples. Do not
  // discard valid data outside the outline when it contributes to smoothing.
  for (let pass = 0; pass < SMOOTHING_PASSES[smoothing]; pass++) {
    const expanded = required.slice();
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      if (!required[row * cols + col]) continue;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr, c = col + dc;
        if (r >= 0 && r < rows && c >= 0 && c < cols) expanded[r * cols + c] = 1;
      }
    }
    required = expanded;
  }
  return { template, surfaceSamples, required, surfaceSupportCount, requiredCount: required.reduce((sum, value) => sum + value, 0) };
}

/** Fill only the already-approved small number of missing required samples. */
export function fillRequiredDemHoles(elevations: Float64Array, required: Uint8Array, cols: number, rows: number): void {
  let remaining: number[] = [];
  for (let index = 0; index < elevations.length; index++) {
    if (required[index] && !Number.isFinite(elevations[index])) remaining.push(index);
  }
  for (let pass = 0; remaining.length && pass < 96; pass++) {
    const updates: Array<{ index: number; value: number }> = [];
    const unresolved: number[] = [];
    for (const index of remaining) {
      const row = Math.floor(index / cols), col = index % cols;
      let sum = 0, count = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        const neighbour = r * cols + c;
        if (required[neighbour] && Number.isFinite(elevations[neighbour])) { sum += elevations[neighbour]; count++; }
      }
      if (count) updates.push({ index, value: sum / count });
      else unresolved.push(index);
    }
    if (!updates.length) break;
    for (const { index, value } of updates) elevations[index] = value;
    remaining = unresolved;
  }
  if (remaining.length) throw new TerrainError('DEM_COVERAGE_MISSING', '必要采样点缺值无法由有效邻域插补，请检查 DEM 覆盖范围');
}

export function sampleDomainSurface(domain: TerrainSampleDomain, elevations: Float64Array): Float64Array {
  return Float64Array.from(domain.surfaceSamples, ({ weights }) => {
    let value = 0;
    for (const sample of weights) value += elevations[sample.index] * sample.weight;
    if (!Number.isFinite(value)) throw new TerrainError('DEM_COVERAGE_MISSING', '成品地表的必要高程采样点仍存在缺值');
    return value;
  });
}
