import { createGrassPixelClassifier } from './grass-continuity.js';
import { imageFail } from './online-remote.js';

export interface SurfaceCoverageDomain {
  width: number; height: number; model: Uint8Array; demand: Uint8Array; modelCount: number;
  circleRadiusM: number; pixelWidthM: number; pixelHeightM: number;
}

const EPSILON = 1e-9, MAX_PIXELS = 1_048_576;
type Point = { x: number; y: number };
function validGrid(width: number, height: number, pixelWidthM: number, pixelHeightM: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS
    || !Number.isFinite(pixelWidthM) || !Number.isFinite(pixelHeightM) || pixelWidthM <= 0 || pixelHeightM <= 0)
    imageFail('IMAGE_REQUEST_INVALID', '模型地表影像的像元范围或地面尺寸无效');
}

/** Rasterize interiors by scanline, then retain every closed cell touched by an edge. */
export function createSurfaceCoverageDomain(input: { width: number; height: number; polygon: ReadonlyArray<{ x: number; y: number }>; pixelWidthM: number; pixelHeightM: number }): SurfaceCoverageDomain {
  const { width, height, polygon, pixelWidthM, pixelHeightM } = input;
  validGrid(width, height, pixelWidthM, pixelHeightM);
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 4096 || polygon.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)))
    imageFail('IMAGE_REQUEST_INVALID', '模型地表影像的取景轮廓无效');
  const model = new Uint8Array(width * height), demand = new Uint8Array(model.length);
  const fill = (mask: Uint8Array, row: number, first: number, last: number): void => {
    const left = Math.max(0, first), right = Math.min(width - 1, last);
    if (left <= right) mask.fill(1, row * width + left, row * width + right + 1);
  };
  for (let row = 0; row < height; row++) {
    const y = row + .5, crossings: number[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index], b = polygon[(index + 1) % polygon.length];
      if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
    }
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2)
      fill(model, row, Math.ceil(crossings[index] - .5 - EPSILON), Math.floor(crossings[index + 1] - .5 + EPSILON));
  }
  for (let index = 0; index < polygon.length; index++) {
    const a: Point = polygon[index], b: Point = polygon[(index + 1) % polygon.length];
    const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y);
    for (let row = Math.max(0, Math.ceil(low - EPSILON) - 1); row <= Math.min(height - 1, Math.floor(high + EPSILON)); row++) {
      let left: number, right: number;
      if (a.y === b.y) { left = Math.min(a.x, b.x); right = Math.max(a.x, b.x); }
      else {
        const firstY = Math.max(row, low), lastY = Math.min(row + 1, high);
        const firstX = a.x + (firstY - a.y) / (b.y - a.y) * (b.x - a.x);
        const lastX = a.x + (lastY - a.y) / (b.y - a.y) * (b.x - a.x);
        left = Math.min(firstX, lastX); right = Math.max(firstX, lastX);
      }
      fill(model, row, Math.ceil(left - EPSILON) - 1, Math.floor(right + EPSILON));
    }
  }
  let modelCount = 0;
  // Dilate horizontal model runs. Euclidean image-pixel radius 2 gives row widths 0, 1, 2, 1, 0.
  for (let row = 0; row < height; row++) {
    let column = 0;
    while (column < width) {
      if (!model[row * width + column]) { column++; continue; }
      const first = column;
      while (column < width && model[row * width + column]) { modelCount++; column++; }
      for (let dy = -2; dy <= 2; dy++) if (row + dy >= 0 && row + dy < height) {
        const dx = Math.floor(Math.sqrt(4 - dy * dy)); fill(demand, row + dy, first - dx, column - 1 + dx);
      }
    }
  }
  const circleRadiusM = Math.sqrt(.01 * modelCount * pixelWidthM * pixelHeightM / Math.PI);
  if (!modelCount || !Number.isFinite(circleRadiusM) || circleRadiusM <= 0)
    imageFail('IMAGE_REQUEST_INVALID', '模型取景轮廓没有可用的地表影像像元');
  return { width, height, model, demand, modelCount, circleRadiusM, pixelWidthM, pixelHeightM };
}

/** Validate every gap against original imagery, then publish all donor copies together. */
export function repairSurfaceGaps(input: { bytes: Uint8Array; covered: Uint8Array; domain: SurfaceCoverageDomain; grassSensitivity?: number; signal?: AbortSignal }): { repaired: number; missing: number } {
  const { bytes, covered, domain, signal } = input, { width, height, model, pixelWidthM, pixelHeightM, circleRadiusM } = domain;
  signal?.throwIfAborted(); validGrid(width, height, pixelWidthM, pixelHeightM);
  if (!(bytes instanceof Uint8Array) || !(covered instanceof Uint8Array) || !(model instanceof Uint8Array)
    || bytes.length !== width * height * 3 || covered.length !== width * height || model.length !== covered.length
    || !Number.isFinite(circleRadiusM) || circleRadiusM <= 0)
    imageFail('IMAGE_REQUEST_INVALID', '模型地表影像覆盖记录无效');
  const gaps: number[] = []; let modelCount = 0;
  for (let index = 0; index < model.length; index++) {
    if ((index & 4095) === 0) signal?.throwIfAborted();
    if (model[index]) { modelCount++; if (!covered[index]) gaps.push(index); }
  }
  if (modelCount !== domain.modelCount || !modelCount) imageFail('IMAGE_REQUEST_INVALID', '模型地表影像覆盖总数无效');
  const missing = gaps.length;
  if (!missing) return { repaired: 0, missing: 0 };
  const fail = (reason: string): never => imageFail('IMAGE_COVERAGE_INSUFFICIENT',
    `夏季覆盖不足：模型内仍有 ${missing} 个无效像元（${(100 * missing / modelCount).toFixed(6)}%）；${reason}；请重试、缩小取景范围或本地导入`);
  if (missing * 100 >= modelCount) fail('模型内缺口比例必须小于 1%');
  const stride = width + 1, modelPrefix = new Uint32Array(stride * height), missingPrefix = new Uint32Array(stride * height);
  for (let row = 0; row < height; row++) {
    if ((row & 31) === 0) signal?.throwIfAborted();
    const offset = row * width, prefixOffset = row * stride;
    for (let column = 0; column < width; column++) {
      const index = offset + column, next = prefixOffset + column + 1;
      modelPrefix[next] = modelPrefix[next - 1] + (model[index] ? 1 : 0);
      missingPrefix[next] = missingPrefix[next - 1] + (model[index] && !covered[index] ? 1 : 0);
    }
  }
  const isGrass = createGrassPixelClassifier(input.grassSensitivity ?? 50), proposals: Array<{ index: number; donor: number }> = [];
  const rowRadius = Math.floor(circleRadiusM / pixelHeightM + EPSILON), radiusSquared = circleRadiusM * circleRadiusM;
  for (const index of gaps) {
    signal?.throwIfAborted(); const row = Math.floor(index / width), column = index % width;
    let localModel = 0, localMissing = 0;
    for (let neighborRow = Math.max(0, row - rowRadius); neighborRow <= Math.min(height - 1, row + rowRadius); neighborRow++) {
      const dy = (neighborRow - row) * pixelHeightM;
      const halfWidth = Math.floor(Math.sqrt(Math.max(0, radiusSquared - dy * dy)) / pixelWidthM + EPSILON);
      const first = neighborRow * stride + Math.max(0, column - halfWidth), last = neighborRow * stride + Math.min(width - 1, column + halfWidth) + 1;
      localModel += modelPrefix[last] - modelPrefix[first]; localMissing += missingPrefix[last] - missingPrefix[first];
    }
    if (localMissing * 100 >= localModel) fail('局部圆形邻域内的缺口比例必须小于 1%（按模型内有效范围计算）');
    let grassVotes = 0, rockVotes = 0, grassDonor = -1, rockDonor = -1, grassDistance = Infinity, rockDistance = Infinity;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const distance = dx * dx + dy * dy, neighborRow = row + dy, neighborColumn = column + dx;
      if (distance > 9 || neighborRow < 0 || neighborRow >= height || neighborColumn < 0 || neighborColumn >= width) continue;
      const neighbor = neighborRow * width + neighborColumn;
      if (!model[neighbor] || !covered[neighbor]) continue;
      const offset = neighbor * 3, grass = isGrass({ r: bytes[offset], g: bytes[offset + 1], b: bytes[offset + 2] });
      if (grass) { grassVotes++; if (distance < grassDistance) { grassDistance = distance; grassDonor = neighbor; } }
      else { rockVotes++; if (distance < rockDistance) { rockDistance = distance; rockDonor = neighbor; } }
    }
    if (!grassVotes && !rockVotes) fail('缺口在 3 个影像像元内没有原始有效邻点');
    if (grassVotes === rockVotes) fail('原始有效邻点的草地与山石投票平票，无法确定多数');
    proposals.push({ index, donor: grassVotes > rockVotes ? grassDonor : rockDonor });
  }
  signal?.throwIfAborted();
  // Nothing above changes bytes/covered: filled pixels cannot vote, and any failure is atomic.
  for (const { index, donor } of proposals) { bytes.set(bytes.subarray(donor * 3, donor * 3 + 3), index * 3); covered[index] = 1; }
  return { repaired: proposals.length, missing };
}
