/** Independent STL section checks; no generator or mesh-validation code is used. */
export const DEFAULT_SECTION_HEIGHTS_MM = [0.5, 2.5, 5, 10, 15, 20] as const;

type Point2 = { x: number; y: number };
type Segment = { a: Point2; b: Point2; face: number };
type WeldedSegment = Segment & { from: number; to: number };

export interface SectionOptions {
  weldToleranceMm?: number;
  planeClearanceMm?: number;
  maxPlaneShiftMm?: number;
  intersectionToleranceMm?: number;
}

const DEFAULT_OPTIONS = {
  weldToleranceMm: 0.0001,
  planeClearanceMm: 0.0000001,
  maxPlaneShiftMm: 0.001,
  intersectionToleranceMm: 0.000000001,
};

export interface BinaryStl {
  triangleCount: number;
  /** Nine coordinates per triangle, in the exact Float32 STL values. */
  coordinates: Float64Array;
  vertexHeights: number[];
}

export function readBinaryStl(buffer: Buffer): BinaryStl {
  if (buffer.length < 84) throw new Error('Binary STL is shorter than its header.');
  const triangleCount = buffer.readUInt32LE(80);
  if (buffer.length !== 84 + triangleCount * 50) throw new Error('Binary STL triangle count does not match its byte length.');
  if (triangleCount === 0) throw new Error('Binary STL has no triangles.');
  const coordinates = new Float64Array(triangleCount * 9);
  const heights = new Set<number>();
  for (let face = 0; face < triangleCount; face++) {
    for (let coordinate = 0; coordinate < 9; coordinate++) {
      const value = buffer.readFloatLE(84 + face * 50 + 12 + coordinate * 4);
      if (!Number.isFinite(value)) throw new Error(`Triangle ${face} contains a non-finite coordinate.`);
      coordinates[face * 9 + coordinate] = value;
      if (coordinate % 3 === 2) heights.add(value);
    }
  }
  return { triangleCount, coordinates, vertexHeights: [...heights].sort((a, b) => a - b) };
}

function lowerBound(values: number[], value: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Avoid vertex and coplanar degeneracies; any adjustment is explicitly reported. */
function selectPlane(heights: number[], requested: number, options: typeof DEFAULT_OPTIONS): number {
  const clear = (z: number): boolean => {
    const index = lowerBound(heights, z);
    return (index === heights.length || heights[index]! - z > options.planeClearanceMm)
      && (index === 0 || z - heights[index - 1]! > options.planeClearanceMm);
  };
  if (clear(requested)) return requested;
  // A small practical offset avoids both exact planes and microscopic vertex tangencies.
  const step = Math.max(0.00001, options.planeClearanceMm * 2);
  for (let offset = step; offset <= options.maxPlaneShiftMm + Number.EPSILON; offset += step) {
    for (const z of [requested + offset, requested - offset]) if (clear(z)) return z;
  }
  throw new Error(`Cannot find a vertex-free plane within ${options.maxPlaneShiftMm} mm of ${requested} mm.`);
}

function slice(mesh: BinaryStl, z: number): Segment[] {
  const segments: Segment[] = [], positions = mesh.coordinates;
  for (let face = 0; face < mesh.triangleCount; face++) {
    const base = face * 9;
    const points: Point2[] = [];
    for (const [from, to] of [[0, 3], [3, 6], [6, 0]]) {
      const a = base + from, b = base + to;
      const az = positions[a + 2]!, bz = positions[b + 2]!;
      // selectPlane guarantees no vertex is on the sampled plane, so each face
      // contributes exactly zero or two strict edge crossings.
      if ((az < z) === (bz < z)) continue;
      const t = (z - az) / (bz - az);
      points.push({ x: positions[a]! + t * (positions[b]! - positions[a]!), y: positions[a + 1]! + t * (positions[b + 1]! - positions[a + 1]!) });
    }
    if (points.length === 2) segments.push({ a: points[0]!, b: points[1]!, face });
    else if (points.length !== 0) throw new Error(`Triangle ${face} has an unexpected ${points.length} plane intersections.`);
  }
  return segments;
}

/** Spatial-neighbour welding, including endpoints on opposite bucket boundaries. */
function weld(segments: Segment[], tolerance: number) {
  const endpoints = segments.flatMap(segment => [segment.a, segment.b]);
  const parents = endpoints.map((_, index) => index), cells = new Map<string, number[]>();
  function root(index: number): number {
    let result = index;
    while (parents[result] !== result) result = parents[result]!;
    while (parents[index] !== index) { const next = parents[index]!; parents[index] = result; index = next; }
    return result;
  }
  for (let index = 0; index < endpoints.length; index++) {
    const point = endpoints[index]!, x = Math.floor(point.x / tolerance), y = Math.floor(point.y / tolerance);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of cells.get(`${x + dx},${y + dy}`) ?? []) {
        const candidate = endpoints[other]!;
        if (Math.hypot(point.x - candidate.x, point.y - candidate.y) <= tolerance) parents[root(index)] = root(other);
      }
    }
    const key = `${x},${y}`, bucket = cells.get(key) ?? [];
    bucket.push(index); cells.set(key, bucket);
  }
  const nodes: Point2[] = [], ids = new Map<number, number>();
  const bounds: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
  const counts: number[] = [];
  const endpointIds = endpoints.map((point, index) => {
    const representative = root(index);
    let id = ids.get(representative);
    if (id === undefined) {
      id = nodes.length; ids.set(representative, id); nodes.push({ x: 0, y: 0 }); counts.push(0);
      bounds.push({ minX: point.x, maxX: point.x, minY: point.y, maxY: point.y });
    }
    nodes[id]!.x += point.x; nodes[id]!.y += point.y; counts[id]!++;
    const box = bounds[id]!;
    box.minX = Math.min(box.minX, point.x); box.maxX = Math.max(box.maxX, point.x);
    box.minY = Math.min(box.minY, point.y); box.maxY = Math.max(box.maxY, point.y);
    return id;
  });
  nodes.forEach((node, index) => { node.x /= counts[index]!; node.y /= counts[index]!; });
  const clusterSpans = bounds.map(box => Math.hypot(box.maxX - box.minX, box.maxY - box.minY));
  return {
    nodes,
    segments: segments.map((segment, index): WeldedSegment => ({ ...segment, from: endpointIds[index * 2]!, to: endpointIds[index * 2 + 1]! })),
    // A long chain of close points must not silently weld a macroscopic contour.
    excessiveWeldClusterCount: clusterSpans.filter(span => span > 2 * tolerance).length,
    maxWeldClusterSpanMm: clusterSpans.reduce((maximum, span) => Math.max(maximum, span), 0),
  };
}

function sideDistance(a: Point2, b: Point2, point: Point2): number {
  return ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
}

function properCrossing(a: Segment, b: Segment, tolerance: number): boolean {
  const ac = sideDistance(a.a, a.b, b.a), ad = sideDistance(a.a, a.b, b.b);
  const ca = sideDistance(b.a, b.b, a.a), cb = sideDistance(b.a, b.b, a.b);
  const opposite = (first: number, second: number) => (first > tolerance && second < -tolerance) || (first < -tolerance && second > tolerance);
  return opposite(ac, ad) && opposite(ca, cb);
}

function collinearOverlap(a: Segment, b: Segment, tolerance: number): boolean {
  if (Math.abs(sideDistance(a.a, a.b, b.a)) > tolerance || Math.abs(sideDistance(a.a, a.b, b.b)) > tolerance) return false;
  const length = Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y);
  const project = (point: Point2) => ((point.x - a.a.x) * (a.b.x - a.a.x) + (point.y - a.a.y) * (a.b.y - a.a.y)) / length;
  const first = project(b.a), second = project(b.b);
  return Math.min(length, Math.max(first, second)) - Math.max(0, Math.min(first, second)) > tolerance;
}

function checkIntersections(segments: WeldedSegment[], options: typeof DEFAULT_OPTIONS) {
  const ordered = segments.map((segment, index) => ({ segment, index, minX: Math.min(segment.a.x, segment.b.x), maxX: Math.max(segment.a.x, segment.b.x), minY: Math.min(segment.a.y, segment.b.y), maxY: Math.max(segment.a.y, segment.b.y) })).sort((a, b) => a.minX - b.minX);
  let active: typeof ordered = [], properCrossingCount = 0, collinearOverlapCount = 0, candidatePairCount = 0;
  const examples: { kind: 'proper-crossing' | 'collinear-overlap'; faces: number[] }[] = [];
  for (const current of ordered) {
    active = active.filter(previous => previous.maxX >= current.minX);
    for (const previous of active) {
      if (previous.maxY < current.minY || current.maxY < previous.minY) continue;
      const a = previous.segment, b = current.segment;
      const adjacent = a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
      candidatePairCount++;
      const kind = !adjacent && properCrossing(a, b, options.intersectionToleranceMm) ? 'proper-crossing'
        : collinearOverlap(a, b, options.intersectionToleranceMm) ? 'collinear-overlap' : undefined;
      if (!kind) continue;
      if (kind === 'proper-crossing') properCrossingCount++;
      else collinearOverlapCount++;
      if (examples.length < 20) examples.push({ kind, faces: [a.face, b.face] });
    }
    active.push(current);
  }
  return { properCrossingCount, collinearOverlapCount, candidatePairCount, intersectionExamples: examples };
}

function checkSection(mesh: BinaryStl, requestedZMm: number, options: typeof DEFAULT_OPTIONS) {
  const zMm = selectPlane(mesh.vertexHeights, requestedZMm, options);
  const raw = slice(mesh, zMm), welded = weld(raw, options.weldToleranceMm);
  const segments = welded.segments.filter(segment => segment.from !== segment.to);
  const adjacency = welded.nodes.map(() => [] as number[]), edgeCounts = new Map<string, number>();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    adjacency[segment.from]!.push(index); adjacency[segment.to]!.push(index);
    const key = segment.from < segment.to ? `${segment.from},${segment.to}` : `${segment.to},${segment.from}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  const duplicateSegmentCount = [...edgeCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const degreeHistogram: Record<string, number> = {};
  let badEndpointCount = 0;
  for (const incident of adjacency) {
    degreeHistogram[incident.length] = (degreeHistogram[incident.length] ?? 0) + 1;
    if (incident.length !== 2) badEndpointCount++;
  }
  const visited = new Set<number>(), loops: { segmentCount: number; perimeterMm: number; absoluteAreaMm2: number }[] = [];
  let componentCount = 0;
  for (let start = 0; start < adjacency.length; start++) {
    if (visited.has(start)) continue;
    componentCount++;
    const queue = [start], vertices: number[] = [];
    visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const vertex = queue[cursor]!; vertices.push(vertex);
      for (const edge of adjacency[vertex]!) {
        const segment = segments[edge]!, other = segment.from === vertex ? segment.to : segment.from;
        if (!visited.has(other)) { visited.add(other); queue.push(other); }
      }
    }
    if (vertices.length < 3 || vertices.some(vertex => adjacency[vertex]!.length !== 2)) continue;
    let vertex = start, previousEdge = -1, perimeterMm = 0, twiceArea = 0, edgeCount = 0;
    do {
      const edge = adjacency[vertex]!.find(index => index !== previousEdge)!;
      const segment = segments[edge]!, next = segment.from === vertex ? segment.to : segment.from;
      const a = welded.nodes[vertex]!, b = welded.nodes[next]!;
      perimeterMm += Math.hypot(b.x - a.x, b.y - a.y); twiceArea += a.x * b.y - a.y * b.x;
      previousEdge = edge; vertex = next; edgeCount++;
    } while (vertex !== start && edgeCount <= vertices.length);
    if (vertex === start && edgeCount === vertices.length) loops.push({ segmentCount: edgeCount, perimeterMm, absoluteAreaMm2: Math.abs(twiceArea) / 2 });
  }
  const intersections = checkIntersections(segments, options), issues: string[] = [];
  const zeroAreaLoopCount = loops.filter(loop => loop.absoluteAreaMm2 <= options.weldToleranceMm ** 2).length;
  if (segments.length === 0) issues.push('No non-collapsed section segments.');
  if (badEndpointCount) issues.push(`${badEndpointCount} welded endpoints do not have degree two.`);
  if (loops.length !== componentCount) issues.push(`${componentCount - loops.length} section components are not closed simple graph cycles.`);
  if (duplicateSegmentCount) issues.push(`${duplicateSegmentCount} duplicate section segments.`);
  if (zeroAreaLoopCount) issues.push(`${zeroAreaLoopCount} loops have zero or unresolved area at the endpoint tolerance.`);
  if (welded.excessiveWeldClusterCount) issues.push(`${welded.excessiveWeldClusterCount} weld clusters span more than twice the endpoint tolerance.`);
  if (intersections.properCrossingCount) issues.push(`${intersections.properCrossingCount} proper crossings between non-adjacent segments.`);
  if (intersections.collinearOverlapCount) issues.push(`${intersections.collinearOverlapCount} collinear overlaps between section segments.`);
  return {
    requestedZMm, zMm, zShiftMm: zMm - requestedZMm,
    requestedPlaneTouchesVertex: zMm !== requestedZMm,
    rawSegmentCount: raw.length, segmentCount: segments.length,
    collapsedSegmentCount: raw.length - segments.length,
    weldedEndpointCount: welded.nodes.length, degreeHistogram, badEndpointCount,
    duplicateSegmentCount, componentCount, closedLoopCount: loops.length, zeroAreaLoopCount, loops,
    excessiveWeldClusterCount: welded.excessiveWeldClusterCount, maxWeldClusterSpanMm: welded.maxWeldClusterSpanMm,
    ...intersections, passed: issues.length === 0, issues,
  };
}

export function checkBinaryStlSections(buffer: Buffer, heights: readonly number[] = DEFAULT_SECTION_HEIGHTS_MM, overrides: SectionOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  for (const [name, value] of Object.entries(options)) if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive.`);
  if (!heights.length || heights.some(height => !Number.isFinite(height))) throw new Error('At least one finite section height is required.');
  const mesh = readBinaryStl(buffer);
  const sections = heights.map(height => {
    try { return checkSection(mesh, height, options); }
    catch (error) { return { requestedZMm: height, passed: false, issues: [error instanceof Error ? error.message : String(error)] }; }
  });
  const passed = sections.every(section => section.passed);
  return {
    schemaVersion: 1, scope: 'sampled-horizontal-section-geometry', units: 'mm',
    status: passed ? 'passed' : 'failed', passed, triangleCount: mesh.triangleCount,
    requestedHeightsMm: [...heights], method: {
      ...options,
      exactPlaneHandling: 'Use a nearby vertex-free plane only when the requested plane touches a vertex; report every height adjustment.',
      closureCheck: 'All welded endpoint degrees are two and every component is a cycle of at least three vertices, with no duplicate segments or unresolved loop area.',
      shortSegmentHandling: 'Contract segments whose endpoints weld together; fail isolated or excessively extended weld clusters.',
      intersectionCheck: 'Sweep segment bounding boxes and reject proper 2D crossings between segments without a shared welded endpoint, plus positive-length collinear overlaps between any segments.',
    },
    limitations: [
      'Only the reported horizontal planes are checked; this is not a proof that the entire 3D mesh has no self-intersections.',
      'Welding resolves endpoints at the stated tolerance; smaller features and non-proper tangential contacts are not comprehensively checked.',
      'No slicing software was run and no physical print was performed.',
    ], slicingSoftwareRun: false, physicalPrintPerformed: false, sections,
  };
}
