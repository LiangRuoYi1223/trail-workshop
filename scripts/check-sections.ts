import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { checkBinaryStlSections } from '../src/mesh/sections.js';

function failed(error: unknown) {
  return {
    schemaVersion: 1, scope: 'sampled-horizontal-section-geometry', status: 'failed', passed: false,
    slicingSoftwareRun: false, physicalPrintPerformed: false,
    error: error instanceof Error ? error.message : String(error), sections: [],
  };
}

const path = process.argv[2];
if (!path || process.argv.length !== 3) {
  console.error('Usage: node dist/scripts/check-sections.js outputs/stage2/Longquanshan_Integrated.stl');
  process.exitCode = 1;
} else {
  const extension = extname(path);
  const reportPath = `${extension ? path.slice(0, -extension.length) : path}.sections.json`;
  try {
    let report;
    try {
      const buffer = await readFile(path);
      let result;
      try { result = checkBinaryStlSections(buffer); }
      catch (error) { result = failed(error); }
      report = { source: { file: path, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }, ...result };
    } catch (error) { report = { source: { file: path }, ...failed(error) }; }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      status: report.status, passed: report.passed, file: path, report: reportPath,
      scope: report.scope, slicingSoftwareRun: false, physicalPrintPerformed: false,
      ...('error' in report ? { error: report.error } : {}),
      sections: report.sections.map(section => ({
        requestedZMm: section.requestedZMm, passed: section.passed,
        ...('zMm' in section ? { zMm: section.zMm, segments: section.segmentCount, closedLoops: section.closedLoopCount, badEndpoints: section.badEndpointCount, properCrossings: section.properCrossingCount, collinearOverlaps: section.collinearOverlapCount } : {}),
        ...(section.passed ? {} : { issues: section.issues }),
      })),
    }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', passed: false, file: path, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
