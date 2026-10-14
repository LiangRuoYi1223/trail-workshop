import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../../dist/src/index.js';
import { createSurfaceCoverageDomain } from '../../dist/src/appearance/surface-coverage.js';
import { terrainImageFootprint } from '../main/surface-footprint.mjs';

const colors = { maxColors: 3, grassColor: '#799278', rockColor: '#a9aa92', routeColor: '#c84832' };
const points = center => [{ lat: center.lat, lon: center.lon }, { lat: center.lat + .001, lon: center.lon + .001 }];
const gpx = center => `<gpx><trk><trkseg>${points(center).map(point => `<trkpt lat="${point.lat}" lon="${point.lon}"/>`).join('')}</trkseg></trk></gpx>`;
const pixelPoint = (point, bounds) => ({ x: (point.lon - bounds.west) / (bounds.east - bounds.west) * 1024,
  y: (bounds.north - point.lat) / (bounds.north - bounds.south) * 1024 });

for (const scenario of [
  { label: 'long rotated high-latitude rectangle', shape: 'rectangle', widthMm: 15, heightMm: 500, groundWidthM: 3000, bearingDeg: 25, center: { lat: 78, lon: 20 }, gridColumns: 257 },
  { label: 'long rounded high-latitude rectangle', shape: 'rectangle', widthMm: 15, heightMm: 500, cornerRadiusMm: 3, groundWidthM: 3000, bearingDeg: 25, center: { lat: 78, lon: 20 }, gridColumns: 129 },
  { label: 'large high-latitude circle', shape: 'circle', widthMm: 200, groundWidthM: 100000, bearingDeg: -25, center: { lat: 78, lon: 20 }, gridColumns: 65 },
  { label: 'large rotated middle-latitude hexagon', shape: 'polygon', polygonSides: 6, widthMm: 120, groundWidthM: 99900, bearingDeg: -25, center: { lat: 35, lon: 20 }, gridColumns: 65 },
  { label: 'large equator-crossing rectangle', shape: 'rectangle', widthMm: 120, heightMm: 80, groundWidthM: 80000, bearingDeg: 25, center: { lat: 0, lon: 20 }, gridColumns: 65 },
]) {
  test(`${scenario.label} covers every real terrain sample using fully valid model imagery`, async () => {
    const { label, ...selected } = scenario;
    const options = { ...selected, maxMissingFraction: 0, routeEnabled: false, textEnabled: false, frameWidthMm: 0 };
    const frame = core.createTerrainFrame(points(options.center), options);
    const footprint = terrainImageFootprint(core, frame, options.gridColumns);
    const domain = createSurfaceCoverageDomain({ width: 1024, height: 1024,
      polygon: footprint.map(point => pixelPoint(point, frame.bounds)), pixelWidthM: 30, pixelHeightM: 30 });
    const result = await core.generatePrintableTerrain({ gpxXml: gpx(options.center), options,
      loadDem: async () => ({ sample: (lat, lon) => 100 + lat / 10 + lon / 10, metadata: { provider: 'analytic-test' } }) });
    let terrainSamples = 0;
    const image = { metadata: { sha256: 'a'.repeat(64), byteLength: 1024 * 1024 * 3, width: 1024, height: 1024,
      bounds: frame.bounds, crs: 'EPSG:4326', pixelIsArea: true },
      sample(lat, lon) {
        terrainSamples++;
        const point = pixelPoint({ lat, lon }, frame.bounds), column = Math.floor(point.x), row = Math.floor(point.y);
        if (column < 0 || column >= 1024 || row < 0 || row >= 1024 || !domain.model[row * 1024 + column]) return null;
        return { r: 50, g: 150, b: 40 };
      } };
    const appearance = core.buildModelAppearance(result.mesh, result.report.selection, colors, image);
    assert.equal(terrainSamples, result.mesh.faceKinds.filter(kind => kind === 'terrain').length);
    assert.ok(terrainSamples > 100);
    assert.equal(appearance.classification, 'rgb-greenness');
    assert.ok(footprint.length <= 4096);
    assert.notDeepEqual(footprint[0], footprint.at(-1), 'closed outlines omit the duplicate final point');
  });
}

test('quarter-point checks detect opposite projection bends hidden by midpoint cancellation', () => {
  const outline = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  const frame = { crop: { widthMm: 2, heightMm: 2 }, bounds: { west: -1, east: 1, south: -1.2, north: 1.2 },
    mmToGeo: (x, y) => ({ lon: x, lat: y + .2 * y ** 3 }) };
  const footprint = terrainImageFootprint({ buildTerrainFootprintPolygonMm: () => outline }, frame, 129);
  assert.ok(footprint.length > 4, 'equator-like odd curvature must be subdivided despite an exact midpoint');
  for (let index = 0; index < footprint.length; index++) {
    const a = footprint[index], b = footprint[(index + 1) % footprint.length];
    const toModelY = lat => { let low = -1, high = 1; for (let step = 0; step < 60; step++) { const middle = (low + high) / 2; if (middle + .2 * middle ** 3 < lat) low = middle; else high = middle; } return (low + high) / 2; };
    const aY = toModelY(a.lat), bY = toModelY(b.lat);
    for (const fraction of [.125, .25, .375, .5, .625, .75, .875]) {
      const y = aY + (bY - aY) * fraction, lat = y + .2 * y ** 3;
      assert.ok(Math.abs(lat - (a.lat + (b.lat - a.lat) * fraction)) / 2.4 * 1024 <= .101);
    }
  }
});

test('unresolvable projection accuracy rejects instead of publishing more than 4096 vertices', () => {
  const frame = { crop: { widthMm: 2, heightMm: 2 }, bounds: { west: -1, east: 1, south: -1, north: 1 },
    mmToGeo: (x, y) => ({ lon: x, lat: y + (y > 0 ? .5 : -.5) }) };
  const outline = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  assert.throws(() => terrainImageFootprint({ buildTerrainFootprintPolygonMm: () => outline }, frame, 129), { code: 'IMAGE_REQUEST_INVALID' });
});

test('outline point limits fail before an oversized geographic polygon can reach acquisition', () => {
  const frame = { crop: { widthMm: 2, heightMm: 2 }, bounds: { west: -1, east: 1, south: -1, north: 1 },
    mmToGeo: (x, y) => ({ lon: x, lat: y }) };
  const outline = Array.from({ length: 4097 }, (_, index) => ({ x: Math.cos(index / 4097 * Math.PI * 2), y: Math.sin(index / 4097 * Math.PI * 2) }));
  assert.throws(() => terrainImageFootprint({ buildTerrainFootprintPolygonMm: () => outline }, frame), { code: 'IMAGE_REQUEST_INVALID' });
});

test('reversing model outline winding preserves the curved geographic coverage mask', () => {
  const options = { shape: 'rectangle', widthMm: 15, heightMm: 500, groundWidthM: 3000, bearingDeg: 25, center: { lat: 78, lon: 20 }, gridColumns: 257 };
  const frame = core.createTerrainFrame(points(options.center), options);
  const forward = terrainImageFootprint(core, frame, options.gridColumns);
  const reversed = terrainImageFootprint({ ...core, buildTerrainFootprintPolygonMm: (...args) => core.buildTerrainFootprintPolygonMm(...args).reverse() }, frame, options.gridColumns);
  const domain = footprint => createSurfaceCoverageDomain({ width: 1024, height: 1024,
    polygon: footprint.map(point => pixelPoint(point, frame.bounds)), pixelWidthM: 30, pixelHeightM: 30 });
  assert.deepEqual(domain(forward).model, domain(reversed).model);
});

test('a small equatorial rectangle preserves its original four vertices without unnecessary splitting', () => {
  const options = { shape: 'rectangle', widthMm: 120, heightMm: 80, groundWidthM: 1000, bearingDeg: 0, center: { lat: 0, lon: 20 } };
  const frame = core.createTerrainFrame(points(options.center), options);
  const footprint = terrainImageFootprint(core, frame);
  assert.deepEqual(footprint, core.buildTerrainFootprintPolygonMm(frame.crop, 129, 86).map(({ x, y }) => frame.mmToGeo(x, y)));
});
