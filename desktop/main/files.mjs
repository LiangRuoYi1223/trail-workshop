import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

export class DesktopError extends Error {
  constructor(code, message) { super(message); this.name = 'DesktopError'; this.code = code; }
}

export function publicError(error, fallback = '操作失败，请重试') {
  if (error instanceof DesktopError) return { code: error.code, message: error.message };
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^(GPX|KML|GEO|DEM|IMAGE|APPEARANCE|COLOR|SESSION|CONFIG|MESH|MODEL)_/.test(code)
    && typeof error.message === 'string' && !/[A-Za-z]:[\\/]|file:\/\/|https?:\/\//.test(error.message)) {
    return { code, message: error.message.slice(0, 300) };
  }
  return { code: 'IO_FAILED', message: fallback };
}

export function validateOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DesktopError('CONFIG_INVALID', '模型参数格式无效');
  const allowed = new Set(['shape', 'widthMm', 'heightMm', 'polygonSides', 'cornerRadiusMm', 'bearingDeg', 'paddingFraction',
    'center', 'groundWidthM', 'baseThicknessMm', 'zExaggeration', 'gridColumns', 'smoothing', 'maxMissingFraction', 'routeWidthMm', 'routeHeightMm', 'routeColor', 'frameWidthMm', 'maxColors', 'grassColor', 'rockColor']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new DesktopError('CONFIG_INVALID', '存在不支持的模型参数');
  const output = {
    shape: 'rectangle', widthMm: 120, heightMm: 80, polygonSides: 6, cornerRadiusMm: 0,
    bearingDeg: 0, paddingFraction: 0.1, baseThicknessMm: 2, zExaggeration: 2,
    gridColumns: 129, smoothing: 'raw', maxMissingFraction: 0.01, routeWidthMm: 1, routeHeightMm: 1, routeColor: '#c84832', frameWidthMm: 3,
    maxColors: 3, grassColor: '#799278', rockColor: '#a9aa92',
    ...input,
  };
  const range = (key, min, max, label, integral = false) => {
    if (typeof output[key] !== 'number' || !Number.isFinite(output[key]) || output[key] < min || output[key] > max
      || (integral && !Number.isInteger(output[key]))) throw new DesktopError('CONFIG_INVALID', `${label}须在 ${min}–${max} 之间${integral ? '，并为整数' : ''}`);
  };
  if (!['rectangle', 'circle', 'polygon'].includes(output.shape)) throw new DesktopError('CONFIG_INVALID', '请选择矩形、圆形或正多边形');
  if (!['raw', 'light', 'medium', 'heavy'].includes(output.smoothing)) throw new DesktopError('CONFIG_INVALID', '请选择有效的地形平滑级别');
  range('widthMm', 10, 500, '山体宽度'); range('heightMm', 10, 500, '山体高度');
  range('polygonSides', 3, 8, '多边形边数', true); range('bearingDeg', -360, 360, '旋转角度');
  range('paddingFraction', 0, 0.4, '取景留白'); range('baseThicknessMm', 0.5, 30, '底座厚度');
  range('zExaggeration', 0.01, 20, '垂直夸张'); range('gridColumns', 17, 257, '精度点数', true);
  range('maxMissingFraction', 0, 0.05, '允许高程缺值比例'); range('routeWidthMm', 0.4, 5, '路线宽度');
  range('routeHeightMm', 0.1, 10, '路线厚度');
  if (![2, 3].includes(output.maxColors)) throw new DesktopError('CONFIG_INVALID', '打印颜色上限须为 2 或 3');
  for (const [key, label] of [['routeColor', '路线'], ['grassColor', '草地'], ['rockColor', '山石']]) {
    if (typeof output[key] !== 'string' || !/^#[a-f0-9]{6}$/i.test(output[key])) throw new DesktopError('CONFIG_INVALID', `${label}颜色须为有效的 RGB 颜色`);
    output[key] = output[key].toLowerCase();
  }
  range('frameWidthMm', 0, 20, '外沿宽度');
  const cornerLimit = output.shape === 'circle' ? 0 : output.shape === 'rectangle'
    ? Math.min(output.widthMm, output.heightMm) / 2 : output.widthMm / 2 * Math.cos(Math.PI / output.polygonSides);
  range('cornerRadiusMm', 0, cornerLimit, '圆角半径');
  if (output.groundWidthM !== undefined) range('groundWidthM', 1, 100000, '取景地面宽度');
  if (output.center !== undefined) {
    const center = output.center;
    if (!center || typeof center !== 'object' || Array.isArray(center) || Object.keys(center).some(key => !['lat', 'lon'].includes(key))
      || typeof center.lat !== 'number' || !Number.isFinite(center.lat) || Math.abs(center.lat) > 80
      || typeof center.lon !== 'number' || !Number.isFinite(center.lon) || Math.abs(center.lon) > 180) throw new DesktopError('CONFIG_INVALID', '取景中心须为有效经纬度，纬度在 ±80° 内');
    output.center = Object.freeze({ lat: center.lat, lon: center.lon });
  }
  return Object.freeze(output);
}

export async function checkedInput(path, extensions, maxBytes, label) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new DesktopError('INPUT_INVALID', `请选择有效的${label}文件`);
  if (!extensions.includes(extname(path).toLowerCase())) throw new DesktopError('INPUT_INVALID', `${label}文件格式不支持`);
  try {
    const actual = await realpath(path), entry = await stat(actual);
    if (!entry.isFile()) throw new DesktopError('INPUT_INVALID', `${label}须为普通文件`);
    if (entry.size === 0) throw new DesktopError('INPUT_EMPTY', `${label}文件为空`);
    if (entry.size > maxBytes) throw new DesktopError('INPUT_TOO_LARGE', `${label}文件超过 ${maxBytes / 1024 / 1024} MB，请先裁剪`);
    return { path: actual, fileName: basename(path), bytes: entry.size };
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('INPUT_READ_FAILED', `无法读取${label}文件，请检查文件是否存在及读取权限`);
  }
}

export async function removeOwnedTask(root, taskDir, id) {
  const target = resolve(taskDir), parent = resolve(root);
  if (dirname(target) !== parent || basename(target) !== id || !/^[0-9a-f-]{36}$/i.test(id)) throw new DesktopError('TASK_PATH_INVALID', '临时任务目录检查失败');
  // Never follow a substituted directory link during recursive cleanup.
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new DesktopError('TASK_PATH_INVALID', '临时任务目录已被替换');
  } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  await rm(target, { recursive: true, force: true });
}

async function readOutput(path, maximum) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximum) throw new DesktopError('OUTPUT_INVALID', '生成文件格式或大小异常');
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new DesktopError('OUTPUT_INVALID', '生成文件超过大小限制');
  return bytes;
}

export async function verifyOutput(taskDir, validateAppearance) {
  try {
    const stlPath = resolve(taskDir, 'model.stl');
    const [stl, reportBytes, previewBytes] = await Promise.all([
      readOutput(stlPath, 84 + 500000 * 50), readOutput(resolve(taskDir, 'model.report.json'), 16 * 1024 * 1024),
      readOutput(resolve(taskDir, 'model.preview.json'), 160 * 1024 * 1024),
    ]);
    const report = JSON.parse(reportBytes.toString('utf8')), preview = JSON.parse(previewBytes.toString('utf8'));
    if (stl.length < 134) throw new DesktopError('OUTPUT_INVALID', '生成 STL 为空或不完整');
    const triangleCount = stl.readUInt32LE(80), stlSha256 = createHash('sha256').update(stl).digest('hex');
    const mesh = preview.mesh;
    if (triangleCount < 1 || triangleCount > 500000 || stl.length !== 84 + triangleCount * 50
      || report.output?.sha256 !== stlSha256 || report.output?.bytes !== stl.length
      || report.stage !== 2 || report.validation?.triangleCount !== triangleCount || report.validation?.connectedComponents !== 1
      || report.validation?.boundaryEdges !== 0 || report.validation?.nonManifoldEdges !== 0
      || !mesh || !Array.isArray(mesh.positions) || mesh.positions.length % 3 || !Array.isArray(mesh.indices) || mesh.indices.length !== triangleCount * 3
      || !Array.isArray(mesh.faceKinds) || mesh.faceKinds.length !== triangleCount) throw new DesktopError('OUTPUT_INVALID', '生成网格或文件校验未通过');
    // The renderer receives exactly the coordinates stored in the binary STL.
    mesh.positions = mesh.positions.map(Math.fround);
    if (mesh.positions.some(value => !Number.isFinite(value))) throw new DesktopError('OUTPUT_INVALID', '预览坐标无效');
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      for (let vertex = 0; vertex < 3; vertex++) {
        const index = mesh.indices[triangle * 3 + vertex];
        if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= mesh.positions.length) throw new DesktopError('OUTPUT_INVALID', '预览索引无效');
        for (let axis = 0; axis < 3; axis++) {
          const coordinate = stl.readFloatLE(84 + triangle * 50 + 12 + vertex * 12 + axis * 4);
          if (!Number.isFinite(coordinate) || coordinate !== mesh.positions[index * 3 + axis]) throw new DesktopError('OUTPUT_MISMATCH', '预览与保存的 STL 不一致');
          low[axis] = Math.min(low[axis], coordinate); high[axis] = Math.max(high[axis], coordinate);
        }
      }
    }
    const dimensions = { x: high[0] - low[0], y: high[1] - low[1], z: high[2] - low[2] };
    if (Object.values(dimensions).some(value => value <= 0 || value > 541) || low[2] !== 0) throw new DesktopError('OUTPUT_INVALID', '成品尺寸检查失败');
    if (preview.appearance !== undefined) {
      if (typeof validateAppearance !== 'function') throw new DesktopError('OUTPUT_INVALID', '彩色外观校验不可用，请重新生成');
      try { validateAppearance(preview.appearance, triangleCount); }
      catch { throw new DesktopError('OUTPUT_INVALID', '彩色外观与网格校验未通过'); }
      if (report.appearanceHash !== preview.appearance.hash) throw new DesktopError('OUTPUT_MISMATCH', '预览配色与生成记录不一致');
    } else if (report.appearanceHash !== undefined) throw new DesktopError('OUTPUT_INVALID', '彩色预览缺失，请重新生成');
    preview.report = report;
    return { path: stlPath, bytes: stl.length, stlSha256, triangleCount, dimensions, preview };
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('OUTPUT_READ_FAILED', '无法读取生成结果，文件可能不完整，请重新生成');
  }
}
