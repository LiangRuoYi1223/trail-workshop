import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBinaryStlSections, readBinaryStl } from '../src/mesh/sections.js';

type Point3 = [number, number, number];
type Triangle = [Point3, Point3, Point3];

function binaryStl(triangles: Triangle[]): Buffer {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, face) => triangle.flat().forEach((value, coordinate) => buffer.writeFloatLE(value, 84 + face * 50 + 12 + coordinate * 4)));
  return buffer;
}

/** Triangulated walls extrude any closed polygon, independently of the production mesh builder. */
function walls(polygon: [number, number][], bottom = 0, top = 2): Triangle[] {
  return polygon.flatMap((a, index): Triangle[] => {
    const b = polygon[(index + 1) % polygon.length]!;
    const lowA: Point3 = [...a, bottom], lowB: Point3 = [...b, bottom];
    const highA: Point3 = [...a, top], highB: Point3 = [...b, top];
    return [[lowA, lowB, highB], [lowA, highB, highA]];
  });
}

const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];

test('triangulated box walls make one closed section with area and perimeter', () => {
  const report = checkBinaryStlSections(binaryStl(walls(square)), [0.5, 1, 1.5]);
  assert.equal(report.passed, true);
  for (const section of report.sections) {
    assert.ok('zMm' in section);
    assert.equal(section.closedLoopCount, 1);
    assert.equal(section.segmentCount, 8);
    assert.equal(section.properCrossingCount, 0);
    assert.equal(section.loops[0]!.absoluteAreaMm2, 4);
    assert.equal(section.loops[0]!.perimeterMm, 8);
  }
  assert.equal(report.slicingSoftwareRun, false);
  assert.equal(report.physicalPrintPerformed, false);
});

test('a missing intersected triangle fails loop closure', () => {
  const triangles = walls(square); triangles.pop();
  const report = checkBinaryStlSections(binaryStl(triangles), [1]);
  assert.equal(report.passed, false);
  assert.ok(report.sections[0]!.issues.some(issue => issue.includes('degree two')));
});

test('a bow-tie polygon is graph-closed but fails a proper non-adjacent crossing', () => {
  const report = checkBinaryStlSections(binaryStl(walls([[0, 0], [2, 2], [0, 2], [2, 0]])), [0.7]);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.equal(section.closedLoopCount, 1);
  assert.equal(section.badEndpointCount, 0);
  assert.ok(section.properCrossingCount > 0);
  assert.equal(report.passed, false);
});

test('two independent island loops are valid at the same height', () => {
  const second = square.map(([x, y]): [number, number] => [x + 4, y]);
  const report = checkBinaryStlSections(binaryStl([...walls(square), ...walls(second)]), [1]);
  assert.equal(report.passed, true);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.equal(section.closedLoopCount, 2);
});

test('an exact vertex and coplanar height uses and reports a nearby clear plane', () => {
  const triangles = [...walls(square, 0, 1), ...walls(square, 1, 2)];
  // A horizontal facet at the nominal plane cannot be mistaken for a section segment.
  triangles.push([[0.5, 0.5, 1], [1.5, 0.5, 1], [0.5, 1.5, 1]]);
  const report = checkBinaryStlSections(binaryStl(triangles), [1]);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.equal(section.requestedZMm, 1);
  assert.notEqual(section.zMm, 1);
  assert.ok(Math.abs(section.zShiftMm) <= report.method.maxPlaneShiftMm);
  assert.equal(section.requestedPlaneTouchesVertex, true);
  assert.equal(report.passed, true);
});

test('welding contracts tiny section links without opening the remaining loop', () => {
  const polygon: [number, number][] = [[0, 0], [0.00005, 0], [2, 0], [2, 2], [0, 2]];
  const report = checkBinaryStlSections(binaryStl(walls(polygon)), [1]);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.ok(section.collapsedSegmentCount > 0);
  assert.equal(section.badEndpointCount, 0);
  assert.equal(report.passed, true);
});

test('endpoint welding finds close coordinates on opposite bucket boundaries', () => {
  const polygon: [number, number][] = [[0.000099, 0], [2, 0], [2, 2], [0, 2]];
  const triangles = walls(polygon);
  // The last wall endpoint and first wall endpoint straddle a weld bucket edge.
  triangles[6]![1][0] = 0.000101;
  triangles[6]![2][0] = 0.000101;
  const report = checkBinaryStlSections(binaryStl(triangles), [1]);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.equal(section.badEndpointCount, 0);
  assert.ok(section.maxWeldClusterSpanMm > 0);
  assert.equal(report.passed, true);
});

test('a crossing at a welded endpoint fails degree two even without a proper crossing', () => {
  const report = checkBinaryStlSections(binaryStl(walls([[0, 0], [2, 2], [0, 2], [2, 0]])), [1]);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.ok(section.badEndpointCount > 0);
  assert.equal(report.passed, false);
});

test('non-adjacent collinear overlap cannot pass as two ordinary loops', () => {
  const second = square.map(([x, y]): [number, number] => [x + 0.5, y]);
  const report = checkBinaryStlSections(binaryStl([...walls(square), ...walls(second)]), [0.7]);
  const section = report.sections[0]!;
  assert.ok('zMm' in section);
  assert.ok(section.collinearOverlapCount > 0);
  assert.equal(report.passed, false);
});

test('collinear adjacent backtracking and a zero-area contour fail', () => {
  for (const polygon of [
    [[0, 0], [2, 0], [1, 0], [1, 2], [0, 2]],
    [[0, 0], [2, 0], [1, 0]],
  ] as [number, number][][]) {
    const report = checkBinaryStlSections(binaryStl(walls(polygon)), [0.7]);
    assert.equal(report.passed, false);
    const section = report.sections[0]!;
    assert.ok('zMm' in section);
    assert.ok(section.collinearOverlapCount > 0 || section.zeroAreaLoopCount > 0);
  }
});

test('duplicate section edges and empty cuts both fail', () => {
  const triangles = walls(square);
  const duplicate = checkBinaryStlSections(binaryStl([...triangles, triangles[0]!]), [1]);
  assert.equal(duplicate.passed, false);
  const empty = checkBinaryStlSections(binaryStl(triangles), [3]);
  assert.equal(empty.passed, false);
  assert.ok(empty.sections[0]!.issues.some(issue => issue.includes('No non-collapsed')));
});

test('malformed binary lengths, empty STL and non-finite coordinates are rejected', () => {
  assert.throws(() => readBinaryStl(Buffer.alloc(10)), /shorter/);
  assert.throws(() => readBinaryStl(Buffer.alloc(84)), /no triangles/);
  const bytes = binaryStl(walls(square));
  assert.throws(() => readBinaryStl(bytes.subarray(0, bytes.length - 1)), /byte length/);
  bytes.writeFloatLE(NaN, 96);
  assert.throws(() => readBinaryStl(bytes), /non-finite/);
});

test('invalid options and section heights are rejected', () => {
  const bytes = binaryStl(walls(square));
  assert.throws(() => checkBinaryStlSections(bytes, []), /finite section height/);
  assert.throws(() => checkBinaryStlSections(bytes, [NaN]), /finite section height/);
  assert.throws(() => checkBinaryStlSections(bytes, [1], { weldToleranceMm: 0 }), /finite and positive/);
});

test('failure to find a clear nearby plane produces a failed section report', () => {
  const report = checkBinaryStlSections(binaryStl(walls(square)), [1], { planeClearanceMm: 1 });
  assert.equal(report.passed, false);
  assert.equal(report.sections[0]!.passed, false);
  assert.ok(report.sections[0]!.issues[0]!.includes('Cannot find a vertex-free plane'));
});

test('CLI writes honest sidecars and returns nonzero on parse, geometry and read failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terrain-sections-'));
  const path = join(directory, 'sample.stl'), reportPath = join(directory, 'sample.sections.json');
  const script = fileURLToPath(new URL('../scripts/check-sections.js', import.meta.url));
  try {
    const complete = walls(square, 0, 22), incomplete = complete.slice(0, -1);
    for (const [buffer, shouldPass] of [[Buffer.alloc(20), false], [binaryStl(incomplete), false], [binaryStl(complete), true]] as const) {
      await writeFile(path, buffer);
      await writeFile(reportPath, JSON.stringify({ passed: true, status: 'passed', obsolete: true }));
      const execution = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10000 });
      assert.equal(execution.status, shouldPass ? 0 : 1, execution.stderr);
      const compact = JSON.parse(execution.stdout);
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(report.passed, shouldPass);
      assert.equal(compact.passed, shouldPass);
      assert.equal(report.obsolete, undefined);
      assert.equal(report.scope, 'sampled-horizontal-section-geometry');
      assert.equal(report.slicingSoftwareRun, false);
      assert.equal(report.physicalPrintPerformed, false);
    }
    await unlink(path);
    const missing = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).passed, false);
  } finally {
    await unlink(path).catch(() => undefined);
    await unlink(reportPath).catch(() => undefined);
    await rmdir(directory);
  }
});
