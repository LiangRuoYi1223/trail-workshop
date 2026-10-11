import assert from 'node:assert/strict';
import test from 'node:test';
import ClipperLib from 'clipper-lib';
import {
  buildRouteCorridor, pathsToRegions, polygonBoolean, regionsAreaMm2, regionsToPaths,
  SCALE, signedArea, toIntPoint, type PointMm, type PolygonRegion,
} from '../src/route/corridor.js';

const point = (x: number, y: number): PointMm => ({ x, y });
const square = (half: number): PointMm[] => [point(-half, -half), point(half, -half), point(half, half), point(-half, half)];
function contains(regions: PolygonRegion[], x: number, y: number): boolean {
  const p = toIntPoint(point(x, y));
  return regions.some(region => ClipperLib.Clipper.PointInPolygon(p, region.outer) !== 0
    && !region.holes.some(hole => ClipperLib.Clipper.PointInPolygon(p, hole) !== 0));
}

test('one millimeter route width has round caps and integer coordinates independent of DEM grid', () => {
  const result = buildRouteCorridor([[point(-5, 0), point(5, 0)]], square(10));
  assert.equal(result.scale, SCALE);
  assert.equal(result.widthMm, 1);
  assert.equal(result.regions.length, 1);
  assert.ok(Math.abs(result.areaMm2 - (10 + Math.PI / 4)) < 0.04);
  assert.ok(contains(result.regions, -5.4, 0));
  assert.ok(contains(result.regions, 0, 0.49));
  assert.ok(!contains(result.regions, 0, 0.51));
  for (const p of result.paths.flat()) assert.ok(Number.isSafeInteger(p.X) && Number.isSafeInteger(p.Y));
});

test('independent GPX segments and isolated points do not gain a connector or marker', () => {
  const result = buildRouteCorridor([
    [point(-8, 0), point(-4, 0)], [point(4, 0), point(8, 0)], [point(0, 0)],
    [point(0, 4), point(0, 4)], [],
  ], square(10));
  assert.equal(result.effectiveSegmentCount, 2);
  assert.equal(result.regions.length, 2);
  assert.ok(!contains(result.regions, 0, 0));
  assert.ok(!contains(result.regions, 0, 4));
});

test('out of bounds excursion and reentry are clipped without an invented inside shortcut', () => {
  const result = buildRouteCorridor([[
    point(-5, -5), point(-5, 20), point(5, 20), point(5, -5),
  ]], square(10));
  assert.equal(result.regions.length, 2);
  assert.ok(contains(result.regions, -5, 0));
  assert.ok(contains(result.regions, 5, 0));
  assert.ok(!contains(result.regions, 0, -5));
  for (const p of result.paths.flat()) assert.ok(Math.abs(p.X) <= 10 * SCALE && Math.abs(p.Y) <= 10 * SCALE);
});

test('duplicate, reversed and crossing trails produce one union rather than multiple layers', () => {
  const horizontal = [point(-5, 0), point(5, 0)];
  const single = buildRouteCorridor([horizontal], square(10));
  const duplicate = buildRouteCorridor([horizontal, [...horizontal].reverse(), horizontal], square(10));
  assert.equal(duplicate.areaMm2, single.areaMm2);
  assert.equal(duplicate.regions.length, 1);
  const crossed = buildRouteCorridor([horizontal, [point(0, -5), point(0, 5)]], square(10));
  assert.equal(crossed.regions.length, 1);
  assert.ok(Math.abs(crossed.areaMm2 - (2 * single.areaMm2 - 1)) < 0.00001);
  assert.ok(contains(crossed.regions, 0, 0));
});

test('a closed route keeps its enclosed terrain hole, with opposite ring winding', () => {
  const ring = [point(-5, -5), point(5, -5), point(5, 5), point(-5, 5), point(-5, -5)];
  const result = buildRouteCorridor([ring], square(10), { widthMm: 2 });
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0]!.holes.length, 1);
  assert.ok(signedArea(result.regions[0]!.outer) > 0);
  assert.ok(signedArea(result.regions[0]!.holes[0]!) < 0);
  assert.ok(!contains(result.regions, 0, 0));
  assert.ok(contains(result.regions, 5, 0));
  assert.ok(Math.abs(result.areaMm2 - (40 * 2 + Math.PI - 4)) < 0.05);
  const reversed = buildRouteCorridor([[...ring].reverse()], square(10), { widthMm: 2 });
  assert.ok(Math.abs(reversed.areaMm2 - result.areaMm2) < 1e-8);
});

test('buffer is clipped correctly at convex sloping boundaries and for entirely outside tracks', () => {
  const diamond = [point(0, -5), point(5, 0), point(0, 5), point(-5, 0)];
  const clipped = buildRouteCorridor([[point(-8, 0), point(8, 0)]], diamond);
  assert.equal(clipped.regions.length, 1);
  assert.ok(contains(clipped.regions, 0, 0));
  for (const p of clipped.paths.flat()) assert.ok(Math.abs(p.X) + Math.abs(p.Y) <= 5 * SCALE + 1);
  assert.equal(buildRouteCorridor([[point(20, 0), point(30, 0)]], diamond).regions.length, 0);
});

test('self-crossing closed trails retain both enclosed areas and collinear returns stay filled once', () => {
  const butterfly = [point(-5, -5), point(5, 5), point(-5, 5), point(5, -5), point(-5, -5)];
  const crossed = buildRouteCorridor([butterfly], square(10));
  assert.equal(crossed.regions.length, 1);
  assert.equal(crossed.regions[0]!.holes.length, 2);
  assert.ok(contains(crossed.regions, 0, 0));
  assert.ok(!contains(crossed.regions, 0, 3));
  assert.ok(!contains(crossed.regions, 0, -3));
  const collinear = buildRouteCorridor([[point(-5, 0), point(0, 0), point(5, 0), point(-5, 0)]], square(10));
  const direct = buildRouteCorridor([[point(-5, 0), point(5, 0)]], square(10));
  assert.equal(collinear.regions.length, 1);
  assert.equal(collinear.regions[0]!.holes.length, 0);
  assert.equal(collinear.areaMm2, direct.areaMm2);
});

test('boolean helpers retain a nested island and support empty operands', () => {
  const outer = square(10).map(toIntPoint), hole = square(5).reverse().map(toIntPoint), island = square(2).map(toIntPoint);
  const regions = pathsToRegions([outer, hole, island]);
  assert.equal(regions.length, 2);
  assert.equal(regionsAreaMm2(regions), 400 - 100 + 16);
  assert.ok(contains(regions, 0, 0));
  assert.ok(!contains(regions, 3, 0));
  assert.deepEqual(polygonBoolean([], [], 'union'), []);
  assert.deepEqual(polygonBoolean([], [outer], 'intersection'), []);
  assert.equal(regionsAreaMm2(polygonBoolean([], [outer], 'union')), 400);
  assert.equal(regionsAreaMm2(polygonBoolean([outer], [], 'difference')), 400);
  const difference = polygonBoolean([outer], [square(5).map(toIntPoint)], 'difference');
  assert.equal(difference[0]!.holes.length, 1);
  assert.equal(regionsAreaMm2(pathsToRegions(regionsToPaths(difference))), 300);
});

test('invalid geometry and impossible precision are rejected clearly', () => {
  assert.throws(() => toIntPoint(point(NaN, 0)), { code: 'ROUTE_GEOMETRY_INVALID' });
  assert.throws(() => toIntPoint(point(1e15, 0)), { code: 'ROUTE_GEOMETRY_INVALID' });
  assert.throws(() => buildRouteCorridor([], square(5), { widthMm: -1 }), { code: 'CONFIG_INVALID' });
  assert.throws(() => buildRouteCorridor([], square(5), { arcToleranceMm: 0 }), { code: 'CONFIG_INVALID' });
  assert.throws(() => buildRouteCorridor([], [point(0, 0), point(1, 0), point(2, 0)]), { code: 'ROUTE_GEOMETRY_INVALID' });
});
