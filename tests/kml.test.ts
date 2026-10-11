import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/index.js';
import { GpxParseError, parseGpxXml, type GpxParseResult } from '../src/gpx/parse-gpx.js';

type RouteParser = (xml: string, options?: { fileName?: string }) => GpxParseResult;
function parser(name: 'parseKmlXml' | 'parseRouteXml'): RouteParser {
  const value = (core as unknown as Record<string, unknown>)[name];
  assert.equal(typeof value, 'function', `${name} must be a public route parser`);
  return value as RouteParser;
}
const kml = (body: string) => `<kml xmlns="http://www.opengis.net/kml/2.2">${body}</kml>`;
const line = (coordinates: string) => `<LineString><coordinates>${coordinates}</coordinates></LineString>`;
function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof Error && 'code' in error && error.code === code;
}

test('KML prefixed LineString preserves lon-lat ordering, elevations, names and bounds', () => {
  const result = parser('parseKmlXml')(`\uFEFF<?xml version="1.0"?>
    <!-- a prefix is independent of the namespace -->
    <k:kml xmlns:k="http://www.opengis.net/kml/2.2">
      <k:Document><k:name>山谷 &amp; 山脊</k:name><k:Folder><k:Placemark>
        <k:name><![CDATA[甲 < 乙]]></k:name><k:LineString><k:coordinates>
          104.2,30.1,1200.5 104.3,30.2 104.4,30.3,broken
        </k:coordinates></k:LineString>
      </k:Placemark></k:Folder></k:Document>
    </k:kml>`);
  assert.equal(result.name, '山谷 & 山脊');
  assert.equal(result.segments[0]!.name, '甲 < 乙');
  assert.deepEqual(result.segments[0]!.points, [
    { lat: 30.1, lon: 104.2, ele: 1200.5 }, { lat: 30.2, lon: 104.3 }, { lat: 30.3, lon: 104.4 },
  ]);
  assert.deepEqual(result.bbox, { minLat: 30.1, maxLat: 30.3, minLon: 104.2, maxLon: 104.4 });
  assert.ok(Math.abs(result.suggestedCenter.lat - 30.2) < 1e-10);
  assert.ok(Math.abs(result.suggestedCenter.lon - 104.3) < 1e-10);
  assert.equal(result.pointCount, 3);
  assert.equal(result.sourcePointCount, 3);
  assert.equal(result.invalidPointCount, 0);
});

test('MultiGeometry and separate Placemarks keep independent runs in document order', () => {
  const result = parser('parseKmlXml')(kml(`<Document><Placemark><name>甲</name><MultiGeometry>
    ${line('0,0 0.001,0')}<MultiGeometry>${line('100,45 100.001,45')}</MultiGeometry>
    </MultiGeometry></Placemark><Placemark><name>乙</name>${line('10,10 10.001,10')}</Placemark></Document>`));
  assert.deepEqual(result.segments.map(({ kind, sourceIndex, segmentIndex, partIndex, name }) => (
    { kind, sourceIndex, segmentIndex, partIndex, name }
  )), [
    { kind: 'track', sourceIndex: 0, segmentIndex: 0, partIndex: 0, name: '甲' },
    { kind: 'track', sourceIndex: 0, segmentIndex: 1, partIndex: 0, name: '甲' },
    { kind: 'track', sourceIndex: 1, segmentIndex: 0, partIndex: 0, name: '乙' },
  ]);
  assert.equal(result.segmentCount, 3);
  assert.equal(result.pointCount, 6);
  assert.ok(result.distanceKm > 0.29 && result.distanceKm < 0.31, 'no distance across unrelated geometries');
  assert.ok(Math.abs(result.segments[0]!.distanceKm - 0.11119508) < 0.000001);
});

test('invalid coordinate tuples split a LineString without inventing connectors', () => {
  const result = parser('parseKmlXml')(kml(`<Placemark>${line(
    '0,0 broken,0 2,91 100,0 100.001,0 100.002,0x10 200,0 100.003, 100.004,Infinity -100,0',
  )}</Placemark>`));
  assert.deepEqual(result.segments.map(s => s.points.length), [1, 2, 1]);
  assert.deepEqual(result.segments.map(s => s.partIndex), [0, 1, 2]);
  assert.equal(result.sourcePointCount, 10);
  assert.equal(result.invalidPointCount, 6);
  assert.equal(result.pointCount, 4);
  assert.ok(result.distanceKm > 0.11 && result.distanceKm < 0.12);
});

test('gx Track parallel time arrays and MultiTrack preserve breaks including empty coords', () => {
  const result = parser('parseKmlXml')(`<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:t="http://www.google.com/kml/ext/2.2">
    <Placemark><name>旅程</name><t:MultiTrack><t:interpolate>1</t:interpolate>
      <t:Track><when>2026-10-01T00:00:00Z</when><when>2026-10-01T00:01:00Z</when>
        <when>2026-10-01T00:02:00Z</when><when>2026-10-01T00:03:00Z</when>
        <t:coord>104.2 30.1 500</t:coord><t:coord/><t:coord>104.3 30.2</t:coord><t:coord>104.4 30.3 501</t:coord>
      </t:Track><t:Track><t:coord>105 31 502</t:coord><t:coord>105.001 31 503</t:coord></t:Track>
    </t:MultiTrack></Placemark></kml>`);
  assert.deepEqual(result.segments.map(s => [s.sourceIndex, s.segmentIndex, s.partIndex]), [[0, 0, 0], [0, 0, 1], [0, 1, 0]]);
  assert.deepEqual(result.segments[0]!.points, [{ lon: 104.2, lat: 30.1, ele: 500, time: '2026-10-01T00:00:00Z' }]);
  assert.deepEqual(result.segments[1]!.points, [
    { lon: 104.3, lat: 30.2, time: '2026-10-01T00:02:00Z' },
    { lon: 104.4, lat: 30.3, ele: 501, time: '2026-10-01T00:03:00Z' },
  ]);
  assert.equal(result.sourcePointCount, 6);
  assert.equal(result.invalidPointCount, 1);
  assert.equal(result.segmentCount, 3);
});

test('legacy and namespace-free common exports are recognized', () => {
  for (const namespace of ['', 'http://earth.google.com/kml/2.0', 'http://earth.google.com/kml/2.1', 'http://earth.google.com/kml/2.2']) {
    const result = parser('parseKmlXml')(`<kml xmlns="${namespace}"><Folder><Placemark>${line('2,1 2.001,1')}</Placemark></Folder></kml>`);
    assert.equal(result.pointCount, 2);
    assert.equal(result.segments[0]!.points[0]!.lon, 2);
  }
});

test('Point Polygon NetworkLink and extension lookalikes never become routes or fallback names', () => {
  const body = `<Document><Placemark><name>不应命名</name><Point><coordinates>80,80</coordinates></Point></Placemark>
    <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>70,70 71,71 72,70</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <NetworkLink><Link><href>https://example.invalid/route.kml</href></Link><Placemark>${line('75,75 76,76')}</Placemark></NetworkLink>
    <x:Placemark xmlns:x="urn:unrelated"><x:LineString><x:coordinates>60,60 61,61</x:coordinates></x:LineString></x:Placemark>
    <Placemark><ExtendedData>${line('50,50 51,51')}</ExtendedData>${line('104,30 104.001,30')}</Placemark></Document>`;
  const result = parser('parseKmlXml')(kml(body), { fileName: 'C:\\导出\\乙.KML' });
  assert.equal(result.name, '乙');
  assert.equal(result.pointCount, 2);
  assert.equal(result.sourcePointCount, 2);
  assert.equal(result.segments[0]!.sourceIndex, 0);
  assert.equal(result.bbox.maxLat, 30);
  assert.throws(() => parser('parseKmlXml')(kml('<Placemark><Point><coordinates>104,30</coordinates></Point></Placemark>')), hasCode('KML_NO_TRACK'));
});

test('top Document name wins and valid route Placemark names can follow geometry', () => {
  const result = parser('parseKmlXml')(kml(`<Document><Folder><Document><name>嵌套</name><Placemark>${line('2,1')}<name>路线名</name></Placemark></Document></Folder><name>顶层</name></Document>`));
  assert.equal(result.name, '顶层');
  assert.equal(result.segments[0]!.name, '路线名');
  const named = parser('parseKmlXml')(kml(`<Document><Placemark><name>无效路线</name>${line('NaN,1')}</Placemark><Placemark>${line('2,1')}<name>有效路线</name></Placemark></Document>`));
  assert.equal(named.name, '有效路线');
  const next = parser('parseKmlXml')(`<kml><Placemark>${line('-2,-1')}</Placemark></kml>`);
  assert.equal(next.name, undefined);
  assert.deepEqual(next.bbox, { minLat: -1, maxLat: -1, minLon: -2, maxLon: -2 });
});

test('KML dates crossing the antimeridian flag unsupported crop while using short-arc distance', () => {
  const result = parser('parseKmlXml')(kml(`<Placemark>${line('179.999,0 -179.999,0')}</Placemark>`));
  assert.equal(result.crossesAntimeridian, true);
  assert.ok(result.distanceKm > 0.22 && result.distanceKm < 0.23);
});

test('KML rejects malformed XML, wrong roots/namespaces, empty routes and custom entities', () => {
  const cases: Array<[string, string]> = [
    [' \n\t', 'KML_EMPTY'],
    ['<kml><Placemark><LineString></Placemark></kml>', 'KML_INVALID_XML'],
    ['<kml/><kml/>', 'KML_INVALID_XML'],
    ['<p:kml/>', 'KML_INVALID_XML'],
    ['<kml><Document><name>&unknown;</name></Document></kml>', 'KML_INVALID_XML'],
    ['<gpx/>', 'KML_INVALID_FORMAT'],
    ['<kml xmlns="urn:wrong"/>', 'KML_INVALID_FORMAT'],
    ['<kml/>', 'KML_NO_TRACK'],
    [kml(`<Placemark>${line('NaN,0 1,91')}</Placemark>`), 'KML_NO_TRACK'],
    ['<!DOCTYPE kml SYSTEM "https://example.invalid/external.dtd"><kml/>', 'KML_UNSUPPORTED_DTD'],
    ['<!DOCTYPE kml [<!ENTITY evil "104,30 104.001,30">]><kml><Placemark><LineString><coordinates>&evil;</coordinates></LineString></Placemark></kml>', 'KML_UNSUPPORTED_DTD'],
  ];
  for (const [xml, code] of cases) assert.throws(() => parser('parseKmlXml')(xml), hasCode(code), code);
});

test('route dispatch honors extensions and uses the actual XML root when no filename is supplied', () => {
  const parse = parser('parseRouteXml');
  const gpx = '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:rte><g:rtept lat="1" lon="2"/></g:rte></g:gpx>';
  const route = `\uFEFF<?xml version="1.0"?><!-- <gpx/> --><p:kml xmlns:p="http://www.opengis.net/kml/2.2"><p:Placemark><p:LineString><p:coordinates>2,1</p:coordinates></p:LineString></p:Placemark></p:kml>`;
  assert.deepEqual(parse(gpx), parseGpxXml(gpx));
  assert.deepEqual(parse(gpx, { fileName: 'route.GPX' }), parseGpxXml(gpx, { fileName: 'route.GPX' }));
  assert.equal(parse(route).pointCount, 1);
  assert.equal(parse(route, { fileName: 'route.KML' }).name, 'route');
  assert.throws(() => parse(route, { fileName: 'route.gpx' }), error => error instanceof GpxParseError && error.code === 'GPX_INVALID_FORMAT');
  assert.throws(() => parse(gpx, { fileName: 'route.kml' }), hasCode('KML_INVALID_FORMAT'));
  assert.throws(() => parse(gpx, { fileName: 'route.txt' }), hasCode('ROUTE_UNSUPPORTED_FORMAT'));
  assert.throws(() => parse('<other><kml/></other>'), hasCode('ROUTE_INVALID_FORMAT'));
  assert.throws(() => parse('<kml/> broken'), hasCode('KML_INVALID_XML'));
  assert.throws(() => parse('<gpx/><gpx/>'), error => error instanceof GpxParseError && error.code === 'GPX_INVALID_XML');
  assert.throws(() => parse(''), hasCode('ROUTE_EMPTY'));
});
