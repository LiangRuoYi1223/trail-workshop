import { SaxesParser, type SaxesTagNS } from "saxes";

export interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: string;
}

export interface GpxBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** A continuous run; invalid coordinates split a source segment into runs. */
export interface GpxSegment {
  kind: "track" | "route";
  /** Zero-based index amongst tracks or routes of the same kind. */
  sourceIndex: number;
  /** Original trkseg index; routes use zero. */
  segmentIndex: number;
  /** Run index within the original segment after invalid-point breaks. */
  partIndex: number;
  name?: string;
  points: GpxPoint[];
  distanceKm: number;
}

export interface GpxParseResult {
  name?: string;
  segments: GpxSegment[];
  bbox: GpxBounds;
  suggestedCenter: { lat: number; lon: number };
  pointCount: number;
  sourcePointCount: number;
  invalidPointCount: number;
  segmentCount: number;
  /** Horizontal great-circle distance, summed only within continuous runs. */
  distanceKm: number;
  /** The ordinary min/max longitude bbox is unsuitable for a local crop. */
  crossesAntimeridian: boolean;
}

export interface GpxParseOptions {
  fileName?: string;
}

export type GpxParseErrorCode =
  | "GPX_EMPTY"
  | "GPX_INVALID_XML"
  | "GPX_INVALID_FORMAT"
  | "GPX_UNSUPPORTED_DTD"
  | "GPX_NO_TRACK";

export class GpxParseError extends Error {
  constructor(
    public readonly code: GpxParseErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "GpxParseError";
  }
}

interface Source {
  kind: GpxSegment["kind"];
  index: number;
  segmentCount: number;
  name?: string;
}

interface SourceSegment {
  source: Source;
  index: number;
  nextPartIndex: number;
  currentRun: GpxPoint[];
}

interface ParsedRun {
  source: Source;
  segmentIndex: number;
  partIndex: number;
  points: GpxPoint[];
}

type Role =
  | "gpx"
  | "metadata"
  | "track"
  | "route"
  | "segment"
  | "point"
  | "name"
  | "elevation"
  | "time"
  | "ignored";

interface Frame {
  role: Role;
  source?: Source;
  segment?: SourceSegment;
  point?: GpxPoint;
  text: string;
}

const GPX_NAMESPACES = new Set([
  "",
  "http://www.topografix.com/GPX/1/0",
  "http://www.topografix.com/GPX/1/1",
]);
const EARTH_RADIUS_KM = 6371.0088;

function numericValue(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function coordinateAttribute(tag: SaxesTagNS, local: string): number | undefined {
  const attribute = Object.values(tag.attributes).find(
    (item) => item.local === local && item.uri === "",
  );
  return numericValue(attribute?.value);
}

function pointFromTag(tag: SaxesTagNS): GpxPoint | undefined {
  const lat = coordinateAttribute(tag, "lat");
  const lon = coordinateAttribute(tag, "lon");
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return undefined;
  }
  return { lat, lon };
}

function distanceKm(points: GpxPoint[]): number {
  let distance = 0;
  const radians = Math.PI / 180;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dLat = (b.lat - a.lat) * radians;
    const dLon = (b.lon - a.lon) * radians;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
    distance += 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  return distance;
}

function fileNameTitle(fileName: string | undefined): string | undefined {
  const title = fileName?.split(/[\\/]/).pop()?.replace(/\.gpx$/i, "").trim();
  return title || undefined;
}

/**
 * Parse GPX 1.0/1.1 (including namespace-free exports) without filesystem or
 * process state. Track segments and routes stay separate, in document order.
 * Waypoints/extensions are not converted into an invented connected route.
 */
export function parseGpxXml(xml: string, options: GpxParseOptions = {}): GpxParseResult {
  if (!xml.trim()) throw new GpxParseError("GPX_EMPTY", "GPX 文件为空");

  const parser = new SaxesParser({ xmlns: true });
  const stack: Frame[] = [];
  const runs: ParsedRun[] = [];
  const sources: Source[] = [];
  let rootNamespace: string | undefined;
  let trackCount = 0;
  let routeCount = 0;
  let documentName: string | undefined;
  let sourcePointCount = 0;
  let invalidPointCount = 0;

  function finishRun(segment: SourceSegment): void {
    if (segment.currentRun.length === 0) return;
    runs.push({
      source: segment.source,
      segmentIndex: segment.index,
      partIndex: segment.nextPartIndex++,
      points: segment.currentRun,
    });
    segment.currentRun = [];
  }

  parser.on("doctype", () => {
    throw new GpxParseError("GPX_UNSUPPORTED_DTD", "GPX 不支持 DTD 或自定义实体声明");
  });

  parser.on("opentag", (tag) => {
    const parent = stack[stack.length - 1];
    const frame: Frame = { role: "ignored", text: "" };
    if (!parent) {
      if (tag.local !== "gpx" || !GPX_NAMESPACES.has(tag.uri)) {
        throw new GpxParseError("GPX_INVALID_FORMAT", "XML 根元素不是支持的 GPX");
      }
      rootNamespace = tag.uri;
      frame.role = "gpx";
    } else if (tag.uri === rootNamespace) {
      if (parent.role === "gpx" && tag.local === "metadata") {
        frame.role = "metadata";
      } else if (parent.role === "gpx" && (tag.local === "trk" || tag.local === "rte")) {
        const kind = tag.local === "trk" ? "track" : "route";
        const source: Source = {
          kind,
          index: kind === "track" ? trackCount++ : routeCount++,
          segmentCount: 0,
        };
        sources.push(source);
        frame.role = kind;
        frame.source = source;
        if (kind === "route") {
          frame.segment = { source, index: 0, nextPartIndex: 0, currentRun: [] };
        }
      } else if (parent.role === "track" && tag.local === "trkseg") {
        const source = parent.source!;
        frame.role = "segment";
        frame.segment = {
          source,
          index: source.segmentCount++,
          nextPartIndex: 0,
          currentRun: [],
        };
      } else if (
        (parent.role === "segment" && tag.local === "trkpt")
        || (parent.role === "route" && tag.local === "rtept")
      ) {
        frame.role = "point";
        frame.segment = parent.segment!;
        frame.point = pointFromTag(tag);
      } else if (
        tag.local === "name"
        && ["gpx", "metadata", "track", "route"].includes(parent.role)
      ) {
        frame.role = "name";
      } else if (parent.role === "point" && tag.local === "ele") {
        frame.role = "elevation";
      } else if (parent.role === "point" && tag.local === "time") {
        frame.role = "time";
      }
    }
    stack.push(frame);
  });

  const appendText = (text: string): void => {
    const frame = stack[stack.length - 1];
    if (frame && ["name", "elevation", "time"].includes(frame.role)) frame.text += text;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);

  parser.on("closetag", () => {
    const frame = stack.pop()!;
    const parent = stack[stack.length - 1];
    if (frame.role === "name") {
      const name = frame.text.trim();
      if (name) {
        if (parent?.source) parent.source.name = name;
        else documentName = name;
      }
    } else if (frame.role === "elevation" && parent?.point) {
      const elevation = numericValue(frame.text);
      if (elevation !== undefined) parent.point.ele = elevation;
    } else if (frame.role === "time" && parent?.point && frame.text.trim()) {
      parent.point.time = frame.text.trim();
    } else if (frame.role === "point") {
      sourcePointCount++;
      if (frame.point) frame.segment!.currentRun.push(frame.point);
      else {
        invalidPointCount++;
        finishRun(frame.segment!);
      }
    } else if (frame.role === "segment" || frame.role === "route") {
      finishRun(frame.segment!);
    }
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof GpxParseError) throw error;
    throw new GpxParseError("GPX_INVALID_XML", "GPX XML 格式无效或文件不完整", error);
  }

  if (runs.length === 0) {
    throw new GpxParseError("GPX_NO_TRACK", "GPX 没有有效的 trk/trkseg 或 rte 路线点");
  }

  const segments = runs.map((run): GpxSegment => ({
    kind: run.source.kind,
    sourceIndex: run.source.index,
    segmentIndex: run.segmentIndex,
    partIndex: run.partIndex,
    ...(run.source.name ? { name: run.source.name } : {}),
    points: run.points,
    distanceKm: distanceKm(run.points),
  }));
  const bbox: GpxBounds = {
    minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity,
  };
  let pointCount = 0;
  let totalDistanceKm = 0;
  for (const segment of segments) {
    totalDistanceKm += segment.distanceKm;
    for (const point of segment.points) {
      pointCount++;
      bbox.minLat = Math.min(bbox.minLat, point.lat);
      bbox.maxLat = Math.max(bbox.maxLat, point.lat);
      bbox.minLon = Math.min(bbox.minLon, point.lon);
      bbox.maxLon = Math.max(bbox.maxLon, point.lon);
    }
  }
  const name = documentName ?? sources.find((source) => source.name)?.name ?? fileNameTitle(options.fileName);

  return {
    ...(name ? { name } : {}),
    segments,
    bbox,
    suggestedCenter: {
      lat: (bbox.minLat + bbox.maxLat) / 2,
      lon: (bbox.minLon + bbox.maxLon) / 2,
    },
    pointCount,
    sourcePointCount,
    invalidPointCount,
    segmentCount: segments.length,
    distanceKm: totalDistanceKm,
    crossesAntimeridian: bbox.maxLon - bbox.minLon > 180,
  };
}
