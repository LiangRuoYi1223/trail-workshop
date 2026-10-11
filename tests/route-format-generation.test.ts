import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrintableTerrain } from '../src/generate-printable-terrain.js';
import { generateTerrain } from '../src/generate-terrain.js';
import { TerrainError } from '../src/errors.js';
import { writeBinaryStl } from '../src/vendor/trailprint/stl-writer.js';

const gpx = `<gpx><trk><name>路线</name><trkseg>
  <trkpt lat="30.55" lon="104.275"/><trkpt lat="30.555" lon="104.28"/>
  <trkpt lat="invalid" lon="104.285"/><trkpt lat="30.56" lon="104.29"/><trkpt lat="30.565" lon="104.30"/>
  </trkseg><trkseg><trkpt lat="30.566" lon="104.29"/><trkpt lat="30.57" lon="104.305"/></trkseg></trk></gpx>`;
const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>路线</name><MultiGeometry>
  <LineString><coordinates>104.275,30.55 104.28,30.555 104.285,invalid 104.29,30.56 104.30,30.565</coordinates></LineString>
  <LineString><coordinates>104.29,30.566 104.305,30.57</coordinates></LineString>
  </MultiGeometry></Placemark></kml>`;
const options = { widthMm: 40, heightMm: 30, gridColumns: 17, groundWidthM: 4000, baseThicknessMm: 3 };
const loadDem = async () => ({ sample: (lat: number, lon: number) => 500 + (lat - 30.55) * 1000 + (lon - 104.275) * 200,
  metadata: { provider: 'synthetic-format-test' } });

test('equivalent KML and GPX produce identical printable geometry and STL with discontinuities preserved', async () => {
  const gpxResult = await generatePrintableTerrain({ gpxXml: gpx, fileName: 'route.gpx', options, loadDem });
  const kmlResult = await generatePrintableTerrain({ gpxXml: kml, fileName: 'route.kml', options, loadDem });
  assert.deepEqual(kmlResult.mesh, gpxResult.mesh);
  assert.deepEqual(kmlResult.heightfield, gpxResult.heightfield);
  assert.deepEqual(kmlResult.routeSegmentsMm, gpxResult.routeSegmentsMm);
  assert.deepEqual(kmlResult.report.route, gpxResult.report.route);
  assert.deepEqual(kmlResult.report.validation, gpxResult.report.validation);
  assert.deepEqual(kmlResult.routeSegmentsMm.map(segment => segment.length), [2, 2, 2]);
  assert.deepEqual(kmlResult.report.route, { name: '路线', pointCount: 6, segmentCount: 3,
    distanceKm: (gpxResult.report.route as { distanceKm: number }).distanceKm, invalidPointCount: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'route-format-stl-'));
  try {
    const first = join(directory, 'gpx.stl'), second = join(directory, 'kml.stl');
    await writeBinaryStl(first, gpxResult.mesh);
    await writeBinaryStl(second, kmlResult.mesh);
    assert.deepEqual(await readFile(second), await readFile(first));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('route parsing retains the legacy progress phase with a format-neutral message', async () => {
  const events: Array<{ phase: string; message: string }> = [];
  await generateTerrain({ gpxXml: kml, options, loadDem, onProgress: event => events.push(event) });
  assert.equal(events[0]!.phase, 'gpx');
  assert.match(events[0]!.message, /路线/);
  assert.equal(events.at(-1)!.phase, 'done');
});

test('too-short routes reject before DEM loading with format-specific error codes', async () => {
  for (const [gpxXml, fileName, code] of [
    ['<gpx><rte><rtept lat="1" lon="2"/></rte></gpx>', 'route.gpx', 'GPX_TOO_SHORT'],
    ['<kml><Placemark><LineString><coordinates>2,1</coordinates></LineString></Placemark></kml>', 'route.kml', 'KML_TOO_SHORT'],
    ['<kml><Placemark><LineString><coordinates>2,1</coordinates></LineString></Placemark></kml>', undefined, 'KML_TOO_SHORT'],
  ] as const) {
    let loaded = false;
    await assert.rejects(generateTerrain({ gpxXml, fileName, loadDem: async () => {
      loaded = true; return loadDem();
    } }), error => error instanceof TerrainError && error.code === code);
    assert.equal(loaded, false);
  }
});
