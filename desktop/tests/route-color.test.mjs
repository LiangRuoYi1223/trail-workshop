import test from 'node:test';
import assert from 'node:assert/strict';

const color = await import('../renderer/route-color.ts').catch(() => ({}));
test('wheel positions choose the matching RGB hue and clamp outside its edge', () => {
  assert.equal(typeof color.wheelColor, 'function', 'color wheel is missing');
  assert.equal(color.wheelColor(1, 0, 1), '#ff0000');
  assert.equal(color.wheelColor(0, -1, 1), '#80ff00');
  assert.equal(color.wheelColor(-1, 0, 1), '#00ffff');
  assert.equal(color.wheelColor(0, 1, 1), '#8000ff');
  assert.equal(color.wheelColor(0, 0, .5), '#808080');
  assert.equal(color.wheelColor(2, 0, 1), '#ff0000');
});
test('RGB input and wheel conversion agree for chromatic, gray, black and white colors', () => {
  assert.equal(typeof color.hexToRgb, 'function', 'RGB conversion is missing');
  for (const hex of ['#c84832', '#00ff80', '#808080', '#000000', '#ffffff']) {
    assert.equal(color.rgbToHex(color.hsvToRgb(color.rgbToHsv(color.hexToRgb(hex)))), hex);
  }
  assert.deepEqual(color.hexToRgb('#C84832'), { r:200, g:72, b:50 });
  assert.equal(color.rgbToHex({ r:0, g:128, b:255 }), '#0080ff');
});
test('invalid RGB input cannot produce an invalid route color', () => {
  assert.equal(typeof color.rgbToHex, 'function', 'RGB validation is missing');
  assert.throws(() => color.hexToRgb('#oops'), /颜色/);
  assert.throws(() => color.rgbToHex({ r:NaN, g:0, b:0 }), /RGB/);
  assert.throws(() => color.rgbToHex({ r:256, g:0, b:0 }), /RGB/);
});
test('changing preview color keeps the model saveable while changing thickness invalidates it', () => {
  assert.equal(typeof color.geometryOptions, 'function', 'model color separation is missing');
  const options = { routeColor:'#c84832', routeWidthMm:1, routeHeightMm:1 };
  assert.deepEqual(color.geometryOptions(options), color.geometryOptions({ ...options, routeColor:'#00ff00' }));
  assert.notDeepEqual(color.geometryOptions(options), color.geometryOptions({ ...options, routeHeightMm:2 }));
});
