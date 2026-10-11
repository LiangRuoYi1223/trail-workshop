import { SaxesParser } from 'saxes';
import type { GpxBounds, GpxParseOptions, GpxParseResult, GpxPoint, GpxSegment } from '../gpx/parse-gpx.js';

export type KmlParseErrorCode = 'KML_EMPTY' | 'KML_INVALID_XML' | 'KML_INVALID_FORMAT' | 'KML_UNSUPPORTED_DTD' | 'KML_NO_TRACK';
export class KmlParseError extends Error {
  constructor(public readonly code: KmlParseErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'KmlParseError';
  }
}
export type KmlParseOptions = GpxParseOptions;

const KML_NAMESPACES = new Set([
  '', 'http://www.opengis.net/kml/2.2', 'http://earth.google.com/kml/2.0',
  'http://earth.google.com/kml/2.1', 'http://earth.google.com/kml/2.2',
]);
const GX_NAMESPACE = 'http://www.google.com/kml/ext/2.2';
const EARTH_RADIUS_KM = 6371.0088;

interface Source { index?: number; nextSegmentIndex: number; name?: string; hasValidRun: boolean }
interface Geometry { source: Source; index: number; points: Array<GpxPoint | undefined>; times: string[] }
interface Run { source: Source; segmentIndex: number; partIndex: number; points: GpxPoint[] }
type Role = 'kml' | 'document' | 'folder' | 'placemark' | 'multi' | 'multitrack' | 'line' | 'track' | 'coordinates' | 'coord' | 'when' | 'name' | 'ignored';
interface Frame { role: Role; text: string; source?: Source; geometry?: Geometry; topDocument?: boolean }

function numericValue(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function coordinatePoint(parts: string[]): GpxPoint | undefined {
  if (parts.length < 2 || parts.length > 3) return undefined;
  const lon = numericValue(parts[0]), lat = numericValue(parts[1]);
  if (lon === undefined || lat === undefined || Math.abs(lon) > 180 || Math.abs(lat) > 90) return undefined;
  const ele = numericValue(parts[2]);
  return { lon, lat, ...(ele !== undefined ? { ele } : {}) };
}

function distanceKm(points: GpxPoint[]): number {
  let distance = 0;
  const radians = Math.PI / 180;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!;
    const dLat = (b.lat - a.lat) * radians, dLon = (b.lon - a.lon) * radians;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
    distance += 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  return distance;
}

/** Normalize local route geometries without connecting separate paths or loading links. */
export function parseKmlXml(xml: string, options: KmlParseOptions = {}): GpxParseResult {
  if (!xml.trim()) throw new KmlParseError('KML_EMPTY', 'KML 文件为空');
  const parser = new SaxesParser({ xmlns: true });
  const stack: Frame[] = [], sources: Source[] = [], runs: Run[] = [];
  let rootNamespace: string | undefined, topDocumentSeen = false, documentName: string | undefined;
  let sourcePointCount = 0, invalidPointCount = 0;

  function startGeometry(source: Source): Geometry {
    if (source.index === undefined) { source.index = sources.length; sources.push(source); }
    return { source, index: source.nextSegmentIndex++, points: [], times: [] };
  }

  function finishGeometry(geometry: Geometry): void {
    let points: GpxPoint[] = [], partIndex = 0;
    const finishRun = (): void => {
      if (!points.length) return;
      runs.push({ source: geometry.source, segmentIndex: geometry.index, partIndex: partIndex++, points });
      geometry.source.hasValidRun = true;
      points = [];
    };
    for (let index = 0; index < geometry.points.length; index++) {
      sourcePointCount++;
      const point = geometry.points[index];
      if (!point) { invalidPointCount++; finishRun(); continue; }
      const time = geometry.times[index];
      if (time) point.time = time;
      points.push(point);
    }
    finishRun();
  }

  parser.on('doctype', () => {
    throw new KmlParseError('KML_UNSUPPORTED_DTD', 'KML 不支持 DTD 或自定义实体声明');
  });
  parser.on('opentag', tag => {
    const parent = stack.at(-1);
    const frame: Frame = { role: 'ignored', text: '' };
    if (!parent) {
      if (tag.local !== 'kml' || !KML_NAMESPACES.has(tag.uri)) {
        throw new KmlParseError('KML_INVALID_FORMAT', 'XML 根元素不是支持的 KML');
      }
      rootNamespace = tag.uri;
      frame.role = 'kml';
    } else if (tag.uri === rootNamespace) {
      const isContainer = ['kml', 'document', 'folder'].includes(parent.role);
      const isGeometryParent = ['placemark', 'multi'].includes(parent.role);
      if (isContainer && (tag.local === 'Document' || tag.local === 'Folder')) {
        frame.role = tag.local === 'Document' ? 'document' : 'folder';
        if (frame.role === 'document' && !topDocumentSeen) {
          frame.topDocument = true;
          topDocumentSeen = true;
        }
      } else if (isContainer && tag.local === 'Placemark') {
        frame.role = 'placemark';
        frame.source = { nextSegmentIndex: 0, hasValidRun: false };
      } else if (isGeometryParent && tag.local === 'MultiGeometry') {
        frame.role = 'multi';
        frame.source = parent.source;
      } else if (isGeometryParent && tag.local === 'LineString') {
        frame.role = 'line';
        frame.geometry = startGeometry(parent.source!);
      } else if (parent.role === 'line' && tag.local === 'coordinates') {
        frame.role = 'coordinates';
        frame.geometry = parent.geometry;
      } else if (tag.local === 'name' && ['document', 'placemark'].includes(parent.role)) {
        frame.role = 'name';
      } else if (parent.role === 'track' && tag.local === 'when') {
        frame.role = 'when';
        frame.geometry = parent.geometry;
      }
    } else if (tag.uri === GX_NAMESPACE) {
      if (['placemark', 'multi'].includes(parent.role) && tag.local === 'MultiTrack') {
        frame.role = 'multitrack';
        frame.source = parent.source;
      } else if (['placemark', 'multi', 'multitrack'].includes(parent.role) && tag.local === 'Track') {
        frame.role = 'track';
        frame.geometry = startGeometry(parent.source!);
      } else if (parent.role === 'track' && tag.local === 'coord') {
        frame.role = 'coord';
        frame.geometry = parent.geometry;
      }
    }
    stack.push(frame);
  });
  const appendText = (text: string): void => {
    const frame = stack.at(-1);
    if (frame && ['name', 'coordinates', 'coord', 'when'].includes(frame.role)) frame.text += text;
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    const frame = stack.pop()!, parent = stack.at(-1);
    if (frame.role === 'name') {
      const name = frame.text.trim();
      if (name && parent?.role === 'placemark') parent.source!.name = name;
      else if (name && parent?.topDocument) documentName = name;
    } else if (frame.role === 'coordinates') {
      const text = frame.text.trim();
      if (text) for (const tuple of text.split(/\s+/)) frame.geometry!.points.push(coordinatePoint(tuple.split(',')));
    } else if (frame.role === 'coord') {
      frame.geometry!.points.push(coordinatePoint(frame.text.trim().split(/\s+/)));
    } else if (frame.role === 'when') {
      frame.geometry!.times.push(frame.text.trim());
    } else if (frame.role === 'line' || frame.role === 'track') {
      finishGeometry(frame.geometry!);
    }
  });
  try { parser.write(xml).close(); }
  catch (error) {
    if (error instanceof KmlParseError) throw error;
    throw new KmlParseError('KML_INVALID_XML', 'KML XML 格式无效或文件不完整', error);
  }
  if (!runs.length) throw new KmlParseError('KML_NO_TRACK', 'KML 没有有效的 LineString 或 gx:Track 路线点');
  const segments = runs.map((run): GpxSegment => ({
    kind: 'track', sourceIndex: run.source.index!, segmentIndex: run.segmentIndex, partIndex: run.partIndex,
    ...(run.source.name ? { name: run.source.name } : {}), points: run.points, distanceKm: distanceKm(run.points),
  }));
  const bbox: GpxBounds = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  let pointCount = 0, totalDistanceKm = 0;
  for (const segment of segments) {
    totalDistanceKm += segment.distanceKm;
    for (const point of segment.points) {
      pointCount++;
      bbox.minLat = Math.min(bbox.minLat, point.lat); bbox.maxLat = Math.max(bbox.maxLat, point.lat);
      bbox.minLon = Math.min(bbox.minLon, point.lon); bbox.maxLon = Math.max(bbox.maxLon, point.lon);
    }
  }
  const fileName = options.fileName?.split(/[\\/]/).pop()?.replace(/\.kml$/i, '').trim();
  const name = documentName ?? sources.find(source => source.hasValidRun && source.name)?.name ?? (fileName || undefined);
  return {
    ...(name ? { name } : {}), segments, bbox,
    suggestedCenter: { lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2 },
    pointCount, sourcePointCount, invalidPointCount, segmentCount: segments.length, distanceKm: totalDistanceKm,
    crossesAntimeridian: bbox.maxLon - bbox.minLon > 180,
  };
}
