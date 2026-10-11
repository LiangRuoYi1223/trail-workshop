import { SaxesParser } from 'saxes';
import { parseGpxXml, type GpxParseOptions, type GpxParseResult } from '../gpx/parse-gpx.js';
import { parseKmlXml } from '../kml/parse-kml.js';

export type RouteFormat = 'gpx' | 'kml';
export type RouteParseOptions = GpxParseOptions;
export type RouteParseErrorCode = 'ROUTE_EMPTY' | 'ROUTE_INVALID_XML' | 'ROUTE_INVALID_FORMAT' | 'ROUTE_UNSUPPORTED_FORMAT';
export class RouteParseError extends Error {
  constructor(public readonly code: RouteParseErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'RouteParseError';
  }
}

/** Determine the format from the selected extension, or from a parsed XML root. */
export function detectRouteFormat(xml: string, options: RouteParseOptions = {}): RouteFormat {
  if (options.fileName !== undefined) {
    const extension = options.fileName.split(/[\\/]/).pop()?.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    if (extension === 'gpx' || extension === 'kml') return extension;
    throw new RouteParseError('ROUTE_UNSUPPORTED_FORMAT', '请选择 .gpx 或 .kml 路线文件');
  }
  if (!xml.trim()) throw new RouteParseError('ROUTE_EMPTY', '路线文件为空');
  const parser = new SaxesParser({ xmlns: true });
  const rootFound = {};
  let rootName: string | undefined;
  parser.on('opentag', tag => { rootName = tag.local; throw rootFound; });
  try { parser.write(xml).close(); }
  catch (error) {
    if (error !== rootFound) throw new RouteParseError('ROUTE_INVALID_XML', '路线 XML 格式无效或文件不完整', error);
  }
  if (rootName === 'gpx' || rootName === 'kml') return rootName;
  throw new RouteParseError('ROUTE_INVALID_FORMAT', 'XML 根元素不是支持的 GPX 或 KML');
}

/** Preserve the established normalized route contract for either input format. */
export function parseRouteXml(xml: string, options: RouteParseOptions = {}): GpxParseResult {
  return detectRouteFormat(xml, options) === 'kml' ? parseKmlXml(xml, options) : parseGpxXml(xml, options);
}
