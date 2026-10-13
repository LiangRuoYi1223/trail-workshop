import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/index.js';
import type { AppearanceMesh, ColorImage } from '../src/appearance/types.js';

const options = { maxColors: 4 as const, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
const selection = { center: { lat: 0, lon: 0 }, bearingDeg: 0, mmPerMeter: 1 };
const green = { r: 40, g: 140, b: 40 }, rock = { r: 120, g: 110, b: 100 };
const metadata = { sha256: 'b'.repeat(64), byteLength: 1000, width: 32, height: 32,
  bounds: { west: -1, south: -1, east: 1, north: 1 }, crs: 'EPSG:4326' as const, pixelIsArea: true };
const build = core.buildModelAppearance, createMask = core.createGrassContinuityMask;

function image(pixel: (xMm: number, yMm: number) => ReturnType<ColorImage['sample']>): ColorImage {
  // At the equator with bearing zero and mmPerMeter=1, inverse Mercator gives the model coordinates.
  return { metadata, sample(lat, lon) {
    return pixel(6378137 * lon * Math.PI / 180,
      6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)));
  } };
}
function squareMesh(divisions = 1, size = 8): AppearanceMesh {
  const positions: number[] = [], indices: number[] = [];
  for (let y = 0; y <= divisions; y++) for (let x = 0; x <= divisions; x++) positions.push(x * size / divisions, y * size / divisions, 2);
  for (let y = 0; y < divisions; y++) for (let x = 0; x < divisions; x++) {
    const a = y * (divisions + 1) + x, b = a + 1, c = a + divisions + 1, d = c + 1;
    indices.push(a, b, d, a, d, c);
  }
  return { positions, indices };
}
function probeMesh(kinds: NonNullable<AppearanceMesh['faceKinds']> = ['terrain']): AppearanceMesh {
  const base = squareMesh();
  return { positions: [...Array.from(base.positions), 3.94, 3.94, 2, 4.12, 3.94, 2, 3.94, 4.12, 2],
    indices: [...Array.from(base.indices), ...kinds.flatMap(() => [4, 5, 6])],
    faceKinds: ['terrain', 'terrain', ...kinds] };
}
function squareHole(width: number): ColorImage {
  return image((x, y) => Math.abs(x - 4) < width / 2 && Math.abs(y - 4) < width / 2 ? rock : green);
}

test('continuity fills a small gray hole while the five-argument and zero settings retain the original rock', () => {
  const mesh = probeMesh(), before = structuredClone(mesh), source = squareHole(.5);
  assert.deepEqual(build(mesh, selection, options, source, 50).faceClasses, ['grass', 'grass', 'rock']);
  assert.deepEqual(build(mesh, selection, options, source, 50, 0).faceClasses, ['grass', 'grass', 'rock']);
  assert.deepEqual(build(mesh, selection, options, source, 50, 50).faceClasses, ['grass', 'grass', 'grass']);
  assert.deepEqual(mesh, before);
});

test('higher continuity admits a larger enclosed patch and still retains a broad rock area', () => {
  const mesh = probeMesh();
  assert.equal(build(mesh, selection, options, squareHole(1.5), 50, 50).faceClasses[2], 'rock');
  assert.equal(build(mesh, selection, options, squareHole(1.5), 50, 100).faceClasses[2], 'grass');
  assert.equal(build(mesh, selection, options, squareHole(.75), 50, 100).faceClasses[2], 'grass');
  assert.equal(build(mesh, selection, options, squareHole(3), 50, 100).faceClasses[2], 'rock');
  // Preserve a broad rectangle, and a narrower one whose sampled bounds fit while its area does not.
  const excessArea = image((x, y) => Math.abs(x - 4) < 1 && Math.abs(y - 4) < 1.5 ? rock : green);
  assert.equal(build(mesh, selection, options, excessArea, 50, 100).faceClasses[2], 'rock');
  const narrowExcessArea = image((x, y) => Math.abs(x - 4) < .75 && Math.abs(y - 4) < 1.5 ? rock : green);
  assert.equal(build(mesh, selection, options, narrowExcessArea, 50, 100).faceClasses[2], 'rock');
  const joinedMountain = image((x, y) => Math.abs(x - 4) < .25 && Math.abs(y - 4) < .25
    || x >= 4 && x < 5.5 && Math.abs(y - 4) < .13
    || x > 5.25 && x < 7.5 && y > 2.5 && y < 5.5 ? rock : green);
  assert.equal(build(mesh, selection, options, joinedMountain, 50, 100).faceClasses[2], 'rock');
});

test('short grass-rock-grass gaps fill, while a long narrow rock band survives at maximum continuity', () => {
  const verticalGap = image((x, y) => Math.abs(x - 4) < .25 && Math.abs(y - 4) < .5 ? rock : green);
  const horizontalGap = image((x, y) => Math.abs(x - 4) < .5 && Math.abs(y - 4) < .25 ? rock : green);
  const longBand = image((x, y) => Math.abs(x - 4) < .25 && y > 1 && y < 7 ? rock : green);
  assert.equal(build(probeMesh(), selection, options, verticalGap, 50, 50).faceClasses[2], 'grass');
  assert.equal(build(probeMesh(), selection, options, horizontalGap, 50, 50).faceClasses[2], 'grass');
  assert.equal(build(probeMesh(), selection, options, longBand, 50, 100).faceClasses[2], 'rock');
});

test('the shared millimetre mask gives identical decisions with coarse and fine triangulation and separate material parts', () => {
  const source = squareHole(.5), coarse = createMask(squareMesh(), selection, source), fine = createMask(squareMesh(32), selection, source);
  for (const [x, y, expected] of [[4, 4, true], [3, 4, false], [0, 0, false], [-1, 4, false]] as const) {
    assert.equal(coarse.shouldFill(x, y), expected);
    assert.equal(fine.shouldFill(x, y), expected);
  }
  const standalonePart: AppearanceMesh = { positions: [3.94, 3.94, 2, 4.12, 3.94, 2, 3.94, 4.12, 2], indices: [0, 1, 2] };
  assert.equal(build(standalonePart, selection, options, source, 50, 50, coarse).faceClasses[0], 'grass');
  assert.equal(build(probeMesh(), selection, options, source, 50, 50, coarse).faceClasses[2], 'grass');
  assert.equal(build(standalonePart, selection, options, source, 50, 0, coarse).faceClasses[0], 'rock');
});

test('continuity keeps original grass and protected geometry classes, including snow and route walls', () => {
  const source = squareHole(.5), mask = createMask(squareMesh(), selection, source);
  const mesh = probeMesh(['terrain', 'route', 'route-wall', 'snow', 'snow-wall', 'frame', 'wall', 'bottom']);
  assert.deepEqual(build(mesh, selection, options, source, 50, 100, mask).faceClasses,
    ['grass', 'grass', 'grass', 'route', 'route', 'snow', 'snow', 'rock', 'rock', 'rock']);
  const protectedOnly: AppearanceMesh = { positions: [0, 0, 0, 8, 0, 0, 0, 8, 0], indices: [0, 1, 2], faceKinds: ['route'] };
  assert.deepEqual(build(protectedOnly, selection, options, image(() => { throw new Error('protected image sampled'); }), 50, 100).faceClasses, ['route']);
});

test('strong blue and bright neutral imagery stays rock even with a shared mask requesting fill', () => {
  const fillEverywhere: core.GrassContinuityMask = { shouldFill: () => true };
  for (const pixel of [{ r: 10, g: 70, b: 220 }, { r: 240, g: 240, b: 240 }]) {
    assert.equal(build(probeMesh(), selection, options, image(() => pixel), 50, 100, fillEverywhere).faceClasses[2], 'rock');
    const protectedHole = image((x, y) => Math.abs(x - 4) < .25 && Math.abs(y - 4) < .25 ? pixel : green);
    assert.equal(createMask(squareMesh(), selection, protectedHole, 50, 100).shouldFill(4, 4), false);
  }
});

test('near-white pixels cannot supply surrounding grass evidence even at maximum sensitivity', () => {
  const nearWhite = { r: 220, g: 230, b: 220 };
  const source = image((x, y) => Math.abs(x - 4) < .25 && Math.abs(y - 4) < .25 ? rock : nearWhite);
  // Keep the established direct RGB classification while refusing white as filling evidence.
  assert.deepEqual(build(probeMesh(), selection, options, source, 100, 0).faceClasses, ['grass', 'grass', 'rock']);
  assert.equal(createMask(squareMesh(), selection, source, 100, 50).shouldFill(4, 4), false);
  assert.equal(build(probeMesh(), selection, options, source, 100, 50).faceClasses[2], 'rock');
});

for (const [size, startX, startY, width] of [[8, 1, 2, .2], [500, 101, 102, .4]] as const) {
  test(`narrow diagonal rock bands remain continuous and unfilled on the ${size}mm model grid`, () => {
    const source = image((x, y) => x >= startX && x <= startX + 6
      && Math.abs(y - (startY + .4 * (x - startX))) / Math.sqrt(1.16) <= width / 2 ? rock : green);
    const mask = createMask(squareMesh(1, size), selection, source, 50, 100);
    for (let i = 0; i < 120; i++) {
      const x = startX + 6 * (i + .5) / 120, y = startY + .4 * (x - startX);
      assert.equal(mask.shouldFill(x, y), false, `${size}mm model, rock band at (${x}, ${y})`);
    }
  });
}

test('missing, invalid and incomplete imagery supplies no filling evidence', () => {
  assert.deepEqual(build(probeMesh(), selection, options, undefined, 50, 100).faceClasses, ['grass', 'grass', 'grass']);
  assert.equal(createMask(squareMesh(), selection, undefined, 50, 100).shouldFill(4, 4), false);
  for (const pixel of [null, { r: NaN, g: 255, b: 0 }, { r: 20, g: 80, b: 256 }]) {
    assert.equal(createMask(squareMesh(), selection, image(() => pixel), 50, 100).shouldFill(4, 4), false);
  }
  const incomplete = image((x, y) => Math.abs(x - 4) < .25 && Math.abs(y - 4) < .25 ? rock
    : Math.abs(x - 4) < .5 && Math.abs(y - 4) < .5 ? null : green);
  assert.equal(createMask(squareMesh(), selection, incomplete, 50, 100).shouldFill(4, 4), false);
});

test('footprint edges stay rock and snow or route faces retain the complete sampling context', () => {
  const triangular: AppearanceMesh = { positions: [0, 0, 2, 8, 0, 2, 0, 8, 2], indices: [0, 1, 2], faceKinds: ['bottom'] };
  const edgePatch = image((x, y) => Math.abs(x - 3.9) < .25 && Math.abs(y - 3.9) < .25 ? rock : green);
  assert.equal(createMask(triangular, selection, edgePatch, 50, 100).shouldFill(3.9, 3.9), false);
  const croppedTerrain = { ...squareMesh(), faceKinds: ['snow', 'route'] as const };
  assert.equal(createMask(croppedTerrain, selection, squareHole(.5), 50, 50).shouldFill(4, 4), true);
  const bboxEdge = image((x, y) => x < .5 && Math.abs(y - 4) < .25 ? rock : green);
  assert.equal(createMask(squareMesh(), selection, bboxEdge, 50, 100).shouldFill(.25, 4), false);
});

test('continuity rejects invalid settings before image sampling', () => {
  for (const value of [NaN, Infinity, -1, 101, '50', null, true]) {
    const source = image(() => { throw new Error('invalid continuity sampled imagery'); });
    assert.throws(() => build(probeMesh(), selection, options, source, 50, value as number),
      { name: 'AppearanceError', code: 'APPEARANCE_OPTIONS_INVALID' });
    assert.throws(() => createMask(squareMesh(), selection, source, 50, value as number),
      { name: 'AppearanceError', code: 'APPEARANCE_OPTIONS_INVALID' });
  }
});

test('the continuity sampler stays bounded for models above the nominal quarter-millimetre grid extent', () => {
  const large: AppearanceMesh = { positions: [0, 0, 0, 1000, 0, 0, 1000, 1000, 0, 0, 1000, 0], indices: [0, 1, 2, 0, 2, 3] };
  let samples = 0;
  const mask = createMask(large, selection, image(() => { samples++; return green; }), 50, 100);
  assert.ok(samples > 0 && samples <= 9 * 1024 * 1024);
  assert.equal(mask.shouldFill(500, 500), false);
});
