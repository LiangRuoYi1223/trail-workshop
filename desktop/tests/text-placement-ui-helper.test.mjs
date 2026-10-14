import test from 'node:test';
import assert from 'node:assert/strict';

const placement = await import('../renderer/text-placement.ts').catch(() => ({}));

test('shrinking polygon sides keeps a valid selected edge and preserves valid choices', () => {
  assert.equal(typeof placement.clampTextEdgeIndex, 'function');
  assert.equal(placement.clampTextEdgeIndex(7, 3), 2);
  assert.equal(placement.clampTextEdgeIndex(1, 8), 1);
  assert.equal(placement.clampTextEdgeIndex(undefined, 6), 0);
});

test('placement validation allows 360, rejects fractional edges, and checks the active polygon', () => {
  assert.equal(typeof placement.validateTextPlacement, 'function');
  const options = {shape:'circle', polygonSides:3, baseTextAngleDeg:360, baseTextEdgeIndex:7};
  assert.equal(placement.validateTextPlacement(options), '');
  assert.match(placement.validateTextPlacement({...options, baseTextAngleDeg:361}), /0–360/);
  assert.match(placement.validateTextPlacement({...options, baseTextEdgeIndex:.5}), /整数/);
  assert.match(placement.validateTextPlacement({...options, shape:'polygon'}), /第 1–3 边/);
  assert.equal(placement.validateTextPlacement({shape:'rectangle', polygonSides:6}), '');
});

test('offline glyph paths preserve counters as closed subpaths and flip the model Y axis', () => {
  assert.equal(typeof placement.contourSvgPath, 'function');
  const contour = {outer:[{x:0,y:1},{x:6,y:1},{x:6,y:7},{x:0,y:7}], holes:[[{x:2,y:3},{x:4,y:3},{x:4,y:5},{x:2,y:5}]]};
  const path = placement.contourSvgPath(contour);
  assert.equal((path.match(/M/g) ?? []).length, 2);
  assert.equal((path.match(/Z/g) ?? []).length, 2);
  assert.ok(path.includes('M0,-1'));
  assert.ok(path.includes('M2,-3'));
});

test('map bounds include the expanded ledge and real glyphs; preview failure adds no invalid points', () => {
  assert.equal(typeof placement.textPreviewPoints, 'function');
  const outside = {lat:1,lon:2}, ledge = {lat:3,lon:4};
  const preview = {contoursMm:[], contoursGeo:[{outer:[outside], holes:[]}], outlineGeo:[ledge]};
  assert.deepEqual(placement.textPreviewPoints(preview), [ledge,outside]);
  assert.deepEqual(placement.textPreviewPoints({error:'font missing'}), []);
  assert.deepEqual(placement.textPreviewPoints(undefined), []);
});

test('text-only map rotation follows top, right, bottom, left and preserves glyph radius', () => {
  assert.equal(typeof placement.textAngleFromPoint, 'function');
  assert.equal(typeof placement.rotateTextPoint, 'function');
  assert.equal(placement.textAngleFromPoint({x:0,y:10}), 0);
  assert.equal(placement.textAngleFromPoint({x:10,y:0}), 90);
  assert.equal(placement.textAngleFromPoint({x:0,y:-10}), 180);
  assert.equal(placement.textAngleFromPoint({x:-10,y:0}), 270);
  const rotated=placement.rotateTextPoint({x:2,y:10},90);
  assert.ok(Math.abs(rotated.x-10)<1e-10);
  assert.ok(Math.abs(rotated.y+2)<1e-10);
  assert.ok(Math.abs(Math.hypot(rotated.x,rotated.y)-Math.hypot(2,10))<1e-10);
});
