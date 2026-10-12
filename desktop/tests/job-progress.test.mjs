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
