import test from 'node:test';
import assert from 'node:assert/strict';
const color = await import('../renderer/route-color.ts');
const settings = { routeWidthMm:1,routeHeightMm:1,maxColors:3,grassColor:'#227733',rockColor:'#999999',routeColor:'#dd2233' };

test('terrain and route recoloring does not change geometry while route relief does', () => {
  assert.deepEqual(color.geometryOptions(settings), { routeWidthMm:1,routeHeightMm:1 });
  assert.deepEqual(color.geometryOptions({ ...settings,maxColors:2,grassColor:'#00ff00',rockColor:'#111111',routeColor:'#0000ff' }), { routeWidthMm:1,routeHeightMm:1 });
  assert.notDeepEqual(color.geometryOptions({ ...settings,routeHeightMm:2 }), color.geometryOptions(settings));
});
test('two-color preview merges terrain classes while preserving the route material', () => {
  assert.equal(typeof color.appearanceColor,'function');
  assert.equal(color.appearanceColor('grass',settings),'#227733');
  assert.equal(color.appearanceColor('rock',settings),'#999999');
  assert.equal(color.appearanceColor('route',settings),'#dd2233');
  assert.equal(color.appearanceColor('rock',{ ...settings,maxColors:2 }),'#227733');
  assert.equal(color.appearanceColor('route',{ ...settings,maxColors:2 }),'#dd2233');
});
test('the displayed material count uses actual RGB values and current face classes', () => {
  assert.equal(typeof color.printPaletteCount,'function');
  assert.equal(color.printPaletteCount(['grass','rock','route'],settings),3);
  assert.equal(color.printPaletteCount(['grass','rock','route'],{ ...settings,maxColors:2 }),2);
  assert.equal(color.printPaletteCount(['grass','rock','route'],{ ...settings,rockColor:'#227733' }),2);
  assert.equal(color.printPaletteCount(['grass','route'],{ ...settings,routeColor:'#227733' }),1);
});
