import type { ImageMode, Job } from './types';

export function failurePresentation(code: string, imageMode: ImageMode) {
  const imageRecovery = imageMode === 'auto' && code.startsWith('IMAGE_');
  const acquisitionRetry = code === 'ACQUISITION_TIMEOUT';
  const status = imageRecovery ? '地表影像获取未完成，请重试或导入本地影像'
    : acquisitionRetry ? '影像或高程获取超时，请检查网络后重试'
    : code === 'MODEL_TIMEOUT' ? '建模超时，请重新生成模型'
    : code === 'OUTPUT_TIMEOUT' ? '模型核验超时，请重新生成模型'
    : code === 'JOB_TIMEOUT' ? '生成超时，请重新生成模型'
    : '生成未完成，请检查设置后重试';
  return { status, imageRecovery, acquisitionRetry };
}

function dataSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
}

export function acquisitionRows(acquisition: Job['acquisition']) {
  return (['image', 'dem'] as const).flatMap(key => {
    const branch = acquisition?.[key];
    if (!branch) return [];
    const measured = branch.coverage !== undefined && Number.isFinite(branch.coverage) && branch.coverage >= 0 && branch.coverage <= 1;
    return [{ key, label: key === 'image' ? '地表影像' : '地形高程', state: branch.state === 'complete' ? '已就绪' : '获取中', message: branch.message,
      coverage: measured ? `覆盖 ${Number((branch.coverage! * 100).toFixed(1))}%` : '覆盖待确认',
      data: `已下载 ${dataSize(branch.downloadedBytes)} · 缓存复用 ${dataSize(branch.cacheBytes)}` }];
  });
}

export function elapsedLabel(createdAt: string, now: number): string {
  const start = Date.parse(createdAt);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return '计时中';
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  return hours ? `已用 ${hours} 小时 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
    : minutes ? `已用 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `已用 ${seconds} 秒`;
}

export function phaseLabel(phase: Job['phase']): string {
  return phase === 'prepare' ? '正在准备路线与取景'
    : phase === 'acquire' ? '正在获取影像与高程'
    : phase === 'model' ? '正在建模'
    : phase === 'verify' ? '正在核验打印模型' : '正在生成模型';
}
