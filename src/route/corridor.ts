/** Route buffer/booleans use clipper-lib 6.4.2 (Boost Software License 1.0).
 * Keep all shared XY geometry on this integer lattice before triangulation.
 */
import ClipperLib from 'clipper-lib';
import { TerrainError } from '../errors.js';

export const SCALE = 100_000;
export const TOLERANCE_MM = 1 / SCALE;
export const DEFAULT_ARC_TOLERANCE_MM = 0.01;
const MAX_INTEGER_COORDINATE = 4_000_000_000_000_000;
export interface IntPoint { X: number; Y: number }
export interface PointMm { x: number; y: number }
export interface PolygonRegion { outer: IntPoint[]; holes: IntPoint[][] }
export type PolygonOperation = 'union' | 'intersection' | 'difference';
export interface RouteCorridorOptions { widthMm?: number; arcToleranceMm?: number }
export interface RouteCorridor {
  scale: number;
  toleranceMm: number;
  arcToleranceMm: number;
  widthMm: number;
  regions: PolygonRegion[];
  paths: IntPoint[][];
  bufferedRegions: PolygonRegion[];
  areaMm2: number;
  inputSegmentCount: number;
  effectiveSegmentCount: number;
  pointCount: number;
}

function validateIntPoint(point: IntPoint): void {
  if (!Number.isSafeInteger(point.X) || !Number.isSafeInteger(point.Y)
      || Math.abs(point.X) > MAX_INTEGER_COORDINATE || Math.abs(point.Y) > MAX_INTEGER_COORDINATE) {
    throw new TerrainError('ROUTE_GEOMETRY_INVALID', '路线坐标超出整数几何允许的范围');
  }
}

export function toIntPoint(point: PointMm): IntPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new TerrainError('ROUTE_GEOMETRY_INVALID', '路线坐标必须是有限数字');
  const result = { X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) };
  validateIntPoint(result);
  // Do not retain negative zero as a distinct-looking exported coordinate.
  return { X: result.X || 0, Y: result.Y || 0 };
}

export function toMmPoint(point: IntPoint): PointMm {
  return { x: point.X / SCALE, y: point.Y / SCALE };
}

function samePoint(a: IntPoint, b: IntPoint): boolean { return a.X === b.X && a.Y === b.Y; }

function cleanPath(path: readonly IntPoint[], closed: boolean): IntPoint[] {
  const result: IntPoint[] = [];
  for (const point of path) {
    validateIntPoint(point);
    if (!result.length || !samePoint(result.at(-1)!, point)) result.push({ X: point.X, Y: point.Y });
  }
  if (closed && result.length > 1 && samePoint(result[0]!, result.at(-1)!)) result.pop();
  return result;
}

/** Signed planar area in lattice units; outer CCW rings have positive area. */
export function signedArea(path: readonly IntPoint[]): number {
  if (path.length < 3) return 0;
  // Translate to reduce cancellation on routes far from the model origin.
  const origin = path[0]!;
  let twice = 0;
  for (let i = 1; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!;
    twice += (a.X - origin.X) * (b.Y - origin.Y) - (a.Y - origin.Y) * (b.X - origin.X);
  }
  return twice / 2;
}

function orientedPath(path: readonly IntPoint[], ccw: boolean): IntPoint[] {
  const result = cleanPath(path, true);
  if ((signedArea(result) > 0) !== ccw) result.reverse();
  return result;
}

function regionsFromTree(tree: ClipperLib.PolyTree): PolygonRegion[] {
  const result: PolygonRegion[] = [];
  const visit = (node: ClipperLib.PolyNode): void => {
    if (!node.IsHole() && node.Contour().length >= 3) {
      const outer = orientedPath(node.Contour(), true);
      const holes = node.Childs().filter(child => child.IsHole() && child.Contour().length >= 3)
        .map(child => orientedPath(child.Contour(), false)).filter(hole => signedArea(hole) !== 0);
      if (signedArea(outer) !== 0) result.push({ outer, holes });
    }
    for (const child of node.Childs()) visit(child);
  };
  for (const node of tree.Childs()) visit(node);
  return result;
}

export function regionsToPaths(regions: readonly PolygonRegion[]): IntPoint[][] {
  return regions.flatMap(region => [region.outer, ...region.holes].map(path => cleanPath(path, true)));
}

/** Non-zero winding keeps holes; each outer/hole ring must have opposite winding. */
export function polygonBoolean(
  subject: readonly (readonly IntPoint[])[],
  clip: readonly (readonly IntPoint[])[],
  operation: PolygonOperation,
): PolygonRegion[] {
  if (!['union', 'intersection', 'difference'].includes(operation))
    throw new TerrainError('ROUTE_GEOMETRY_INVALID', '不支持的平面几何运算');
  const subjects = subject.map(path => cleanPath(path, true)).filter(path => path.length >= 3);
  const clips = clip.map(path => cleanPath(path, true)).filter(path => path.length >= 3);
  if (operation === 'intersection' && (!subjects.length || !clips.length)) return [];
  if (operation === 'difference' && !subjects.length) return [];
  if (operation === 'union') subjects.push(...clips.splice(0));
  if (!subjects.length) return [];
  // Runtime 6.4.2 exposes these as instance flags (its typings also list a missing InitOptions enum).
  const engine = new ClipperLib.Clipper();
  engine.StrictlySimple = true;
  engine.PreserveCollinear = true;
  engine.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true);
  if (clips.length) engine.AddPaths(clips, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  const kind = operation === 'intersection' ? ClipperLib.ClipType.ctIntersection
    : operation === 'difference' ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion;
  if (!engine.Execute(kind, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero))
    throw new TerrainError('ROUTE_GEOMETRY_FAILED', '路线平面几何运算失败');
  return regionsFromTree(tree);
}

export function pathsToRegions(paths: readonly (readonly IntPoint[])[]): PolygonRegion[] {
  return polygonBoolean(paths, [], 'union');
}

export function regionsAreaMm2(regions: readonly PolygonRegion[]): number {
  return regions.reduce((sum, region) => sum + signedArea(region.outer)
    + region.holes.reduce((holeSum, hole) => holeSum + signedArea(hole), 0), 0) / (SCALE * SCALE);
}

/** Buffer original independent centerlines first, then clip their union to the terrain.
 * Never join retained points across an excursion outside the footprint or a GPX gap.
 * The returned 2D set is later raised exactly once by the unified mesh builder.
 */
export function buildRouteCorridor(
  segmentsMm: readonly (readonly PointMm[])[],
  footprintMm: readonly PointMm[],
  options: RouteCorridorOptions = {},
): RouteCorridor {
  const widthMm = options.widthMm ?? 1;
  const arcToleranceMm = options.arcToleranceMm ?? DEFAULT_ARC_TOLERANCE_MM;
  if (!Number.isFinite(widthMm) || widthMm < 2 * TOLERANCE_MM
      || !Number.isFinite(arcToleranceMm) || arcToleranceMm < TOLERANCE_MM || arcToleranceMm > widthMm / 4) {
    throw new TerrainError('CONFIG_INVALID', '路线线宽须为正数，圆弧误差须在整数精度与线宽四分之一之间');
  }
  const footprint = orientedPath(footprintMm.map(toIntPoint), true);
  if (footprint.length < 3 || signedArea(footprint) <= 0)
    throw new TerrainError('ROUTE_GEOMETRY_INVALID', '地形轮廓须有至少三个不共线点');
  const offset = new ClipperLib.ClipperOffset(2, arcToleranceMm * SCALE);
  let effectiveSegmentCount = 0, pointCount = 0;
  for (const segment of segmentsMm) {
    const path = cleanPath(segment.map(toIntPoint), false);
    // A single retained GPS point is not a continuous route.
    if (path.length < 2) continue;
    const closed = path.length >= 4 && samePoint(path[0]!, path.at(-1)!);
    if (closed) path.pop();
    pointCount += path.length;
    effectiveSegmentCount++;
    offset.AddPath(path, ClipperLib.JoinType.jtRound,
      closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
  }
  const buffered: IntPoint[][] = [];
  if (effectiveSegmentCount) offset.Execute(buffered, widthMm * SCALE / 2);
  const regions = buffered.length ? polygonBoolean(buffered, [footprint], 'intersection') : [];
  return {
    scale: SCALE, toleranceMm: TOLERANCE_MM, arcToleranceMm, widthMm, regions,bufferedRegions:pathsToRegions(buffered),
    paths: regionsToPaths(regions), areaMm2: regionsAreaMm2(regions),
    inputSegmentCount: segmentsMm.length, effectiveSegmentCount, pointCount,
  };
}
