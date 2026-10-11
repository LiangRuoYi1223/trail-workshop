// Adapted from baozjj/TrailPrint-3D @ f8909baed1152d01b20eb76bc666ff20f457b38d; MIT, Copyright (c) 2026 baozj. See THIRD_PARTY_NOTICES.md.
import type {
  TerrainCropRegion,
  TerrainHeightPreview,
  TerrainMeshPayload,
} from "./types.js";
import type { Vec2 } from "./mesh-clip.js";
import { buildClippedHeightfieldMesh } from "./clipped-heightfield.js";
export { getHeightfieldSampleWeights, estimateTriangleCount, MAX_MESH_TRIANGLES } from "./clipped-heightfield.js";
import { cornerRadiusFromCrop } from "./rounded-footprint.js";

/** 模型平面 (mm) 双线性采样高度场 */
export function sampleHeightBilinearMm(
  xMm: number,
  yMm: number,
  heightMm: ArrayLike<number>,
  cols: number,
  rows: number,
  crop: TerrainCropRegion,
  fallback = 0,
): number {
  const hw = crop.widthMm / 2;
  const hh = crop.heightMm / 2;
  const s = ((xMm + hw) / Math.max(crop.widthMm, 1e-6)) * (cols - 1);
  const t = ((yMm + hh) / Math.max(crop.heightMm, 1e-6)) * (rows - 1);
  const colF = Math.max(0, Math.min(cols - 1, s));
  const rowF = Math.max(0, Math.min(rows - 1, t));
  const c0 = Math.floor(colF);
  const r0 = Math.floor(rowF);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fc = colF - c0;
  const fr = rowF - r0;
  const read = (row: number, col: number): number => {
    const v = heightMm[row * cols + col]!;
    return Number.isFinite(v) ? v : fallback;
  };
  const z00 = read(r0, c0);
  const z10 = read(r0, c1);
  const z01 = read(r1, c0);
  const z11 = read(r1, c1);
  const z0 = z00 * (1 - fc) + z10 * fc;
  const z1 = z01 * (1 - fc) + z11 * fc;
  return z0 * (1 - fr) + z1 * fr;
}

function gridCornerMm(
  crop: TerrainCropRegion,
  row: number,
  col: number,
  rows: number,
  cols: number,
): Vec2 {
  const s = cols <= 1 ? 0.5 : col / (cols - 1);
  const t = rows <= 1 ? 0.5 : row / (rows - 1);
  return {
    x: -crop.widthMm / 2 + crop.widthMm * s,
    y: -crop.heightMm / 2 + crop.heightMm * t,
  };
}

function surfaceZ(
  x: number,
  y: number,
  heightMm: ArrayLike<number>,
  cols: number,
  rows: number,
  crop: TerrainCropRegion,
  minSurface: number,
): number {
  return sampleHeightBilinearMm(x, y, heightMm, cols, rows, crop, minSurface);
}

/** 矩形：规则方格，四角均在轮廓内 */
function buildRectGridMesh(
  crop: TerrainCropRegion,
  heightMm: ArrayLike<number>,
  cols: number,
  rows: number,
  baseThicknessMm: number,
  minSurface: number,
): TerrainMeshPayload {
  const bottomZ = -baseThicknessMm;
  const positions: number[] = [];
  const indices: number[] = [];
  const topIdx = new Int32Array(rows * cols);
  const botIdx = new Int32Array(rows * cols);

  function push(x: number, y: number, z: number): number {
    const i = positions.length / 3;
    positions.push(x, y, z);
    return i;
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const { x, y } = gridCornerMm(crop, row, col, rows, cols);
      const z = surfaceZ(x, y, heightMm, cols, rows, crop, minSurface);
      topIdx[row * cols + col] = push(x, y, z);
      botIdx[row * cols + col] = push(x, y, bottomZ);
    }
  }

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const i00 = topIdx[row * cols + col]!;
      const i10 = topIdx[row * cols + col + 1]!;
      const i01 = topIdx[(row + 1) * cols + col]!;
      const i11 = topIdx[(row + 1) * cols + col + 1]!;
      indices.push(i00, i10, i01, i10, i11, i01);

      const b00 = botIdx[row * cols + col]!;
      const b10 = botIdx[row * cols + col + 1]!;
      const b01 = botIdx[(row + 1) * cols + col]!;
      const b11 = botIdx[(row + 1) * cols + col + 1]!;
      indices.push(b00, b01, b10, b10, b01, b11);
    }
  }

  function wallStrip(
    topA: number,
    topB: number,
    botA: number,
    botB: number,
  ): void {
    // A -> B follows the top perimeter counterclockwise, so this wall faces outward.
    indices.push(botA, botB, topB, botA, topB, topA);
  }

  for (let row = 0; row < rows - 1; row++) {
    wallStrip(
      topIdx[(row + 1) * cols]!,
      topIdx[row * cols]!,
      botIdx[(row + 1) * cols]!,
      botIdx[row * cols]!,
    );
    wallStrip(
      topIdx[row * cols + cols - 1]!,
      topIdx[(row + 1) * cols + cols - 1]!,
      botIdx[row * cols + cols - 1]!,
      botIdx[(row + 1) * cols + cols - 1]!,
    );
  }
  for (let col = 0; col < cols - 1; col++) {
    wallStrip(
      topIdx[col]!,
      topIdx[col + 1]!,
      botIdx[col]!,
      botIdx[col + 1]!,
    );
    wallStrip(
      topIdx[(rows - 1) * cols + col + 1]!,
      topIdx[(rows - 1) * cols + col]!,
      botIdx[(rows - 1) * cols + col + 1]!,
      botIdx[(rows - 1) * cols + col]!,
    );
  }

  return {
    positions,
    indices,
    minSurfaceZ: minSurface,
    bottomZ,
    gridCols: cols,
    gridRows: rows,
  };
}

/**
 * 由 DEM 高度场生成封闭实心山体。
 * 普通矩形保持原规则网格；其他形状裁剪同一 XY 三角网格，保留 DEM 峰值并封侧壁。
 */
export function buildHeightfieldTerrainMesh(
  crop: TerrainCropRegion,
  heightMm: ArrayLike<number>,
  cols: number,
  rows: number,
  baseThicknessMm: number,
): TerrainMeshPayload {
  let minSurface = Infinity;
  for (let i = 0; i < cols * rows; i++) {
    const h = heightMm[i]!;
    if (Number.isFinite(h) && h < minSurface) minSurface = h;
  }
  if (!Number.isFinite(minSurface)) minSurface = 0;

  if (crop.shape === "rectangle" && cornerRadiusFromCrop(crop) <= 1e-6) {
    return buildRectGridMesh(crop, heightMm, cols, rows, baseThicknessMm, minSurface);
  }
  return buildClippedHeightfieldMesh(crop, heightMm, cols, rows, baseThicknessMm, minSurface);
}

export function minHeightFieldMm(heightMm: ArrayLike<number>): number {
  let min = Infinity;
  for (let i = 0; i < heightMm.length; i++) {
    const v = heightMm[i]!;
    if (Number.isFinite(v) && v < min) min = v;
  }
  return Number.isFinite(min) ? min : 0;
}

export function heightPreviewFromField(
  heightMm: Float64Array,
  cols: number,
  rows: number,
  baseThicknessMm: number,
  minSurfaceZ?: number,
): TerrainHeightPreview {
  return {
    cols,
    rows,
    heights: heightMm,
    minSurfaceZ: minSurfaceZ ?? minHeightFieldMm(heightMm),
    bottomZ: -baseThicknessMm,
    baseThicknessMm,
  };
}

