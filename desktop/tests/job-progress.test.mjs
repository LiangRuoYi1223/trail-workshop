import test from 'node:test';
import assert from 'node:assert/strict';

const ui = await import('../renderer/job-progress.ts').catch(() => ({}));

test('a new file-size error replaces a prior cancelled job status', () => {
  assert.equal(typeof ui.idleStatus, 'function', 'idle task status is missing');
  const failure = ui.failurePresentation('INPUT_TOO_LARGE', 'auto');
  assert.match(failure.status, /文件.*导入.*未完成/);
  assert.equal(ui.idleStatus('cancelled', failure.status, false), failure.status);
  assert.equal(ui.idleStatus('succeeded', failure.status, true), failure.status);
});

test('clearing a current error restores cancellation, stale and ready states', () => {
  assert.equal(typeof ui.idleStatus, 'function', 'idle task status is missing');
  assert.equal(ui.idleStatus('cancelled', undefined, false), '生成已取消，可以重新开始');
  assert.equal(ui.idleStatus('succeeded', undefined, true), '参数已修改，请重新生成模型');
  assert.equal(ui.idleStatus('succeeded', undefined, false), '模型已生成，可保存打印文件');
});

for (const code of ['MODEL_TIMEOUT', 'OUTPUT_TIMEOUT', 'JOB_TIMEOUT']) {
  test(`${code} never offers satellite recovery in automatic image mode`, () => {
    assert.equal(typeof ui.failurePresentation, 'function', 'failure classification is missing');
    const failure = ui.failurePresentation(code, 'auto');
    assert.equal(failure.imageRecovery, false);
    assert.equal(failure.acquisitionRetry, false);
    assert.doesNotMatch(failure.status, /影像.*未完成|本地影像/);
  });
}
test('automatic image failures offer retry and local import, local image failures do not', () => {
  assert.equal(typeof ui.failurePresentation, 'function', 'failure classification is missing');
  for (const code of ['IMAGE_TIMEOUT', 'IMAGE_NETWORK']) {
    assert.equal(ui.failurePresentation(code, 'auto').imageRecovery, true);
    assert.equal(ui.failurePresentation(code, 'local').imageRecovery, false);
  }
});
test('an acquisition timeout names both branches and offers a joint retry without satellite fallback', () => {
  assert.equal(typeof ui.failurePresentation, 'function', 'failure classification is missing');
  const failure = ui.failurePresentation('ACQUISITION_TIMEOUT', 'auto');
  assert.equal(failure.imageRecovery, false);
  assert.equal(failure.acquisitionRetry, true);
  assert.match(failure.status, /影像.*高程|高程.*影像/);
});
test('candidate search progress is never presented as actual coverage', () => {
  assert.equal(typeof ui.acquisitionRows, 'function', 'branch presentation is missing');
  const [row] = ui.acquisitionRows({ image: { state: 'running', progress: .04, message: '正在检查候选 2 / 24' } });
  assert.equal(row.state, '获取中');
  assert.match(row.message, /2 \/ 24/);
  assert.equal(row.coverage, '覆盖待确认');
  assert.doesNotMatch(row.coverage, /4%|8%/);
});
test('parallel branches preserve individual states, verified coverage and byte totals', () => {
  assert.equal(typeof ui.acquisitionRows, 'function', 'branch presentation is missing');
  const rows = ui.acquisitionRows({
    image: { state: 'running', progress: .04, message: '正在筛除云层', downloadedBytes: 1572864, cacheBytes: 524288, coverage: .875 },
    dem: { state: 'complete', progress: 1, message: '高程已就绪', downloadedBytes: 0, cacheBytes: 2097152, coverage: 1 },
  });
  assert.deepEqual(rows.map(row => [row.key, row.state]), [['image', '获取中'], ['dem', '已就绪']]);
  assert.equal(rows[0].coverage, '覆盖 87.5%');
  assert.equal(rows[1].coverage, '覆盖 100%');
  assert.equal(rows[0].data, '已下载 1.5 MB · 缓存复用 512 KB');
  assert.equal(rows[1].data, '已下载 0 B · 缓存复用 2 MB');
});
test('missing or invalid coverage and byte counts are not fabricated', () => {
  assert.equal(typeof ui.acquisitionRows, 'function', 'branch presentation is missing');
  const [row] = ui.acquisitionRows({ image: { state: 'complete', progress: 1, message: '就绪', downloadedBytes: NaN, cacheBytes: -1, coverage: 1.1 } });
  assert.equal(row.coverage, '覆盖待确认');
  assert.equal(row.data, '已下载 — · 缓存复用 —');
});
test('elapsed time uses createdAt, has no dependency on job pushes, and handles clock skew', () => {
  assert.equal(typeof ui.elapsedLabel, 'function', 'elapsed time display is missing');
  assert.equal(ui.elapsedLabel('2026-10-11T00:00:00.000Z', Date.parse('2026-10-11T00:01:05.000Z')), '已用 1 分 05 秒');
  assert.equal(ui.elapsedLabel('2026-10-11T00:00:00.000Z', Date.parse('2026-10-11T02:01:05.000Z')), '已用 2 小时 1 分 05 秒');
  assert.equal(ui.elapsedLabel('2026-10-11T00:00:00.000Z', Date.parse('2026-10-10T23:59:00.000Z')), '已用 0 秒');
  assert.equal(ui.elapsedLabel('invalid', Date.now()), '计时中');
});
test('phase names make acquisition, model generation and verification distinct', () => {
  assert.equal(typeof ui.phaseLabel, 'function', 'phase display is missing');
  assert.match(ui.phaseLabel('acquire'), /影像.*高程|高程.*影像/);
  assert.match(ui.phaseLabel('model'), /建模|生成模型/);
  assert.match(ui.phaseLabel('verify'), /核验|检查/);
  assert.match(ui.phaseLabel('prepare'), /准备/);
  assert.equal(ui.phaseLabel(undefined), '正在生成模型');
});

test('initial estimates show the uncalibrated range and keep reference and calibrated labels distinct', () => {
  assert.equal(typeof ui.estimateLabel, 'function', 'estimated duration presentation is missing');
  const estimate = { estimatedTotalMs: 65000, estimatedRangeMs: { low: 45000, high: 120000 }, confidence: 'uncalibrated', estimateVersion: 'test-v1', elapsedMs: 0 };
  assert.equal(ui.estimateLabel(estimate), '预计总用时 1 分 05 秒（参考 45 秒–2 分 00 秒，未校准）');
  assert.match(ui.estimateLabel({ ...estimate, confidence: 'reference' }), /参考估计/);
  assert.match(ui.estimateLabel({ ...estimate, confidence: 'calibrated' }), /已校准/);
  assert.equal(ui.estimateLabel(undefined), '预计总用时待确认');
});

test('successful total duration stays frozen and elapsed duration accepts monotonic snapshots', () => {
  assert.equal(typeof ui.totalDurationLabel, 'function', 'final duration presentation is missing');
  assert.equal(typeof ui.elapsedDurationLabel, 'function', 'monotonic elapsed presentation is missing');
  assert.equal(ui.totalDurationLabel({ totalDurationMs: 65000 }), '建模总用时 1 分 05 秒');
  assert.equal(ui.elapsedDurationLabel(65000), '已用 1 分 05 秒');
  assert.equal(ui.elapsedDurationLabel(-1), '计时中');
  assert.equal(ui.totalDurationLabel(undefined), undefined);
});

test('short initial estimates and frozen totals retain tenths of seconds while elapsed labels keep whole seconds', () => {
  const timing = { estimatedTotalMs: 1064, estimatedRangeMs: { low: 940, high: 1200 }, confidence: 'calibrated', estimateVersion: 'test-v1' };
  assert.equal(ui.estimateLabel(timing), '预计总用时 1.1 秒（参考 0.9 秒–1.2 秒，已校准）');
  assert.equal(ui.totalDurationLabel({ totalDurationMs: 1064 }), '建模总用时 1.1 秒');
  assert.equal(ui.totalDurationLabel({ totalDurationMs: 49 }), '建模总用时 0.1 秒');
  assert.equal(ui.elapsedDurationLabel(1064), '已用 1 秒');
  assert.equal(ui.durationLabel(1064), '1 秒');
});


test('summer coverage, cumulative quota and timeout report distinct causes',()=>{
 assert.match(ui.failurePresentation('IMAGE_COVERAGE_INSUFFICIENT','auto').status,/夏季覆盖不足/);
 assert.match(ui.failurePresentation('IMAGE_DOWNLOAD_LIMIT','auto').status,/下载额度耗尽/);
 assert.match(ui.failurePresentation('IMAGE_TIMEOUT','auto').status,/网络超时/);
 assert.doesNotMatch(ui.failurePresentation('IMAGE_RANGE_LIMIT','auto').status,/额度耗尽/);
});
