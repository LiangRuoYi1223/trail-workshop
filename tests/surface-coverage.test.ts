import assert from 'node:assert/strict';
import test from 'node:test';
import { createSurfaceCoverageDomain, repairSurfaceGaps, type SurfaceCoverageDomain } from '../src/appearance/surface-coverage.js';

const grass = [30, 140, 40] as const, rock = [100, 100, 100] as const;
const rectangle = (width: number, height: number) => [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
function fullDomain(width = 200, height = width, pixelWidthM = 20, pixelHeightM = pixelWidthM): SurfaceCoverageDomain {
  return createSurfaceCoverageDomain({ width, height, polygon: rectangle(width, height), pixelWidthM, pixelHeightM });
}
function imagery(domain: SurfaceCoverageDomain, color: readonly number[] = grass) {
  const bytes = new Uint8Array(domain.width * domain.height * 3), covered = new Uint8Array(domain.width * domain.height).fill(1);
  for (let i = 0; i < covered.length; i++) bytes.set(color, i * 3);
  return { bytes, covered, domain };
}
function gap(input: ReturnType<typeof imagery>, row: number, column: number): number {
  const index = row * input.domain.width + column;
  input.covered[index] = 0; input.bytes.fill(0, index * 3, index * 3 + 3); return index;
}
function coverageFailure(run: () => unknown, reason?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'IMAGE_COVERAGE_INSUFFICIENT');
    if (reason) assert.match((error as Error).message, reason);
    return true;
  });
}

test('polygon coverage retains thin intersected cells even when their centers are outside', () => {
  const domain = createSurfaceCoverageDomain({ width: 7, height: 7, pixelWidthM: 10, pixelHeightM: 20,
    polygon: [{ x: 1.2, y: 2.1 }, { x: 4.8, y: 2.1 }, { x: 1.2, y: 2.2 }] });
  assert.equal(domain.modelCount, 4);
  assert.deepEqual([...domain.model.entries()].filter(([, value]) => value).map(([index]) => index), [15, 16, 17, 18]);
  assert.ok(Math.abs(domain.circleRadiusM - Math.sqrt(8 / Math.PI)) < 1e-12);
});

test('closed integer polygon boundaries retain touching cells and concave bays remain outside', () => {
  const box = createSurfaceCoverageDomain({ width: 7, height: 7, pixelWidthM: 1, pixelHeightM: 1,
    polygon: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }] });
  assert.equal(box.modelCount, 16); assert.equal(box.model[8], 1); assert.equal(box.model[32], 1);
  const polygon = [{ x: 1.2, y: 1.2 }, { x: 5.8, y: 1.2 }, { x: 5.8, y: 2.8 }, { x: 2.8, y: 2.8 }, { x: 2.8, y: 5.8 }, { x: 1.2, y: 5.8 }];
  const domain = createSurfaceCoverageDomain({ width: 7, height: 7, polygon, pixelWidthM: 1, pixelHeightM: 1 });
  assert.equal(domain.modelCount, 16); assert.equal(domain.model[4 * 7 + 4], 0); assert.equal(domain.model[4 * 7 + 2], 1);
  assert.deepEqual(createSurfaceCoverageDomain({ width: 7, height: 7, polygon: [...polygon].reverse(), pixelWidthM: 1, pixelHeightM: 1 }).model, domain.model);
});

test('demand adds a clipped Euclidean two-pixel buffer without adding those cells to the model', () => {
  const domain = createSurfaceCoverageDomain({ width: 15, height: 15, polygon: [{ x: 6.1, y: 6.1 }, { x: 8.9, y: 6.1 }, { x: 8.9, y: 8.9 }, { x: 6.1, y: 8.9 }], pixelWidthM: 10, pixelHeightM: 10 });
  assert.equal(domain.modelCount, 9);
  assert.equal(domain.demand[4 * 15 + 6], 1); assert.equal(domain.demand[5 * 15 + 5], 1);
  assert.equal(domain.demand[4 * 15 + 4], 0); assert.equal(domain.demand[3 * 15 + 6], 0);
  assert.equal(domain.model[4 * 15 + 6], 0);
  const edge = createSurfaceCoverageDomain({ width: 3, height: 3, polygon: [{ x: -.1, y: -.1 }, { x: .9, y: -.1 }, { x: .9, y: .9 }, { x: -.1, y: .9 }], pixelWidthM: 1, pixelHeightM: 1 });
  assert.equal(edge.modelCount, 1); assert.deepEqual([...edge.demand], [1, 1, 1, 1, 1, 0, 1, 0, 0]);
});

test('cloud gaps entirely outside the model never require repair, including missing buffer pixels', () => {
  const domain = createSurfaceCoverageDomain({ width: 30, height: 30, polygon: [{ x: 10.1, y: 10.1 }, { x: 19.9, y: 10.1 }, { x: 19.9, y: 19.9 }, { x: 10.1, y: 19.9 }], pixelWidthM: 20, pixelHeightM: 20 });
  const input = imagery(domain); for (let i = 0; i < input.covered.length; i++) if (!domain.model[i]) { input.covered[i] = 0; input.bytes.fill(0, i * 3, i * 3 + 3); }
  const before = input.bytes.slice(); assert.deepEqual(repairSurfaceGaps(input), { repaired: 0, missing: 0 }); assert.deepEqual(input.bytes, before);
});

test('exactly one percent global model gaps is rejected with a visible count and percentage', () => {
  const input = imagery(fullDomain(100)); for (let row = 0; row < 100; row++) gap(input, row, 50);
  const before = input.bytes.slice(); coverageFailure(() => repairSurfaceGaps(input), /100.*1(?:\.0+)?%/); assert.deepEqual(input.bytes, before);
});

for (const [name, color, nearest] of [['grass', grass, [40, 170, 45]], ['rock', rock, [120, 110, 100]]] as const) {
  test('an isolated model gap copies the nearest original RGB donor in the winning ' + name + ' class', () => {
    const input = imagery(fullDomain(), color), index = gap(input, 100, 100);
    input.bytes.set(nearest, (index - input.domain.width) * 3);
    assert.deepEqual(repairSurfaceGaps(input), { repaired: 1, missing: 1 }); assert.equal(input.covered[index], 1);
    assert.deepEqual([...input.bytes.subarray(index * 3, index * 3 + 3)], nearest);
  });
}

test('local clouds are rejected despite a small global deficit', () => {
  const input = imagery(fullDomain()); for (const [row, column] of [[100, 100], [100, 101], [100, 99], [101, 100], [99, 100]]) gap(input, row, column);
  const before = input.covered.slice(); coverageFailure(() => repairSurfaceGaps(input), /局部/); assert.deepEqual(input.covered, before);
});

test('the local denominator clips the circle to the model at edges', () => {
  const input = imagery(fullDomain()); gap(input, 0, 0); gap(input, 0, 1);
  coverageFailure(() => repairSurfaceGaps(input), /局部/);
});

test('exactly one percent local gaps fails even when the global gap is well below one percent', () => {
  const input = imagery(fullDomain(126)); gap(input, 1, 6);
  // The radius is 7.109 pixels. Clipped row spans contain 14+14+14+13+13+11+11+7+3 = 100 model pixels.
  coverageFailure(() => repairSurfaceGaps(input), /局部/);
});

test('the closest original pixel cannot override the winning grass or rock class', () => {
  const input = imagery(fullDomain(), rock), index = gap(input, 100, 100);
  input.bytes.set(grass, (index - input.domain.width) * 3);
  assert.deepEqual(repairSurfaceGaps(input), { repaired: 1, missing: 1 });
  assert.deepEqual([...input.bytes.subarray(index * 3, index * 3 + 3)], rock);
});

test('valid buffer pixels cannot vote against original model pixels', () => {
  const domain = createSurfaceCoverageDomain({ width: 400, height: 400, polygon: [{ x: 100.1, y: 100.1 }, { x: 299.9, y: 100.1 }, { x: 299.9, y: 299.9 }, { x: 100.1, y: 299.9 }], pixelWidthM: 20, pixelHeightM: 20 });
  const input = imagery(domain, rock);
  for (let index = 0; index < domain.model.length; index++) if (domain.model[index]) input.bytes.set(grass, index * 3);
  const index = gap(input, 100, 100);
  assert.deepEqual(repairSurfaceGaps(input), { repaired: 1, missing: 1 });
  assert.deepEqual([...input.bytes.subarray(index * 3, index * 3 + 3)], grass);
});

test('repair uses the requested grass sensitivity when deciding the original donor majority', () => {
  const input = imagery(fullDomain(), rock), index = gap(input, 100, 100), borderline = [70, 85, 65]; let count = 0;
  for (let row = -3; row <= 3; row++) for (let column = -3; column <= 3; column++) if ((row || column) && row * row + column * column <= 9) {
    input.bytes.set(count++ < 13 ? borderline : rock, (index + row * input.domain.width + column) * 3);
  }
  input.bytes.set(grass, (index + 3 * input.domain.width) * 3);
  coverageFailure(() => repairSurfaceGaps(input), /平票/);
  assert.deepEqual(repairSurfaceGaps({ ...input, grassSensitivity: 0 }), { repaired: 1, missing: 1 });
  assert.deepEqual([...input.bytes.subarray(index * 3, index * 3 + 3)], borderline);
});

test('physical circles respect unequal pixel dimensions rather than using a circular pixel radius', () => {
  const input = imagery(fullDomain(200, 200, 100, 1)); gap(input, 100, 100);
  for (const row of [50, 75, 125, 150]) gap(input, row, 100);
  coverageFailure(() => repairSurfaceGaps(input), /局部/);
});

test('original donors farther than three image pixels cannot repair a hole', () => {
  const input = imagery(fullDomain(600));
  for (let row = -3; row <= 3; row++) for (let column = -3; column <= 3; column++) if (row * row + column * column <= 9) gap(input, 300 + row, 300 + column);
  coverageFailure(() => repairSurfaceGaps(input), /3.*像元|有效邻/);
});

test('ties fail atomically after earlier repair candidates, and generated pixels never become voters', () => {
  const input = imagery(fullDomain(600)); gap(input, 100, 100); const tied = gap(input, 300, 300);
  let grassCount = 0;
  for (let row = -3; row <= 3; row++) for (let column = -3; column <= 3; column++) if ((row || column) && row * row + column * column <= 9) {
    input.bytes.set(grassCount++ < 14 ? grass : rock, (tied + row * input.domain.width + column) * 3);
  }
  assert.equal(grassCount, 28);
  const bytesBefore = input.bytes.slice(), coveredBefore = input.covered.slice();
  coverageFailure(() => repairSurfaceGaps(input), /平票|相同|多数/); assert.deepEqual(input.bytes, bytesBefore); assert.deepEqual(input.covered, coveredBefore);
});

test('repair cannot propagate inward through newly filled pixels', () => {
  const input = imagery(fullDomain(800));
  for (let row = 297; row <= 303; row++) for (let column = 297; column <= 303; column++) gap(input, row, column);
  const bytesBefore = input.bytes.slice(), coveredBefore = input.covered.slice();
  coverageFailure(() => repairSurfaceGaps(input)); assert.deepEqual(input.bytes, bytesBefore); assert.deepEqual(input.covered, coveredBefore);
});

test('aborted repair leaves source imagery unchanged', () => {
  const input = imagery(fullDomain()); gap(input, 100, 100); const before = input.bytes.slice(), controller = new AbortController(); controller.abort();
  assert.throws(() => repairSurfaceGaps({ ...input, signal: controller.signal }), { name: 'AbortError' }); assert.deepEqual(input.bytes, before);
});

test('tiny positive deficits never appear as zero percent in the error', () => {
  const input = imagery(fullDomain(1024));
  for (let row = -3; row <= 3; row++) for (let column = -3; column <= 3; column++) if (row * row + column * column <= 9) gap(input, 500 + row, 500 + column);
  coverageFailure(() => repairSurfaceGaps(input), /29.*0\.00[1-9]\d*%/);
});
