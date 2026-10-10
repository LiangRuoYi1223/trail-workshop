import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { DesktopError, publicError, validateOptions } from './files.mjs';

const VERSION = 1, MAX_JSON_BYTES = 65536;
const clone = value => structuredClone(value);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum = 250) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f]/.test(value);
const withoutGeography = options => { const { center, groundWidthM, ...preferences } = options; return preferences; };
const defaults = () => ({ options: withoutGeography(validateOptions()), demMode: 'auto', offlineOnly: false });

function source(value, kind) {
  const maximum = kind === 'route' ? 2 * 1024 * 1024 : 256 * 1024 * 1024;
  if (!record(value) || Object.keys(value).some(key => !['path', 'fileName', 'bytes', 'sha256', 'isSample', 'name', 'dataset'].includes(key))
    || typeof value.path !== 'string' || value.path.includes('\0') || !isAbsolute(value.path)
    || !text(value.fileName) || basename(value.fileName) !== value.fileName || /[\\/]/.test(value.fileName)
    || !(kind === 'route' ? ['.gpx'] : ['.tif', '.tiff']).includes(extname(value.path).toLowerCase())
    || !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > maximum
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.isSample !== 'boolean' || (value.name !== undefined && !text(value.name))
    || (value.dataset !== undefined && !text(value.dataset))) throw new DesktopError('SESSION_INVALID', '上次项目记录无效，请重新导入文件');
  return clone(value);
}

function preferences(value) {
  if (!record(value) || Object.keys(value).some(key => !['options', 'demMode', 'offlineOnly'].includes(key))
    || !record(value.options) || !['auto', 'local'].includes(value.demMode) || typeof value.offlineOnly !== 'boolean') throw new DesktopError('SESSION_INVALID', '上次设置无效，已恢复默认设置');
  return { options: withoutGeography(validateOptions(value.options)), demMode: value.demMode, offlineOnly: value.offlineOnly };
}

function recent(value) {
  if (!record(value) || Object.keys(value).some(key => !['route', 'dem', 'options', 'demMode', 'offlineOnly', 'savedAt'].includes(key))
    || !record(value.options) || !['auto', 'local'].includes(value.demMode) || typeof value.offlineOnly !== 'boolean'
    || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) throw new DesktopError('SESSION_INVALID', '上次项目记录无效，请重新导入文件');
  return { route: source(value.route, 'route'), ...(value.demMode === 'local' && value.dem !== undefined ? { dem: source(value.dem, 'dem') } : {}),
    options: validateOptions(value.options), demMode: value.demMode, offlineOnly: value.offlineOnly, savedAt: value.savedAt };
}

// Reject directory junctions and substituted final files before reads or writes.
async function checkedDirectory(path, create = false) {
  const target = resolve(path); let entry;
  try { entry = await lstat(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(target);
    if (parent === target) throw new DesktopError('SESSION_PATH_INVALID', '设置保存位置无效');
    await checkedDirectory(parent, create);
    if (!create) return false;
    try { await mkdir(target); } catch (creation) { if (creation.code !== 'EEXIST') throw creation; }
    entry = await lstat(target);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await realpath(target), target)) throw new DesktopError('SESSION_PATH_INVALID', '设置保存目录已被替换，请检查软件数据位置');
  return true;
}

async function checkedFile(path, reading = true) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (reading && entry.size > MAX_JSON_BYTES)) throw new DesktopError('SESSION_INVALID', '上次设置文件无效或过大，已恢复默认设置');
    return entry;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Main-process-owned settings: no renderer-supplied paths or arbitrary file IO. */
export function createSessionStore({ userDataDirectory, manager }) {
  if (typeof userDataDirectory !== 'string' || !isAbsolute(userDataDirectory) || userDataDirectory.includes('\0')
    || typeof manager?.sessionSources !== 'function') throw new DesktopError('CONFIG_INVALID', '桌面设置配置无效');
  const directory = resolve(userDataDirectory), file = join(directory, 'session-v1.json');
  let state = { schemaVersion: VERSION, preferences: defaults() }, warnings = [], closed = false;
  const summary = () => clone({ schemaVersion: VERSION, preferences: state.preferences,
    ...(state.recentProject ? { recentProject: { routeName: state.recentProject.route.name ?? state.recentProject.route.fileName,
      routeFileName: state.recentProject.route.fileName, ...(state.recentProject.dem ? { demFileName: state.recentProject.dem.fileName } : {}),
      savedAt: state.recentProject.savedAt } } : {}), warnings });
  const ready = (async () => {
    try {
      if (!await checkedDirectory(directory) || !await checkedFile(file)) return;
      const bytes = await readFile(file);
      if (bytes.length > MAX_JSON_BYTES) throw new DesktopError('SESSION_INVALID', '上次设置文件过大，已恢复默认设置');
      const stored = JSON.parse(bytes.toString('utf8'));
      if (!record(stored) || stored.schemaVersion !== VERSION) throw new DesktopError('SESSION_VERSION_UNSUPPORTED', '上次设置版本不兼容，已恢复默认设置');
      try { state.preferences = preferences(stored.preferences); }
      catch { warnings.push('上次设置无效，已恢复默认设置'); }
      if (stored.recentProject !== undefined) {
        try { state.recentProject = recent(stored.recentProject); }
        catch { warnings.push('上次项目记录无效，请重新导入文件；可用的模型设置已保留'); }
      }
    } catch (error) { warnings.push(error instanceof DesktopError ? error.message : '无法读取上次设置，已恢复默认设置；请重新导入路线'); }
  })();
  let pending = ready;
  const enqueue = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  async function persist(nextState) {
    const bytes = Buffer.from(JSON.stringify(nextState, null, 2));
    if (bytes.length > MAX_JSON_BYTES) throw new DesktopError('SESSION_INVALID', '最近项目设置过大，请简化项目名称');
    const temporary = join(directory, `session-v1.${randomUUID()}.tmp`);
    try {
      await checkedDirectory(directory, true); await checkedFile(file, false);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await checkedDirectory(directory); await checkedFile(file, false);
      await rename(temporary, file);
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError('SESSION_SAVE_FAILED', '无法保存软件设置，请检查软件数据目录的写入权限');
    } finally {
      // Never follow a replaced parent while cleaning the temporary file.
      try { await checkedDirectory(directory); await unlink(temporary); } catch { /* The complete previous JSON remains usable. */ }
    }
  }
  return {
    async getSession() { await pending; return summary(); },
    saveSession(input) {
      if (closed) return Promise.reject(new DesktopError('APP_CLOSED', '软件正在退出'));
      let frozen;
      try {
        if (!record(input) || Object.keys(input).some(key => !['routeId', 'demId', 'demMode', 'offlineOnly', 'options'].includes(key))
          || !['auto', 'local'].includes(input.demMode) || typeof input.offlineOnly !== 'boolean'
          || (input.routeId !== undefined && typeof input.routeId !== 'string') || (input.demId !== undefined && typeof input.demId !== 'string')) throw new DesktopError('CONFIG_INVALID', '设置参数无效');
        const options = validateOptions(input.options);
        const sources = manager.sessionSources({ routeId: input.routeId, demId: input.demId });
        if (sources.route) sources.route.name = String(sources.route.name).replace(/[\x00-\x1f]/g, ' ').slice(0, 250) || sources.route.fileName;
        frozen = clone({ options, demMode: input.demMode, offlineOnly: input.offlineOnly, sources });
      } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const next = { schemaVersion: VERSION, preferences: { options: withoutGeography(frozen.options), demMode: frozen.demMode, offlineOnly: frozen.offlineOnly },
          ...(state.recentProject ? { recentProject: state.recentProject } : {}) };
        if (frozen.sources.route) next.recentProject = recent({ route: frozen.sources.route,
          ...(frozen.demMode === 'local' && frozen.sources.dem ? { dem: frozen.sources.dem } : {}),
          options: frozen.options, demMode: frozen.demMode, offlineOnly: frozen.offlineOnly, savedAt: new Date().toISOString() });
        await persist(next); state = next; return summary();
      });
    },
    restoreSession() {
      if (closed) return Promise.reject(new DesktopError('APP_CLOSED', '软件正在退出'));
      return enqueue(async () => {
        const project = state.recentProject, restored = { ...clone(state.preferences), warnings: [...warnings] };
        if (!project) { restored.warnings.push('没有可恢复的上次项目，请导入路线'); return restored; }
        try {
          restored.route = await manager.addRoute(project.route.path, { isSample: project.route.isSample, expectedSha256: project.route.sha256 });
          restored.options = clone(project.options); restored.demMode = project.demMode; restored.offlineOnly = project.offlineOnly;
        } catch (error) { restored.warnings.push(`上次路线无法恢复：${publicError(error, '文件不存在或无法读取，请重新导入').message}`); return restored; }
        if (project.demMode === 'local') {
          if (!project.dem) restored.warnings.push('上次项目未选择本地高程，请选择覆盖路线的 GeoTIFF');
          else try { restored.dem = await manager.addDem(project.dem.path, { isSample: project.dem.isSample, dataset: project.dem.dataset,
            expectedSha256: project.dem.sha256, validate: true }); }
          catch (error) { restored.warnings.push(`上次本地高程无法恢复：${publicError(error, '文件不存在或无法读取，请重新选择').message}`); }
        }
        return restored;
      });
    },
    async close() { closed = true; await pending; },
  };
}
