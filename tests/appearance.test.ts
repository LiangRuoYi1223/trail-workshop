import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelAppearance, recolorModelAppearance } from '../src/appearance/apply.js';
import { validateAppearanceOptions, validateModelAppearance } from '../src/appearance/palette.js';
import type { AppearanceMesh, ColorImage, FaceClass } from '../src/appearance/types.js';

const options = { maxColors: 3 as const, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
const selection = { center: { lat: 60, lon: 10 }, bearingDeg: 90, mmPerMeter: .1 };
const metadata = { sha256: 'a'.repeat(64), byteLength: 1000, width: 2, height: 2,
  bounds: { west: 0, south: 0, east: 20, north: 70 }, crs: 'EPSG:4326' as const, pixelIsArea: true };
function mesh(kinds: NonNullable<AppearanceMesh['faceKinds']>): AppearanceMesh {
  // Each triangle centroid is at (10,0) mm; with bearing 90 it is 100 ground metres south.
  return { positions: [9,-1,3, 12,0,3, 9,1,3], indices: kinds.flatMap(() => [0,1,2]), faceKinds: kinds };
}
function image(sample: ColorImage['sample']): ColorImage { return { sample, metadata }; }

test('without imagery terrain is explicitly uniform while route and structure retain their own classes', () => {
  const appearance = buildModelAppearance(mesh(['terrain','route','route-wall','frame','wall','bottom']), selection, options);
  assert.equal(appearance.classification, 'uniform');
  assert.equal(appearance.source, undefined);
  assert.deepEqual(appearance.faceClasses, ['grass','route','route','rock','rock','rock']);
  assert.deepEqual(appearance.faceMaterials.map(index => appearance.palette[index].color),
    ['#799278','#c84832','#c84832','#a9aa92','#a9aa92','#a9aa92']);
  validateModelAppearance(appearance, 6);
});

test('RGB greenness requires meaningful green dominance rather than a one-level tint', () => {
  const values = [{r:50,g:140,b:60},{r:130,g:90,b:70},{r:90,g:95,b:90},{r:5,g:20,b:5},{r:180,g:180,b:180}];
  const appearance = buildModelAppearance(mesh(values.map(() => 'terrain')), selection, options, image(() => values.shift()!));
  assert.equal(appearance.classification, 'rgb-greenness');
  assert.deepEqual(appearance.faceClasses, ['grass','rock','rock','rock','rock']);
  assert.equal(appearance.source?.sha256, metadata.sha256);
});

test('sampling undoes rotation and fixed-latitude ground scale at a face centroid', () => {
  let sampled: {lat:number;lon:number} | undefined;
  buildModelAppearance(mesh(['terrain']), selection, options, image((lat,lon) => {
    sampled = {lat,lon}; return {r:50,g:140,b:60};
  }));
  assert.ok(sampled);
  assert.ok(Math.abs(sampled.lon - 10) < 1e-10);
  // Hand computed 100 ground metres south at 60 degrees, inverse Mercator.
  assert.ok(Math.abs(sampled.lat - 59.99910167251723) < 1e-10, JSON.stringify(sampled));
});

test('route priority and structural colors do not sample missing imagery', () => {
  const appearance = buildModelAppearance(mesh(['route','route-wall','frame','wall','bottom']), selection, options,
    image(() => { throw new Error('unexpected imagery sampling'); }));
  assert.deepEqual(appearance.faceClasses, ['route','route','rock','rock','rock']);
});

test('terrain outside image or in transparent/nodata pixels rejects the appearance', () => {
  assert.throws(() => buildModelAppearance(mesh(['terrain']), selection, options, image(() => null)), /覆盖|有效像元/u);
  assert.throws(() => buildModelAppearance(mesh(['terrain']), selection, options, image(() => ({r:NaN,g:255,b:0}))), /像元/u);
});

test('two colors maps grass and rock to the same mountain material and preserves route', () => {
  const appearance = buildModelAppearance(mesh(['terrain','frame','route']), selection, {...options,maxColors:2});
  assert.deepEqual(appearance.faceClasses, ['grass','rock','route']);
  assert.deepEqual(appearance.faceMaterials, [0,0,1]);
  assert.deepEqual(appearance.palette.map(entry => entry.color), ['#799278','#c84832']);
});

test('equal RGB colors deduplicate regardless of case and unused materials are omitted', () => {
  const appearance = buildModelAppearance(mesh(['terrain','wall','route']), selection,
    {...options,grassColor:'#ABCDEF',rockColor:'#abcdef',routeColor:'#ABCDEF'});
  assert.deepEqual(appearance.faceMaterials, [0,0,0]);
  assert.deepEqual(appearance.palette.map(entry => entry.color), ['#abcdef']);
});

test('recolor keeps semantic classification and source but changes current colors and hash', () => {
  const before = buildModelAppearance(mesh(['terrain','wall','route']), selection, options, image(() => ({r:50,g:140,b:60})));
  const after = recolorModelAppearance(before, {...options,maxColors:2,grassColor:'#112233',routeColor:'#334455'});
  assert.deepEqual(after.faceClasses, ['grass','rock','route']);
  assert.deepEqual(after.faceMaterials.map(index => after.palette[index].color), ['#112233','#112233','#334455']);
  assert.deepEqual(after.source, before.source);
  assert.notEqual(after.hash, before.hash);
  assert.deepEqual(before.faceMaterials.map(index => before.palette[index].color), ['#799278','#a9aa92','#c84832']);
  validateModelAppearance(after, 3);
});

test('options validate budget and concrete six-digit RGB while supporting old partial settings', () => {
  assert.deepEqual(validateAppearanceOptions({routeColor:'#ABC123'}), {...options,routeColor:'#abc123'});
  for (const invalid of [{maxColors:4},{maxColors:0},{grassColor:'red'},{rockColor:'#abc'},{routeColor:'#GG1122'},null]) {
    assert.throws(() => validateAppearanceOptions(invalid as never), /颜色|配色/u);
  }
});

test('appearance validator refuses stale hashes, malformed counts, illegal material indices and counterfeit palette', () => {
  const valid = buildModelAppearance(mesh(['terrain','wall','route']), selection, options);
  const changes: Array<Record<string,unknown>> = [
    {hash:'f'.repeat(64)}, {faceClasses:['grass']}, {faceMaterials:[0,1,100]},
    {palette:[...valid.palette,{id:'route',name:'额外',color:'#123456'}]},
    {faceClasses:['water','rock','route'] as unknown as FaceClass[]},
    {palette:valid.palette.map((entry,index) => index===0 ? {...entry,color:'#ffffff'} : entry)},
  ];
  for (const change of changes) assert.throws(() => validateModelAppearance({...valid,...change} as never,3), /外观|调色板|材质|分类|哈希/u);
  assert.throws(() => validateModelAppearance(valid,4), /面数/u);
});

test('malformed mesh or selection cannot silently create plausible color classifications', () => {
  assert.throws(() => buildModelAppearance({...mesh(['terrain']),indices:[0,1,99]}, selection, options), /网格/u);
  assert.throws(() => buildModelAppearance({...mesh(['terrain']),faceKinds:[]}, selection, options), /网格/u);
  assert.throws(() => buildModelAppearance(mesh(['terrain']), {...selection,mmPerMeter:0}, options), /取景/u);
});
