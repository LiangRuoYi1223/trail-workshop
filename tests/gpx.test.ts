import assert from "node:assert/strict";
import { test } from "node:test";
import { GpxParseError, parseGpxXml } from "../src/gpx/parse-gpx.js";

test("namespace prefixes, entities, CDATA and reversed attribute order preserve document order", () => {
  const result = parseGpxXml(`<?xml version="1.0"?>
    <g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" version="1.1">
      <g:metadata><g:name>山谷 &amp; 山脊</g:name></g:metadata>
      <g:trk><g:name><![CDATA[甲 < 乙]]></g:name><g:trkseg>
        <g:trkpt lon="104.2" lat="30.1"><g:ele>1200.5</g:ele><g:time>2026-10-08T01:00:00Z</g:time></g:trkpt>
        <g:trkpt lat="30.2" lon="104.3" />
        <g:trkpt lon="104.4" lat="30.3"><g:ele>broken</g:ele></g:trkpt>
      </g:trkseg></g:trk>
    </g:gpx>`);

  assert.equal(result.name, "山谷 & 山脊");
  assert.equal(result.segments[0]!.name, "甲 < 乙");
  assert.deepEqual(result.segments[0]!.points, [
    { lat: 30.1, lon: 104.2, ele: 1200.5, time: "2026-10-08T01:00:00Z" },
    { lat: 30.2, lon: 104.3 },
    { lat: 30.3, lon: 104.4 },
  ]);
  assert.deepEqual(result.bbox, { minLat: 30.1, maxLat: 30.3, minLon: 104.2, maxLon: 104.4 });
  assert.equal(result.pointCount, 3);
  assert.equal(result.invalidPointCount, 0);
});

test("tracks, trkseg and routes remain separate and distances exclude the gaps", () => {
  const result = parseGpxXml(`<gpx xmlns="http://www.topografix.com/GPX/1/0" version="1.0">
    <trk><name>第一轨迹</name>
      <trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="0.001"/></trkseg>
      <trkseg><trkpt lat="45" lon="100"/><trkpt lat="45" lon="100.001"/></trkseg>
    </trk>
    <rte><name>规划路线</name><rtept lat="10" lon="10"/><rtept lat="10" lon="10.001"/></rte>
    <trk><trkseg><trkpt lat="-20" lon="-20"/><trkpt lat="-20" lon="-19.999"/></trkseg></trk>
  </gpx>`);

  assert.deepEqual(result.segments.map(({ kind, sourceIndex, segmentIndex, partIndex }) => (
    { kind, sourceIndex, segmentIndex, partIndex }
  )), [
    { kind: "track", sourceIndex: 0, segmentIndex: 0, partIndex: 0 },
    { kind: "track", sourceIndex: 0, segmentIndex: 1, partIndex: 0 },
    { kind: "route", sourceIndex: 0, segmentIndex: 0, partIndex: 0 },
    { kind: "track", sourceIndex: 1, segmentIndex: 0, partIndex: 0 },
  ]);
  assert.equal(result.pointCount, 8);
  assert.equal(result.segmentCount, 4);
  assert.ok(result.distanceKm > 0.35 && result.distanceKm < 0.45, "远距离段间跳跃不计入里程");
  assert.ok(Math.abs(result.segments[0]!.distanceKm - 0.11119508) < 0.000001);
});

test("invalid coordinate points break continuity instead of bridging remaining valid points", () => {
  const result = parseGpxXml(`<gpx><trk><trkseg>
    <trkpt lat="0" lon="0"/>
    <trkpt lat="not-a-number" lon="1"/>
    <trkpt lat="91" lon="2"/>
    <trkpt lat="0" lon="100"/>
    <trkpt lat="0" lon="100.001"/>
    <trkpt lat="0x10" lon="100.002"/>
    <trkpt lat="0" lon="200"/>
    <trkpt lat="" lon="100.003"/>
    <trkpt lat="0"/>
    <trkpt lat="Infinity" lon="100.004"/>
    <trkpt lat="0" lon="-100"/>
  </trkseg></trk></gpx>`);

  assert.deepEqual(result.segments.map((segment) => segment.points.length), [1, 2, 1]);
  assert.deepEqual(result.segments.map((segment) => segment.partIndex), [0, 1, 2]);
  assert.equal(result.sourcePointCount, 11);
  assert.equal(result.invalidPointCount, 7);
  assert.equal(result.pointCount, 4);
  assert.ok(result.distanceKm > 0.11 && result.distanceKm < 0.12);
});

test("GPX extension lookalikes and isolated waypoints cannot invent track points", () => {
  const result = parseGpxXml(`<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:x="urn:extension">
    <wpt lat="80" lon="80"/>
    <extensions><trk><trkseg><trkpt lat="75" lon="75"/></trkseg></trk></extensions>
    <trk><trkseg>
      <x:trkpt lat="70" lon="70"/>
      <trkpt lat="30" lon="104"><extensions><x:ele>9000</x:ele></extensions></trkpt>
      <trkpt lat="30.001" lon="104.001"/>
    </trkseg></trk>
  </gpx>`);
  assert.equal(result.pointCount, 2);
  assert.equal(result.bbox.maxLat, 30.001);
  assert.equal(result.segments[0]!.points[0]!.ele, undefined);
  assert.throws(
    () => parseGpxXml('<gpx><wpt lat="30" lon="104"/><wpt lat="31" lon="105"/></gpx>'),
    (error: unknown) => error instanceof GpxParseError && error.code === "GPX_NO_TRACK",
  );
});

test("strict XML errors are rejected instead of returning a partially recovered route", () => {
  const invalidDocuments = [
    '<gpx><trk><trkseg><trkpt lat="30" lon="104"/></trk></gpx>',
    '<gpx/><gpx/>',
    '<gpx><trk><trkseg><trkpt lat="30" lat="31" lon="104"/></trkseg></trk></gpx>',
    '<gpx><trk><name>Unknown &entity;</name></trk></gpx>',
    '<p:gpx><p:trk/></p:gpx>',
  ];
  for (const xml of invalidDocuments) {
    assert.throws(
      () => parseGpxXml(xml),
      (error: unknown) => error instanceof GpxParseError && error.code === "GPX_INVALID_XML",
    );
  }
  assert.throws(
    () => parseGpxXml('<other><trk><trkseg><trkpt lat="30" lon="104"/></trkseg></trk></other>'),
    (error: unknown) => error instanceof GpxParseError && error.code === "GPX_INVALID_FORMAT",
  );
  assert.throws(
    () => parseGpxXml('<gpx xmlns="urn:not-gpx"/>'),
    (error: unknown) => error instanceof GpxParseError && error.code === "GPX_INVALID_FORMAT",
  );
});

test("empty, all-invalid and DTD documents produce clear typed errors", () => {
  for (const [xml, code] of [
    [" \n\t", "GPX_EMPTY"],
    ['<gpx><rte><rtept lat="NaN" lon="0"/></rte></gpx>', "GPX_NO_TRACK"],
    ['<!DOCTYPE gpx SYSTEM "https://example.invalid/external.dtd"><gpx/>', "GPX_UNSUPPORTED_DTD"],
  ]) {
    assert.throws(
      () => parseGpxXml(xml!),
      (error: unknown) => error instanceof GpxParseError && error.code === code,
    );
  }
});

test("file title fallback and independent parses do not share previous track data", () => {
  const first = parseGpxXml('<gpx><rte><name>甲</name><rtept lat="1" lon="2"/></rte></gpx>');
  const second = parseGpxXml('<gpx><trk><trkseg><trkpt lat="-1" lon="-2"/></trkseg></trk></gpx>', {
    fileName: "C:\\导出\\乙.GPX",
  });
  assert.equal(first.name, "甲");
  assert.equal(second.name, "乙");
  assert.deepEqual(second.bbox, { minLat: -1, maxLat: -1, minLon: -2, maxLon: -2 });
  assert.deepEqual(second.suggestedCenter, { lat: -1, lon: -2 });
  assert.equal(second.distanceKm, 0);
});

test("antimeridian crossing is flagged while route distance uses the short arc", () => {
  const result = parseGpxXml('<gpx><rte><rtept lat="0" lon="179.999"/><rtept lat="0" lon="-179.999"/></rte></gpx>');
  assert.equal(result.crossesAntimeridian, true);
  assert.ok(result.distanceKm > 0.22 && result.distanceKm < 0.23);
});
