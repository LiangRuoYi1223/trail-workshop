import test from 'node:test';
import assert from 'node:assert/strict';
import * as framing from '../desktop/renderer/framing.js';
import type { ModelOptions } from '../desktop/renderer/types.js';
const defaults: ModelOptions = { shape:'rectangle', widthMm:120, heightMm:80, polygonSides:6, cornerRadiusMm:0,
  bearingDeg:0, paddingFraction:.1, baseThicknessMm:2, zExaggeration:2, gridColumns:65, smoothing:'raw', routeWidthMm:1, routeHeightMm:1, routeColor:'#c84832', frameWidthMm:3 };
const selection = { center:{lat:0,lon:0},groundWidthM:4000,groundHeightM:8000/3,bearingDeg:0 };
test('dragging a regular polygon vertex doubles its ground size without changing print size or shape', () => {
  const resize = (framing as any).optionsFromVertex;
  assert.equal(typeof resize, 'function', 'regular map vertex scaling is missing');
  const options={...defaults,shape:'polygon',polygonSides:6};
  const result = resize({x:120,y:0},{x:60,y:0}, selection, options);
  assert.equal(result.shape,'polygon');
  assert.equal(result.widthMm,120);
  assert.equal(result.heightMm,80);
  assert.equal(result.polygonSides,6);
  assert.equal(result.groundWidthM,8000);
  assert.deepEqual(result.center,selection.center);
  assert.equal(result.bearingDeg,0);
});
test('rectangle resizing preserves aspect and rotated selection bearing', () => {
  const resize = (framing as any).optionsFromVertex;
  assert.equal(typeof resize,'function','rectangle vertex scaling is missing');
  const result=resize({x:-30,y:-20},{x:-60,y:-40},{...selection,bearingDeg:37},defaults);
  assert.equal(result.groundWidthM,2000);assert.equal(result.heightMm,80);assert.equal(result.bearingDeg,37);
});
test('zero or extreme vertex sizes reject an unbuildable ground selection', () => {
  const resize = (framing as any).optionsFromVertex;
  assert.equal(typeof resize,'function','vertex size validation is missing');
  assert.throws(()=>resize({x:0,y:0},{x:60,y:0},selection,defaults),/取景/);
  assert.throws(()=>resize({x:2000,y:0},{x:60,y:0},selection,defaults),/取景/);
});
test('mouse rotation follows bearing convention and wraps cleanly across 180 degrees', () => {
  const rotation = (framing as any).rotationBearing;
  assert.equal(typeof rotation,'function','map rotation is missing');
  assert.equal(rotation(0,0,Math.PI/2),90);
  assert.equal(rotation(170,0,Math.PI/6),-160);
  assert.ok(Math.abs(rotation(10,179*Math.PI/180,-179*Math.PI/180)-12)<1e-9);
});
