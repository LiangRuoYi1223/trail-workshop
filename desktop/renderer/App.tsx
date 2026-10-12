import { useEffect, useId, useRef, useState } from 'react';
import RouteMap from './components/RouteMap';
import TerrainView from './components/TerrainView';
import RouteColorPicker from './components/RouteColorPicker';
import { geometryOptions, printPaletteCount } from './route-color';
import { acquisitionRows, elapsedLabel, failurePresentation, idleStatus, phaseLabel } from './job-progress';
import type { CacheInfo, DemInfo, ImageInfo, ImageMode, SurfaceImageSource, GeoPoint, Inspection, Job, ModelOptions, Preview, Result, RouteInfo, RuntimeInfo, SessionInfo } from './types';

const DEFAULTS: ModelOptions = {
  shape: 'rectangle', widthMm: 120, heightMm: 80, polygonSides: 6, cornerRadiusMm: 0,
  bearingDeg: 0, paddingFraction: .1, baseThicknessMm: 2, zExaggeration: 2,
  gridColumns: 129, smoothing: 'raw', routeWidthMm: 1, routeHeightMm: 1, routeColor: '#c84832', frameWidthMm: 3,
  maxColors:3,grassColor:'#799278',rockColor:'#a9aa92',
  snowEnabled:false,snowCoveragePercent:30,snowMaxThicknessMm:1,
};
const api = window.terrain;
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.value; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
function codeOf(error: unknown): string { return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : ''; }
function signature(route: RouteInfo | null, dem: DemInfo | null, image:ImageInfo|null, mode: 'auto' | 'local', imageMode: ImageMode, imageLookbackMonths: 12 | 24, offlineOnly: boolean, options: ModelOptions): string { return JSON.stringify({ routeId: route?.id, demId: mode === 'local' ? dem?.id : undefined, imageId:imageMode === 'local' ? image?.id : undefined, demMode: mode, imageMode, imageLookbackMonths: imageMode === 'auto' ? imageLookbackMonths : undefined, offlineOnly: mode === 'auto' && offlineOnly, options:geometryOptions(options) }); }
function sizeLabel(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function sourceLabel(source: NonNullable<Job['result']>['demSource']): string {
  if (!source) return '本地高程';
  if (/local/i.test(source.provider)) return source.dataset ? `本地 · ${source.dataset}` : '本地高程';
  const name = source.dataset || (/copernicus/i.test(source.provider) ? 'Copernicus GLO-30' : source.provider);
  return `${name}${source.cacheHit ? ' · 使用缓存' : ' · 在线获取'}${source.tileCount ? ` · ${source.tileCount} 块` : ''}`;
}
function imageSourceLabel(source: SurfaceImageSource): string {
  const dates = [...new Set(source.scenes.map(scene => scene.datetime.slice(0, 10)))].sort();
  return `${source.provider} · 拍摄 ${dates.join('、')} · ${source.cacheHit ? '使用缓存' : '在线获取'}`;
}
function validate(options: ModelOptions): string {
  if (!['rectangle', 'circle', 'polygon'].includes(options.shape)) return '请选择有效的成品外形。';
  if (![65, 129, 257].includes(options.gridColumns)) return '请选择快速、标准或精细建模精度。';
  if (!['raw', 'light', 'medium', 'heavy'].includes(options.smoothing)) return '请选择有效的地形平滑方式。';
  const rules: Array<[keyof ModelOptions, number, number, string]> = [
    ['widthMm', 10, 500, '山体长度'], ['heightMm', 10, 500, '山体宽度'], ['routeWidthMm', .4, 5, '路线宽度'], ['routeHeightMm', .1, 10, '路线凸起厚度'],
    ['baseThicknessMm', .5, 30, '底座厚度'], ['frameWidthMm', 0, 20, '外沿宽度'], ['zExaggeration', .1, 20, '垂直夸张'],
    ['bearingDeg', -180, 180, '取景旋转'], ['paddingFraction', 0, .4, '取景留白'], ['polygonSides', 3, 8, '多边形边数'],
  ];
  for (const [key, min, max, label] of rules) { const value = options[key]; if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return `${label}需在 ${min}–${max} 之间。`; }
  if (!Number.isInteger(options.polygonSides)) return '多边形边数需为整数。';
  if (!/^#[\da-f]{6}$/i.test(options.routeColor)) return '请选择有效的路线颜色。';
  if (!/^#[\da-f]{6}$/i.test(options.grassColor) || !/^#[\da-f]{6}$/i.test(options.rockColor)) return '请选择有效的山体颜色。';
  if (![2,3,4].includes(options.maxColors)) return '打印颜色上限请选择两色、三色或四色。';
  if (options.snowEnabled !== undefined && typeof options.snowEnabled !== 'boolean') return '请选择有效的积雪开关状态。';
  const snowCoverage = options.snowCoveragePercent === undefined ? 30 : options.snowCoveragePercent;
  const snowThickness = options.snowMaxThicknessMm === undefined ? 1 : options.snowMaxThicknessMm;
  if (!Number.isFinite(snowCoverage) || snowCoverage < 0 || snowCoverage > 100) return '积雪覆盖率需在 0–100% 之间。';
  if (!Number.isFinite(snowThickness) || snowThickness < .1 || snowThickness > 10) return '积雪最大厚度需在 0.1–10 mm 之间。';
  if (options.snowEnabled && options.maxColors !== 4) return '启用积雪时请选择四色打印。';
  if (options.groundWidthM !== undefined && (!Number.isFinite(options.groundWidthM) || options.groundWidthM < 1 || options.groundWidthM > 100000)) return '地面取景宽度需在 0.001–100 km 之间。';
  if (options.center && (!Number.isFinite(options.center.lat) || !Number.isFinite(options.center.lon) || Math.abs(options.center.lat) > 80 || Math.abs(options.center.lon) > 180)) return '取景纬度需在 −80–80°、经度需在 −180–180° 之间。';
  const radius = options.shape === 'circle' ? 0 : options.shape === 'polygon' ? options.widthMm / 2 * Math.cos(Math.PI / options.polygonSides) : Math.min(options.widthMm, options.heightMm) / 2;
  if (!Number.isFinite(options.cornerRadiusMm) || options.cornerRadiusMm < 0 || options.cornerRadiusMm > radius) return `当前外形的圆角半径需在 0–${radius.toFixed(1)} mm 之间。`;
  return '';
}
function NumberField({ label, value, onChange, min, max, step = 1, unit = 'mm', disabled = false }: {
  label: string; value: number; onChange(value: number): void; min: number; max: number; step?: number; unit?: string; disabled?: boolean;
}) {
  const id = useId();
  return <div className="number-field"><label htmlFor={id}>{label}</label><div className="input-unit"><input id={id} type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} disabled={disabled} onChange={event => onChange(event.currentTarget.value === '' ? NaN : Number(event.currentTarget.value))} /><span aria-hidden="true">{unit}</span></div></div>;
}
function MountainMark() { return <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M3 23 12 6l5 9 3-5 6 13H3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="m8.8 12.2 3.2 2.1 2.9-2.8M16.2 22l3.5-4.8 3.2 1.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

export default function App() {
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [dem, setDem] = useState<DemInfo | null>(null);
  const [image,setImage]=useState<ImageInfo|null>(null);
  const [imageMode, setImageMode] = useState<ImageMode>('auto');
  const [imageLookbackMonths, setImageLookbackMonths] = useState<12 | 24>(24);
  const [exportFormat,setExportFormat]=useState<'3mf'|'obj'|'stl'>('3mf');
  const [demMode, setDemMode] = useState<'auto' | 'local'>('auto');
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [cacheMessage, setCacheMessage] = useState('');
  const [options, setOptions] = useState<ModelOptions>({ ...DEFAULTS });
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectionPending, setInspectionPending] = useState(false);
  const [inspectionError, setInspectionError] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewSignature, setPreviewSignature] = useState('');
  const [previewPending, setPreviewPending] = useState(false);
  const [tab, setTab] = useState<'route' | 'model'>('route');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [dragging, setDragging] = useState(false);
  const [sessionReady, setSessionReady] = useState(!api);
  const [sessionAvailable, setSessionAvailable] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [sessionMessage, setSessionMessage] = useState('');
  const activeId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const frozenSignature = useRef('');
  const dragDepth = useRef(0);
  const running = job?.state === 'running' || job?.state === 'cancelling';
  const controlsLocked = !sessionReady || running || !!busy || previewPending;
  const currentSignature = signature(route, dem, image, demMode, imageMode, imageLookbackMonths, offlineOnly, options);
  const stale = !!preview && (previewSignature !== currentSignature || previewId !== job?.id);
  const configError = validate(options);
  const framingSignature = JSON.stringify({ shape:options.shape, widthMm:options.widthMm, heightMm:options.heightMm, polygonSides:options.polygonSides,
    cornerRadiusMm:options.cornerRadiusMm, bearingDeg:options.bearingDeg, paddingFraction:options.paddingFraction, center:options.center, groundWidthM:options.groundWidthM });
  const canGenerate = !!api && !!route && (demMode === 'auto' || !!dem) && !controlsLocked && !configError && !inspectionError && !inspectionPending;
  const canSave = !!api && !!previewId && !!preview && !stale && job?.state === 'succeeded' && !controlsLocked && !previewPending;
  const jobError = job?.error && (!job.error.code.startsWith('IMAGE_') || (job.imageMode === imageMode && (imageMode !== 'auto' || (job.imageLookbackMonths ?? 24) === imageLookbackMonths))) ? job.error : undefined;
  const failure = !running && (error || job?.state === 'failed' && jobError) ? failurePresentation(error ? errorCode : jobError!.code, imageMode) : undefined;
  const automaticImageFailure = !!failure?.imageRecovery;
  const branches = acquisitionRows(job?.acquisition);
  const progressPercent = job ? Math.round(Math.min(1, Math.max(0, job.progress)) * 100) : 0;
  const imageSource = job?.result?.imageSource ?? preview?.report.imageSource;
  const cacheBytes = cacheInfo ? cacheInfo.elevationBytes + cacheInfo.mapBytes + (cacheInfo.imageBytes ?? 0) : 0;

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.getRuntime().then(result => { if (alive && result.ok) setRuntime(result.value); }).catch(() => {});
    api.getCacheInfo().then(result => { if (alive && result.ok) setCacheInfo(result.value); }).catch(() => {});
    const stop = api.onJob(next => { if (next.id === activeId.current) setJob(next); });
    return () => { alive = false; stop(); };
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.getSession().then(result => {
      if (!alive) return;
      const saved = unwrap(result), restoredOptions = { ...DEFAULTS, ...saved.preferences.options };
      const invalid = validate(restoredOptions);
      if (invalid) throw new Error(`上次设置无法读取：${invalid}`);
      setOptions(restoredOptions); setDemMode(saved.preferences.demMode); setOfflineOnly(saved.preferences.offlineOnly);
      setImageMode(saved.preferences.imageMode ?? saved.recentProject?.imageMode ?? (saved.recentProject?.imageFileName ? 'local' : 'auto'));
      setImageLookbackMonths(saved.preferences.imageLookbackMonths ?? saved.recentProject?.imageLookbackMonths ?? 24);
      setSessionInfo(saved); setSessionMessage(saved.warnings.join(' ')); setSessionAvailable(true);
    }).catch(reason => { if (alive) setSessionMessage(`${messageOf(reason)} 本次可继续使用，设置暂不自动保存。`); })
      .finally(() => { if (alive) setSessionReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // Wait for startup preferences and completed imports/restores before writing.
    // Send valid edits immediately so closing the window cannot lose a debounce.
    if (!api || !sessionReady || !sessionAvailable || configError || busy) return;
    let alive = true;
    api.saveSession({ ...(route ? { routeId: route.id } : {}), ...(demMode === 'local' && dem ? { demId: dem.id } : {}), ...(imageMode === 'local' && image?{imageId:image.id}:{}), demMode, imageMode, imageLookbackMonths, offlineOnly, options })
      .then(result => { if (alive) { setSessionInfo(unwrap(result)); setSessionMessage(previous => previous.startsWith('设置未能保存：') ? '' : previous); } })
      .catch(reason => { if (alive) setSessionMessage(`设置未能保存：${messageOf(reason)}`); });
    return () => { alive = false; };
  }, [sessionReady, sessionAvailable, route, dem, image, demMode, imageMode, imageLookbackMonths, offlineOnly, options, configError, busy]);

  useEffect(() => {
    const resetDrag = () => { dragDepth.current = 0; setDragging(false); };
    window.addEventListener('blur', resetDrag); window.addEventListener('dragend', resetDrag);
    return () => { window.removeEventListener('blur', resetDrag); window.removeEventListener('dragend', resetDrag); };
  }, []);

  useEffect(() => {
    setInspectionError('');
    if (!api || !route || configError) { if (!route) setInspection(null); setInspectionPending(false); return; }
    let alive = true;
    setInspectionPending(true);
    const timer = setTimeout(() => {
      api.inspect({ routeId: route.id, options }).then(result => {
        if (!alive) return;
        if (result.ok) setInspection(result.value); else { setInspectionError(result.error.message); setInspection(null); }
      }).catch(reason => { if (alive) setInspectionError(messageOf(reason)); }).finally(() => { if (alive) setInspectionPending(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [route, framingSignature, configError]);

  useEffect(() => {
    if (!api || !job || !running) return;
    let alive = true;
    const id = job.id;
    const timer = setInterval(() => {
      api.getJob(id).then(result => { if (alive && result.ok && activeId.current === id) setJob(result.value); }).catch(() => {});
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [job?.id, running]);

  useEffect(() => {
    if (!running) return;
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job?.id, running]);

  useEffect(() => {
    if (!api || job?.state !== 'succeeded') return;
    let alive = true;
    const id = job.id, snapshot = frozenSignature.current;
    setPreviewPending(true);
    api.getPreview(id).then(result => {
      if (!alive || activeId.current !== id) return;
      const value = unwrap(result);
      setPreview(value); setPreviewId(id); setPreviewSignature(snapshot); setTab('model');
    }).catch(reason => { if (alive) setError(messageOf(reason)); }).finally(() => { if (alive) setPreviewPending(false); });
    return () => { alive = false; };
  }, [job?.id, job?.state]);

  useEffect(() => {
    if (!api || !job || !['succeeded', 'failed', 'cancelled'].includes(job.state)) return;
    let alive = true;
    api.getCacheInfo().then(result => { if (alive && result.ok) setCacheInfo(result.value); }).catch(() => {});
    return () => { alive = false; };
  }, [job?.id, job?.state]);

  async function operate(label: string, action: () => Promise<void>) {
    if (!sessionReady || busyRef.current || running) return;
    busyRef.current = true; setBusy(label); setError(''); setErrorCode('');
    try { await action(); } catch (reason) { setError(messageOf(reason)); setErrorCode(codeOf(reason)); }
    finally { busyRef.current = false; setBusy(''); }
  }
  const update = <K extends keyof ModelOptions>(key: K, value: ModelOptions[K]) => {
    setOptions(previous => {
      const next = { ...previous, [key]: value };
      if (key === 'shape' && value === 'circle') next.cornerRadiusMm = 0;
      if (key === 'snowEnabled' && value === true) next.maxColors = 4;
      if (key === 'maxColors' && previous.snowEnabled && value !== 4) return previous;
      return next;
    });
    setError(''); setSavedPath('');
  };
  function resetFraming() { setOptions(previous => { const { center, groundWidthM, ...automatic } = previous; return { ...automatic, bearingDeg: 0 }; }); setError(''); setSavedPath(''); }
  function moveCenter(center: GeoPoint) { if (!controlsLocked) update('center', center); }
  function changeFraming(next: ModelOptions) { if (!controlsLocked) { setOptions(next); setError(''); setSavedPath(''); } }
  function chooseRoute() { if (!api) return; void operate('正在读取路线', async () => { const selected = unwrap(await api.chooseRoute()); if (selected) { setRoute(selected); setInspection(null); resetFraming(); setTab('route'); setSavedPath(''); } }); }
  function chooseDem() { if (!api) return; void operate('正在读取高程', async () => { const selected = unwrap(await api.chooseDem()); if (selected) { setDem(selected); setDemMode('local'); setSavedPath(''); } }); }
  function changeImageMode(mode: ImageMode) { setImageMode(mode); setError(''); setErrorCode(''); setSavedPath(''); }
  function changeImageSource(value: string) {
    if (value === '12' || value === '24') {
      setImageLookbackMonths(value === '12' ? 12 : 24); changeImageMode('auto');
    } else if (value === 'none' || value === 'local') changeImageMode(value);
  }
  function chooseImage() { if(!api || imageMode !== 'local')return;void operate('正在读取地表影像',async()=>{const selected=unwrap(await api.chooseImage());if(selected){setImage(selected);setSavedPath('');}}); }
  function clearImage() { if(!api||!image)return;void operate('正在清除地表影像',async()=>{unwrap(await api.removeImage(image.id));setImage(null);setSavedPath('');}); }
  function dropImage(files:File[]) { if(!api || imageMode !== 'local')return;void operate('正在读取地表影像',async()=>{if(files.length!==1||!/\.(tif|tiff)$/i.test(files[0].name))throw Error('请在此处拖入一份彩色地表 GeoTIFF。');setImage(unwrap(await api.importImageFile(files[0])));setSavedPath('');}); }
  function restoreProject() {
    if (!api || !sessionInfo?.recentProject) return;
    void operate('正在恢复上次项目', async () => {
      const restored = unwrap(await api.restoreSession());
      setRoute(restored.route ?? null); setDem(restored.dem ?? null); setImage(restored.image??null); setDemMode(restored.demMode); setOfflineOnly(restored.offlineOnly); setOptions({...DEFAULTS,...restored.options});
      setImageMode(restored.imageMode ?? (restored.image ? 'local' : 'auto'));
      setImageLookbackMonths(restored.imageLookbackMonths ?? 24);
      activeId.current = null; frozenSignature.current = '';
      setJob(null); setPreview(null); setPreviewId(null); setPreviewSignature(''); setInspection(null); setTab('route'); setSavedPath('');
      setSessionMessage(restored.warnings.length ? restored.warnings.join(' ') : restored.route ? '上次路线与设置已载入，请检查取景后重新生成。' : '上次路线无法恢复，请重新导入 GPX 或 KML。');
    });
  }
  function clearCache() {
    if (!api) return;
    void operate('正在清理缓存', async () => { unwrap(await api.clearCache()); setCacheInfo(unwrap(await api.getCacheInfo())); setCacheMessage('已清理高程、地表影像和底图缓存。下次使用需重新获取。'); });
  }
  async function importDropped(files: File[]) {
    if (!api) return;
    await operate('正在导入文件', async () => {
      if (!files.length || files.length > 2 || files.some(file => !/\.(gpx|kml|tif|tiff)$/i.test(file.name))) throw new Error('请拖入一份 GPX 或 KML 路线、GeoTIFF 高程，或各一份文件。');
      if (files.filter(file => /\.(gpx|kml)$/i.test(file.name)).length > 1 || files.filter(file => /\.(tif|tiff)$/i.test(file.name)).length > 1) throw new Error('每次可导入一份路线和一份高程，请分开选择。');
      let importedRoute: RouteInfo | undefined, importedDem: DemInfo | undefined;
      for (const file of files) {
        if (/\.(gpx|kml)$/i.test(file.name)) importedRoute = unwrap(await api!.importRouteFile(file));
        else importedDem = unwrap(await api!.importDemFile(file));
      }
      if (importedRoute) { setRoute(importedRoute); setInspection(null); resetFraming(); setTab('route'); }
      if (importedDem) { setDem(importedDem); setDemMode('local'); }
      setSavedPath('');
    });
  }
  function generate() {
    if (!api || !route || !canGenerate) return;
    const snapshot = currentSignature;
    void operate('正在启动生成', async () => {
      const started = unwrap(await api.startJob({ routeId: route.id, ...(demMode === 'local' ? { demId: dem!.id } : {}), ...(imageMode === 'local' && image?{imageId:image.id}:{}), demMode, imageMode, imageLookbackMonths, offlineOnly: demMode === 'auto' && offlineOnly, options: { ...options } }));
      activeId.current = started.id; frozenSignature.current = snapshot;
      setJob(started); setSavedPath('');
      const latest = await api!.getJob(started.id);
      if (latest.ok && activeId.current === started.id) setJob(latest.value);
    });
  }
  async function cancel() {
    if (!api || !job || job.state !== 'running') return;
    try { const next = unwrap(await api.cancelJob(job.id)); if (next.id === activeId.current) setJob(next); } catch (reason) { setError(messageOf(reason)); }
  }
  function save() {
    if (!api || !previewId || !canSave) return;
    const colors={maxColors:options.maxColors,grassColor:options.grassColor,rockColor:options.rockColor,routeColor:options.routeColor};
    void operate('正在保存打印模型', async () => { const result = unwrap(await api!.saveModel({id:previewId,format:exportFormat,options:colors})); if (!result.cancelled && result.path) setSavedPath(result.path); });
  }
  const radiusMax = options.shape === 'circle' ? 0 : options.shape === 'polygon' ? options.widthMm / 2 * Math.cos(Math.PI / options.polygonSides) : Math.min(options.widthMm, options.heightMm) / 2;
  const status = !sessionReady ? '正在读取上次设置' : busy || (running ? phaseLabel(job!.phase) : previewPending ? '正在加载最终模型' : idleStatus(job?.state, failure?.status, stale));
  const materialClasses = preview?.mesh.materialParts?.flatMap(part=>part.faceClasses ?? []);
  const colorCount=preview?.appearance ? printPaletteCount(materialClasses?.length ? [...preview.appearance.faceClasses,...materialClasses] : preview.appearance.faceClasses,options) : options.maxColors;
  const saveLabel=exportFormat==='3mf'?'保存彩色 3MF':exportFormat==='obj'?'保存 OBJ 包':'保存 STL';
  const center = options.center || inspection?.selection.center;
  const snowReport = preview?.report.snow;

  return <div className={`app-shell${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = !controlsLocked && event.dataTransfer.types.includes('Files') ? 'copy' : 'none'; }} onDragEnter={event => { event.preventDefault(); if (!controlsLocked && event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current || event.relatedTarget === null && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) { dragDepth.current = 0; setDragging(false); } }} onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!controlsLocked && event.dataTransfer.types.includes('Files')) void importDropped(Array.from(event.dataTransfer.files)); }}>
    <header className="app-header"><div className="app-brand"><MountainMark /><div><h1>徒步地形工坊</h1><p>把走过的路，制作成一座地形</p></div></div><div className="header-meta">独立桌面版{runtime ? ` · ${runtime.version}` : ''}<span>输出单位：毫米</span></div></header>
    {!api && <div className="bridge-warning" role="alert">当前为界面预览。文件导入、模型生成和保存请在桌面软件中使用。</div>}
    <main className="app-main">
      <aside className="sidebar" aria-label="路线与模型设置">
        <section className="control-section files-section"><h2>路线与高程</h2><div className="file-row"><label>路线 GPX / KML</label><button onClick={chooseRoute} disabled={controlsLocked || !api}>{route ? '更换路线' : '导入路线'}</button></div>
          {route ? <div className="file-detail"><strong title={route.name}>{route.name}</strong><span title={route.fileName}>{route.fileName}</span><p>{route.distanceKm.toFixed(2)} km · {route.pointCount.toLocaleString('zh-CN')} 个点 · {route.segmentCount} 段{route.isSample ? ' · 示例' : ''}</p>{route.invalidPointCount > 0 && <p className="inline-warning">已跳过 {route.invalidPointCount} 个无效点，并保留分段。</p>}</div> : <p className="field-hint">支持 GPX、KML，可直接拖入 · 最大 32 MB</p>}
          <label className="select-field dem-mode">地形高程<select value={demMode} disabled={controlsLocked} onChange={event => { setDemMode(event.currentTarget.value as 'auto' | 'local'); setError(''); setSavedPath(''); }}><option value="auto">自动获取 · Copernicus GLO-30</option><option value="local">使用本地 GeoTIFF</option></select></label>
          {demMode === 'auto' ? <><p className="field-hint">按取景范围获取约 30 m 高程；已用区域保存在电脑上。</p><label className="checkbox-field"><input type="checkbox" checked={offlineOnly} disabled={controlsLocked} onChange={event => { setOfflineOnly(event.currentTarget.checked); setError(''); setSavedPath(''); }} />仅使用已缓存高程</label>{offlineOnly && <p className="field-hint">缓存缺少所需区域时会提示，不会生成替代地形。</p>}</> : <><div className="file-row dem-row"><label>高程 GeoTIFF</label><button onClick={chooseDem} disabled={controlsLocked || !api}>{dem ? '更换高程' : '选择高程'}</button></div>{dem ? <div className="file-detail"><strong title={dem.fileName}>{dem.fileName}</strong><p>{(dem.bytes / 1024 / 1024).toFixed(2)} MB{dem.isSample ? ' · 示例区域' : ''}</p>{dem.dataset && <span className="dataset-label" title={dem.dataset}>{dem.dataset}</span>}</div> : <p className="field-hint">本地地形高程文件 · 最大 256 MB</p>}</>}
          {sessionInfo?.recentProject && <div className="recent-project"><button onClick={restoreProject} disabled={controlsLocked || !api}>恢复上次项目</button><p title={sessionInfo.recentProject.routeFileName}>{sessionInfo.recentProject.routeName || sessionInfo.recentProject.routeFileName}</p></div>}
          {sessionMessage && <p className="session-message" role="status">{sessionMessage}</p>}
        </section>
        <section className="control-section surface-section" onDragOver={event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=controlsLocked||imageMode!=='local'?'none':'copy';}} onDrop={event=>{event.preventDefault();event.stopPropagation();dragDepth.current=0;setDragging(false);if(!controlsLocked&&imageMode==='local')dropImage(Array.from(event.dataTransfer.files));}}>
          <h2>地表与打印颜色</h2><label className="select-field image-mode" htmlFor="image-mode">地表影像来源<select id="image-mode" value={imageMode === 'auto' ? String(imageLookbackMonths) : imageMode} disabled={controlsLocked} onChange={event => changeImageSource(event.currentTarget.value)}><option value="none">不使用</option><option value="12">12个月</option><option value="24">24个月</option><option value="local">本地导入</option></select></label>
          {imageMode === 'none' ? <p className="field-hint">不使用地表影像，山体表面统一配色；高程和路线照常生成。</p> : imageMode === 'auto' ? <div className="automatic-image-info"><p className="field-hint">生成模型时按取景范围获取过去 {imageLookbackMonths} 个月内拍摄的 Sentinel-2 真彩色影像，优先复用符合日期范围的已验证缓存；首次获取需要联网。</p><p className="field-hint">卫星影像并非实时，会筛除云、云影和无效像元。所选月份内没有可用影像、云层遮挡或覆盖不足时会明确提示，可重试或切换本地导入。</p></div> : <><div className="file-row image-file-row"><label>彩色地表 GeoTIFF</label><button onClick={chooseImage} disabled={controlsLocked||!api}>{image?'更换地表影像':'选择地表影像'}</button></div>
          {image?<div className="file-detail image-detail"><strong title={image.fileName}>{image.fileName}</strong><p>{image.width} × {image.height} 像素 · {image.crs}</p><button onClick={clearImage} disabled={controlsLocked}>清除地表影像</button></div>:<p className="field-hint">导入或拖入此区域 · RGB 地表影像 · 最大 64 MB。未导入时山体统一配色。</p>}</>}
          {imageMode !== 'none' && <p className="field-hint">依据影像颜色将绿色区域与非植被区域归并为草地、山石代表色；这是颜色归类，无法准确识别地物。地图底图仅供取景。</p>}
          <label className="select-field" htmlFor="print-colors">打印颜色上限<select id="print-colors" value={options.maxColors} disabled={controlsLocked} onChange={event=>update('maxColors',Number(event.currentTarget.value) as 2|3|4)}><option value="4">四色 · 草地、山石、白雪、路线</option><option value="3" disabled={options.snowEnabled}>三色 · 草地、山石、路线</option><option value="2" disabled={options.snowEnabled}>两色 · 山体、路线</option></select></label>
          <div className="terrain-color-fields"><label htmlFor="grass-color">{options.maxColors===2?'山体颜色':'草地颜色'}<input id="grass-color" type="color" value={options.grassColor} disabled={controlsLocked} onChange={event=>update('grassColor',event.currentTarget.value)} /></label><label htmlFor="rock-color">山石颜色<input id="rock-color" type="color" value={options.rockColor} disabled={controlsLocked||options.maxColors===2} onChange={event=>update('rockColor',event.currentTarget.value)} /></label></div>
          {options.maxColors===4 && <div className="snow-color-field"><span>白雪颜色</span><span><i className="snow-color-swatch" aria-hidden="true" />固定白色 · #ffffff</span></div>}
          <p className="field-hint">底座、边框与侧墙沿用山石色；两色时沿用山体色。</p>
          {options.snowEnabled && <p className="field-hint">积雪使用四色模式；关闭积雪后可选择两色或三色。</p>}
        </section>
        <section className="control-section framing-section"><h2>地形取景</h2><p className="framing-instruction">拖动地图顶点等比例调整范围，拖动十字移动取景。右键中心点，选择“旋转取景”。</p>
          {inspection && <p className="framing-measure">地面范围 {(inspection.selection.groundWidthM / 1000).toFixed(2)} × {(inspection.selection.groundHeightM / 1000).toFixed(2)} km · {options.bearingDeg.toFixed(1)}°</p>}
          <button className="reset-framing" onClick={resetFraming} disabled={controlsLocked || !route || (!options.center && options.groundWidthM === undefined && !options.bearingDeg)}>恢复自动取景</button>
          <details className="center-details"><summary>输入取景中心</summary><div className="field-pair"><NumberField label="中心纬度" value={center?.lat ?? NaN} onChange={value => moveCenter({ lat: value, lon: center?.lon ?? NaN })} min={-80} max={80} step={.0001} unit="°" disabled={controlsLocked || !route} /><NumberField label="中心经度" value={center?.lon ?? NaN} onChange={value => moveCenter({ lat: center?.lat ?? NaN, lon: value })} min={-180} max={180} step={.0001} unit="°" disabled={controlsLocked || !route} /></div></details>
        </section>
        <section className="control-section"><h2>模型尺寸</h2><label className="select-field">成品外形<select value={options.shape} disabled={controlsLocked} onChange={event => update('shape', event.currentTarget.value as ModelOptions['shape'])}><option value="rectangle">矩形</option><option value="circle">圆形</option><option value="polygon">正多边形</option></select></label>
          {options.shape === 'polygon' && <label className="select-field">多边形边数<select value={options.polygonSides} disabled={controlsLocked} onChange={event => update('polygonSides', Number(event.currentTarget.value))}>{[3, 4, 5, 6, 7, 8].map(n => <option value={n} key={n}>{n} 边形</option>)}</select></label>}
          <div className="field-pair"><NumberField label={options.shape === 'circle' ? '山体直径' : '打印长度'} value={options.widthMm} onChange={value => update('widthMm', value)} min={10} max={500} disabled={controlsLocked} />{options.shape === 'rectangle' && <NumberField label="打印宽度" value={options.heightMm} onChange={value => update('heightMm', value)} min={10} max={500} disabled={controlsLocked} />}</div>
          <p className="field-hint">外沿会增加成品外尺寸，最终尺寸见模型结果。</p>
          <div className="field-pair"><NumberField label="垂直夸张" value={options.zExaggeration} onChange={value => update('zExaggeration', value)} min={.1} max={20} step={.1} unit="倍" disabled={controlsLocked} /></div>
        </section>
        <section className="control-section snow-section"><h2>地形积雪</h2>
          <label className="checkbox-field" htmlFor="snow-enabled"><input id="snow-enabled" type="checkbox" checked={options.snowEnabled ?? false} disabled={controlsLocked} onChange={event=>update('snowEnabled',event.currentTarget.checked)} />启用积雪</label>
          <div className="field-pair"><NumberField label="积雪覆盖率" value={options.snowCoveragePercent ?? 30} onChange={value=>update('snowCoveragePercent',value)} min={0} max={100} step={.1} unit="%" disabled={controlsLocked||!options.snowEnabled} /><NumberField label="最大积雪厚度" value={options.snowMaxThicknessMm ?? 1} onChange={value=>update('snowMaxThicknessMm',value)} min={.1} max={10} step={.1} disabled={controlsLocked||!options.snowEnabled} /></div>
          <p className="route-contract">先积雪，再在雪面上生成路线</p>
          <p className="field-hint">按山体顶面俯视面积从高处向低处覆盖，包含路线下方地形；不覆盖底座和边框。边界自然变薄，陡坡雪层更薄。厚度为成品 Z 方向毫米，不随垂直夸张改变。</p>
        </section>
        <section className="control-section route-style-section"><h2>路线样式</h2>
          <div className="field-pair"><NumberField label="路线宽度" value={options.routeWidthMm} onChange={value => update('routeWidthMm', value)} min={.4} max={5} step={.1} disabled={controlsLocked} /><NumberField label="凸起厚度" value={options.routeHeightMm} onChange={value => update('routeHeightMm', value)} min={.1} max={10} step={.1} disabled={controlsLocked} /></div>
          <p className="route-contract">厚度是路线沿{options.snowEnabled?'当地雪面':'地表'}向上凸起的高度，不随垂直夸张改变。</p>
          <RouteColorPicker value={options.routeColor} onChange={value=>update('routeColor',value)} disabled={controlsLocked} />
        </section>
        <section className="control-section advanced-section"><details><summary>更多设置<span>底座、精度与取景</span></summary><div className="advanced-content">
          <div className="field-pair"><NumberField label="底座厚度" value={options.baseThicknessMm} onChange={value => update('baseThicknessMm', value)} min={.5} max={30} step={.5} disabled={controlsLocked} /><NumberField label="外沿宽度" value={options.frameWidthMm} onChange={value => update('frameWidthMm', value)} min={0} max={20} step={.5} disabled={controlsLocked} /></div>
          <label className="select-field">建模精度<select value={options.gridColumns} disabled={controlsLocked} onChange={event => update('gridColumns', Number(event.currentTarget.value))}><option value={65}>快速 · 65 点</option><option value={129}>标准 · 129 点</option><option value={257}>精细 · 257 点</option></select></label>
          <label className="select-field">地形平滑<select value={options.smoothing} disabled={controlsLocked} onChange={event => update('smoothing', event.currentTarget.value as ModelOptions['smoothing'])}><option value="raw">原始高程</option><option value="light">轻度平滑</option><option value="medium">中度平滑</option><option value="heavy">重度平滑</option></select></label>
          <div className="field-pair"><NumberField label="自动取景留白" value={options.paddingFraction * 100} onChange={value => update('paddingFraction', value / 100)} min={0} max={40} unit="%" disabled={controlsLocked || options.groundWidthM !== undefined} />{options.shape !== 'circle' && <NumberField label="圆角半径" value={options.cornerRadiusMm} onChange={value => update('cornerRadiusMm', value)} min={0} max={radiusMax} step={.5} disabled={controlsLocked} />}</div>
          <p className="field-hint">GPX、KML 与高程使用 WGS84 经纬度。地图底图离线时仍可设置取景；自动高程的可用纬度为 ±80°，暂不支持跨日期变更线的区域。</p>
        </div></details><details className="cache-details"><summary>本地缓存<span>{cacheInfo ? sizeLabel(cacheBytes) : '高程、地表影像与底图'}</span></summary><div className="cache-content">{cacheInfo && <><p>高程 {sizeLabel(cacheInfo.elevationBytes)} · 地表影像 {sizeLabel(cacheInfo.imageBytes ?? 0)} · 底图 {sizeLabel(cacheInfo.mapBytes)}</p><p className="cache-path" title={cacheInfo.path}>{cacheInfo.path}</p></>}<p className="field-hint">清理后已保存的打印文件不受影响；再次使用这些区域需联网。</p><button onClick={clearCache} disabled={controlsLocked || !api || !cacheInfo || cacheBytes === 0}>清理缓存</button>{cacheMessage && <p className="cache-message" role="status">{cacheMessage}</p>}</div></details></section>
      </aside>
      <section className="workspace" aria-label="路线范围与三维模型"><div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="工作区视图" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'route' : event.key === 'End' ? 'model' : tab === 'route' ? 'model' : 'route';
        setTab(next); document.getElementById(`${next}-tab`)?.focus();
      }}><button role="tab" id="route-tab" tabIndex={tab === 'route' ? 0 : -1} aria-controls="workspace-panel" aria-selected={tab === 'route'} onClick={() => setTab('route')}>地图取景</button><button role="tab" id="model-tab" tabIndex={tab === 'model' ? 0 : -1} aria-controls="workspace-panel" aria-selected={tab === 'model'} onClick={() => setTab('model')}>三维模型</button></div><span className={`result-state${stale ? ' stale' : ''}`}>{stale ? '此前结果 · 请重新生成' : preview && tab === 'model' ? '最终打印网格' : options.center || options.groundWidthM !== undefined ? '手动取景' : '自动取景'}</span></div>
        <div className="workspace-panel" id="workspace-panel" role="tabpanel" tabIndex={0} aria-labelledby={tab === 'route' ? 'route-tab' : 'model-tab'}><div className="workspace-view" hidden={tab !== 'route'}><RouteMap route={route} inspection={inspection} options={options} pending={inspectionPending} locked={controlsLocked} onCenter={moveCenter} onChange={changeFraming} /></div>{tab === 'model' && <TerrainView preview={preview} options={options} />}{previewPending && tab === 'model' && <div className="preview-loading" role="status">正在加载最终模型…</div>}</div>
        <div className="model-summary">{job?.result && previewId === job.id ? <><div><span>成品外尺寸</span><strong>{job.result.dimensions.x.toFixed(2)} × {job.result.dimensions.y.toFixed(2)} × {job.result.dimensions.z.toFixed(2)} <small>mm</small></strong><span className="model-dem-source" title={sourceLabel(job.result.demSource)}>{sourceLabel(job.result.demSource)}</span>{imageSource && <span className="model-image-source" title={`${imageSourceLabel(imageSource)}${imageSource.attribution ? ` · ${imageSource.attribution}` : ''}`}>{imageSourceLabel(imageSource)}</span>}{snowReport?.enabled && <span className="model-snow-source">{stale?'此前结果 · ':''}积雪目标 {snowReport.requestedCoveragePercent.toFixed(2)}% · 网格实测 {snowReport.actualCoveragePercent.toFixed(2)}% · 误差 {(Math.round((snowReport.actualCoveragePercent-snowReport.requestedCoveragePercent)*1000)/1000).toFixed(3)} 个百分点</span>}</div><div><span>打印结构与配色</span><strong className="print-color-count">{preview?.mesh.materialParts?.length?'一体装配':'闭合外形'} · {colorCount} 色</strong>{!!preview?.mesh.materialParts?.length && <span className="model-material-contract">材料区域拼合；STL 保存统一外形。</span>}</div><div><span>三角面</span><strong>{job.result.triangleCount.toLocaleString('zh-CN')}</strong></div></> : <><div><span>打印结构</span><strong>山体{options.snowEnabled?'＋积雪':''}＋路线＋一体底座</strong></div><p>地图取景后生成模型，可旋转检查实际成品。</p></>}</div>
      </section>
    </main>
    <footer className="task-footer">
      <div className="task-status">
        <div className="status-line"><span className={`status-dot${running ? ' active' : job?.state === 'succeeded' ? ' complete' : ''}`} /><span role="status">{status}</span>{running && <><span className="elapsed-time">{elapsedLabel(job!.createdAt, clockNow)}</span><strong>{progressPercent}%</strong></>}</div>
        {running && <>
          <div className="progress-track" role="progressbar" aria-label="模型生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><span style={{ width: `${progressPercent}%` }} /></div>
          {branches.length > 0 ? <div className="acquisition-progress" aria-label="影像与高程获取状态">{branches.map(branch => <div className="acquisition-row" key={branch.key} data-branch={branch.key}>
            <div className="acquisition-heading"><strong>{branch.label}</strong><span className={`branch-state${branch.state === '已就绪' ? ' complete' : ''}`}>{branch.state}</span><span className="branch-coverage">{branch.coverage}</span></div>
            <p className="branch-message" title={branch.message}>{branch.message}</p><p className="branch-data">{branch.data}</p>
          </div>)}</div> : <p className="generation-message">{job!.message}</p>}
        </>}
        {savedPath && <p className="saved-path" title={savedPath}>已保存：{savedPath}</p>}
        {(error || jobError?.message || configError || inspectionError) && <p className="task-error" role="alert">{error || jobError?.message || configError || inspectionError}</p>}
        {automaticImageFailure && <div className="image-recovery-actions" aria-label="地表影像获取恢复"><button onClick={generate} disabled={!canGenerate}>重试获取</button><button onClick={() => { changeImageMode('local'); requestAnimationFrame(() => { const control = document.getElementById('image-mode'); control?.focus(); control?.scrollIntoView({ block: 'center' }); }); }} disabled={controlsLocked}>切换本地导入</button></div>}
        {failure?.acquisitionRetry && <div className="acquisition-recovery-actions" aria-label="影像与高程获取恢复"><button onClick={generate} disabled={!canGenerate}>重试获取影像与高程</button></div>}
        {!running && !error && !jobError && !configError && !inspectionError && !savedPath && <p className="footer-hint">{exportFormat==='stl'?'STL 仅保存形状；彩色打印请选择 3MF 或 OBJ 包。':'彩色文件保存当前配色；切片时将颜色对应到可用耗材。'}</p>}
      </div>
      <div className="task-actions"><label className="export-format-label" htmlFor="export-format">输出格式<select id="export-format" value={exportFormat} disabled={controlsLocked} onChange={event=>{setExportFormat(event.currentTarget.value as '3mf'|'obj'|'stl');setSavedPath('');}}><option value="3mf">彩色 3MF</option><option value="obj">OBJ 材质包</option><option value="stl">STL 形状</option></select></label>{running ? <button onClick={() => void cancel()} disabled={job?.state === 'cancelling'}>{job?.state === 'cancelling' ? '正在取消' : '取消生成'}</button> : <button className="primary-button" onClick={generate} disabled={!canGenerate}>{job?.state === 'succeeded' || preview ? '重新生成' : '生成模型'}</button>}<button onClick={save} disabled={!canSave}>{saveLabel}</button></div>
    </footer>
    {dragging && <div className="drop-overlay"><div><h2>松开以导入文件</h2><p>GPX / KML 路线 · GeoTIFF 高程</p></div></div>}
  </div>;
}
