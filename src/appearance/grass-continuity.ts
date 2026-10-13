import { AppearanceError, validateColorImageMetadata } from './palette.js';
import type { AppearanceMesh, AppearanceSelection, ColorImage, GrassContinuityMask } from './types.js';

type Pixel = NonNullable<ReturnType<ColorImage['sample']>>;
const R = 6378137, RAD = Math.PI / 180;
const GRID_MM = .25, MAX_GRID_AXIS = 1024;
const INVALID = 0, GRASS = 1, ROCK = 2, PROTECTED = 3;
const SAMPLE_OFFSETS = [[0, 0], [-.5, -.5], [0, -.5], [.5, -.5], [-.5, 0], [.5, 0], [-.5, .5], [0, .5], [.5, .5]] as const;
const EMPTY_MASK: GrassContinuityMask = Object.freeze({ shouldFill: () => false });

export function validateGrassContinuity(value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
    throw new AppearanceError('APPEARANCE_OPTIONS_INVALID', '草地连片强度须在 0–100 之间');
}

export function createGrassPixelClassifier(grassSensitivity: number): (pixel: Pixel) => boolean {
  if (typeof grassSensitivity !== 'number' || !Number.isFinite(grassSensitivity) || grassSensitivity < 0 || grassSensitivity > 100)
    throw new AppearanceError('APPEARANCE_OPTIONS_INVALID', '草地识别灵敏度须在 0–100 之间');
  // At 50 these remain exactly the original RGB thresholds.
  const strictness = (50 - grassSensitivity) / 50;
  const minimumGreen = 40 + 20 * strictness, redDifference = 15 + 12 * strictness, blueDifference = 10 + 8 * strictness;
  const redRatio = 1.15 + .13 * strictness, blueRatio = 1.10 + .09 * strictness;
  return pixel => pixel.g >= minimumGreen && pixel.g - pixel.r >= redDifference && pixel.g - pixel.b >= blueDifference
    && pixel.g >= pixel.r * redRatio && pixel.g >= pixel.b * blueRatio;
}

export function isValidColorPixel(pixel: ReturnType<ColorImage['sample']>): pixel is Pixel {
  return !!pixel && [pixel.r, pixel.g, pixel.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255);
}

/** Protect conspicuous blue and bright near-neutral imagery; this is only an RGB heuristic. */
export function isProtectedContinuityPixel(pixel: Pixel): boolean {
  const blue = pixel.b >= 90 && pixel.b - pixel.r >= 25 && pixel.b - pixel.g >= 20;
  const white = Math.min(pixel.r, pixel.g, pixel.b) >= 210
    && Math.max(pixel.r, pixel.g, pixel.b) - Math.min(pixel.r, pixel.g, pixel.b) <= 30;
  return blue || white;
}

export function validateAppearanceMeshSelection(mesh: AppearanceMesh, selection: AppearanceSelection): void {
  if (!mesh || !mesh.positions || !mesh.indices || mesh.positions.length < 9 || mesh.positions.length % 3 !== 0
    || mesh.indices.length < 3 || mesh.indices.length % 3 !== 0)
    throw new AppearanceError('APPEARANCE_MESH_INVALID', '外观网格坐标或三角面无效');
  if (mesh.faceKinds !== undefined && mesh.faceKinds.length !== mesh.indices.length / 3)
    throw new AppearanceError('APPEARANCE_MESH_INVALID', '外观网格面标签数量无效');
  for (let i = 0; i < mesh.positions.length; i++) if (!Number.isFinite(mesh.positions[i]))
    throw new AppearanceError('APPEARANCE_MESH_INVALID', '外观网格含无效坐标');
  for (let i = 0; i < mesh.indices.length; i++) if (!Number.isSafeInteger(mesh.indices[i]) || mesh.indices[i] < 0 || mesh.indices[i] >= mesh.positions.length / 3)
    throw new AppearanceError('APPEARANCE_MESH_INVALID', '外观网格含无效三角面索引');
  const center = selection?.center;
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon) || Math.abs(center.lat) > 80 || Math.abs(center.lon) > 180
    || !Number.isFinite(selection.bearingDeg) || !Number.isFinite(selection.mmPerMeter) || selection.mmPerMeter <= 0)
    throw new AppearanceError('APPEARANCE_SELECTION_INVALID', '外观取景的坐标、角度或比例无效');
}

export function createModelColorSampler(selection: AppearanceSelection, image: ColorImage): (xMm: number, yMm: number) => ReturnType<ColorImage['sample']> {
  const angle = selection.bearingDeg * RAD, c = Math.cos(angle), s = Math.sin(angle), cosLat = Math.cos(selection.center.lat * RAD);
  const originX = R * selection.center.lon * RAD, originY = R * Math.log(Math.tan(Math.PI / 4 + selection.center.lat * RAD / 2));
  return (x, y) => {
    const gx = x / selection.mmPerMeter, gy = y / selection.mmPerMeter;
    const mx = originX + (c * gx + s * gy) / cosLat, my = originY + (-s * gx + c * gy) / cosLat;
    return image.sample((2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / RAD, mx / R / RAD);
  };
}

/**
 * Build a bounded top-view mask from the original image over the whole mesh XY extent.
 * The grid spacing depends on model millimetres, never on the triangle count or visible
 * terrain faces. All nondegenerate face projections, including the bottom, define the
 * footprint so snow and route cropping retain their surrounding image context. Reuse
 * this mask for the final mesh and every terrain material part.
 *
 * Each cell samples its centre, corners and edge midpoints. Any invalid or protected
 * sample rejects it; any remaining rock sample keeps it in the original rock topology.
 * One pass evaluates complete eight-connected rock components: at 50, area <= 1 mm²,
 * short side <= 1 mm and long side <= 2 mm; at 100 those limits are 4 mm², 2 mm and 4 mm.
 * Area counts every touched rock cell conservatively, including partial edge coverage,
 * so large regions cannot be underestimated. Every surrounding cell must be original grass.
 * Filled cells never become evidence for another fill, and regions touching the extent
 * or protected pixels remain. Sampling is bounded by nine points per cell.
 */
export function createGrassContinuityMask(mesh: AppearanceMesh, selection: AppearanceSelection, image?: ColorImage,
  grassSensitivity = 50, grassContinuity = 50): GrassContinuityMask {
  const isGrass = createGrassPixelClassifier(grassSensitivity);
  validateGrassContinuity(grassContinuity);
  validateAppearanceMeshSelection(mesh, selection);
  if (image) {
    validateColorImageMetadata(image.metadata);
    if (typeof image.sample !== 'function') throw new AppearanceError('APPEARANCE_IMAGE_COVERAGE', '地表影像没有有效像元采样器');
  }
  if (!image || grassContinuity === 0) return EMPTY_MASK;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]); maxX = Math.max(maxX, mesh.positions[i]);
    minY = Math.min(minY, mesh.positions[i + 1]); maxY = Math.max(maxY, mesh.positions[i + 1]);
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  if (spanX <= 0 || spanY <= 0 || !Number.isFinite(spanX) || !Number.isFinite(spanY)) return EMPTY_MASK;
  const columns = Math.min(MAX_GRID_AXIS, Math.ceil(spanX / GRID_MM));
  const rows = Math.min(MAX_GRID_AXIS, Math.ceil(spanY / GRID_MM));
  const stepX = spanX / columns, stepY = spanY / rows, cellArea = stepX * stepY, count = columns * rows;
  const original = new Uint8Array(count), fill = new Uint8Array(count);
  const coveredXY = new Uint8Array(count);
  let coveredCount = 0;
  // Rasterize the true interval cut by each grid row through a projected triangle.
  // Scanning its whole XY box is costly for the long thin triangles from clipping.
  // The union includes bottom and covered surfaces; visible terrain alone would
  // cut holes under snow. Once every cell is covered, later faces cannot change it.
  for (let face = 0; face < mesh.indices.length; face += 3) {
    if (coveredCount === count) break;
    const a = mesh.indices[face] * 3, b = mesh.indices[face + 1] * 3, c = mesh.indices[face + 2] * 3;
    const ax = mesh.positions[a], ay = mesh.positions[a + 1], bx = mesh.positions[b], by = mesh.positions[b + 1];
    const cx = mesh.positions[c], cy = mesh.positions[c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0 || !Number.isFinite(area)) continue;
    const low = Math.max(0, Math.ceil((Math.min(ay, by, cy) - minY) / stepY - .5 - 1e-10));
    const high = Math.min(rows - 1, Math.floor((Math.max(ay, by, cy) - minY) / stepY - .5 + 1e-10));
    const xs = [ax, bx, cx], ys = [ay, by, cy], toleranceY = stepY * 1e-10;
    for (let row = low; row <= high; row++) {
      const y = minY + (row + .5) * stepY;
      let firstX = Infinity, lastX = -Infinity;
      for (let edge = 0; edge < 3; edge++) {
        const next = (edge + 1) % 3, y0 = ys[edge], y1 = ys[next];
        if (y < Math.min(y0, y1) - toleranceY || y > Math.max(y0, y1) + toleranceY) continue;
        if (y0 === y1) {
          firstX = Math.min(firstX, xs[edge], xs[next]); lastX = Math.max(lastX, xs[edge], xs[next]);
        } else {
          const x = xs[edge] + (y - y0) / (y1 - y0) * (xs[next] - xs[edge]);
          firstX = Math.min(firstX, x); lastX = Math.max(lastX, x);
        }
      }
      const left = Math.max(0, Math.ceil((firstX - minX) / stepX - .5 - 1e-10));
      const right = Math.min(columns - 1, Math.floor((lastX - minX) / stepX - .5 + 1e-10));
      for (let column = left; column <= right; column++) {
        const index = row * columns + column;
        if (!coveredXY[index]) { coveredXY[index] = 1; coveredCount++; }
      }
    }
  }
  const sample = createModelColorSampler(selection, image);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const index = row * columns + column;
    if (!coveredXY[index]) continue;
    let classification = GRASS;
    for (const [dx, dy] of SAMPLE_OFFSETS) {
      const pixel = sample(minX + (column + .5 + dx) * stepX, minY + (row + .5 + dy) * stepY);
      if (!isValidColorPixel(pixel)) { classification = INVALID; break; }
      // A near-white pixel may also pass broad greenness. It cannot supply evidence
      // for continuity, although direct face RGB classification remains compatible.
      if (isProtectedContinuityPixel(pixel)) { classification = PROTECTED; break; }
      if (!isGrass(pixel)) classification = ROCK;
    }
    original[index] = classification;
  }

  const maxWidth = grassContinuity / 50, maxArea = maxWidth * maxWidth, maxLength = 2 * maxWidth;
  const visited = new Uint8Array(count), queue = new Int32Array(count);
  for (let seed = 0; seed < count; seed++) {
    if (original[seed] !== ROCK || visited[seed]) continue;
    let head = 0, tail = 1, west = columns, east = -1, south = rows, north = -1, enclosedByGrass = true;
    queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const index = queue[head++], column = index % columns, row = Math.floor(index / columns);
      west = Math.min(west, column); east = Math.max(east, column);
      south = Math.min(south, row); north = Math.max(north, row);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = column + dx, y = row + dy;
        if (x < 0 || y < 0 || x >= columns || y >= rows) { enclosedByGrass = false; continue; }
        const neighbour = y * columns + x;
        if (original[neighbour] === ROCK) {
          if (!visited[neighbour]) { visited[neighbour] = 1; queue[tail++] = neighbour; }
        } else if (original[neighbour] !== GRASS) enclosedByGrass = false;
      }
    }
    const width = (east - west + 1) * stepX, height = (north - south + 1) * stepY;
    if (enclosedByGrass && tail * cellArea <= maxArea + 1e-9 && Math.min(width, height) <= maxWidth + 1e-9
      && Math.max(width, height) <= maxLength + 1e-9) {
      for (let i = 0; i < tail; i++) fill[queue[i]] = 1;
    }
  }
  return Object.freeze({ shouldFill(xMm: number, yMm: number): boolean {
    if (!Number.isFinite(xMm) || !Number.isFinite(yMm) || xMm < minX || xMm >= maxX || yMm < minY || yMm >= maxY) return false;
    const column = Math.floor((xMm - minX) / stepX), row = Math.floor((yMm - minY) / stepY);
    return fill[row * columns + column] === 1;
  } });
}
