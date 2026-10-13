import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the workspace junction before Electron creates its profile/cache.
const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const output = join(root, 'artifacts', 'author-support-v047-check');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const renderer = realpathSync(argument('renderer') ? resolve(argument('renderer')) : join(root, 'desktop/dist/renderer/index.html'));
const reference = argument('reference') ?? join(root, 'desktop/renderer/assets/author-support-wechat.png');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, `profile-${Date.now()}`));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'terrain-map', privileges: { standard: true, secure: true } }]);

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let window;
let windowsCreated = 0;
let generationRequests = 0;
const errors = [];
const externalRequests = [];
const screenshots = [];
const checks = [];
app.on('browser-window-created', () => { windowsCreated++; });

async function run() {
  const original = await readFile(reference);
  assert.equal(original.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'reference must be the original PNG');
  assert.equal(original.subarray(12, 16).toString(), 'IHDR', 'reference must expose its PNG dimensions');
  const dimensions = { width: original.readUInt32BE(16), height: original.readUInt32BE(20) };
  const originalSha256 = sha256(original);

  await app.whenReady();
  protocol.handle('terrain-map', () => new Response(null, { status: 404 }));
  const sessionInfo = {
    schemaVersion: 1,
    preferences: { options: {}, demMode: 'auto', imageMode: 'auto', imageLookbackMonths: 24, offlineOnly: false },
    warnings: [],
  };
  const handle = (name, operation) => ipcMain.handle(`terrain:${name}`, async (_event, ...args) => {
    try { return { ok: true, value: await operation(...args) }; }
    catch (error) { return { ok: false, error: { code: 'TEST', message: error.message } }; }
  });
  handle('runtime', () => ({ version: '0.4.7', platform: 'win32', packaged: false, units: 'mm' }));
  handle('cache-info', () => ({ path: output, elevationBytes: 0, mapBytes: 0, imageBytes: 0 }));
  handle('session-get', () => sessionInfo);
  handle('session-save', request => {
    sessionInfo.preferences = {
      options: request.options, demMode: request.demMode, imageMode: request.imageMode,
      imageLookbackMonths: request.imageLookbackMonths, offlineOnly: request.offlineOnly,
    };
    return sessionInfo;
  });
  handle('session-restore', () => ({ ...sessionInfo.preferences, warnings: [] }));
  handle('start', () => { generationRequests++; throw Error('Opening author support must not generate a model'); });

  window = new BrowserWindow({
    show: false, useContentSize: true, width: 1280, height: 900,
    webPreferences: {
      preload: join(root, 'desktop/main/preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true,
    },
  });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    externalRequests.push({ url: request.url, resourceType: request.resourceType });
    callback({ cancel: true });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', event => {
    if (event.level === 'error' && !event.message.includes('terrain-map')) errors.push(event.message);
  });
  await window.loadFile(renderer);
  window.webContents.focus();
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw Error(`${error.message}\nRenderer: ${source}\nConsole: ${JSON.stringify(errors)}`, { cause: error }); }
  };
  const wait = async (predicate, label, timeout = 10000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await predicate()) return;
      await delay(25);
    }
    throw Error(`Timed out: ${label}`);
  };
  const modalOpen = () => js("Boolean(document.querySelector('#author-support-dialog')?.open)");
  const focusedInDialog = () => js("Boolean(document.querySelector('#author-support-dialog')?.contains(document.activeElement))");
  const mouseClick = async (x, y) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await delay(60);
  };
  const clickElement = async selector => {
    const bounds = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await mouseClick(bounds.x, bounds.y);
  };
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(60);
  };
  const checkHeaderButton = async () => {
    const state = await js(`(() => {
      const button = document.querySelector('#support-author');
      if (!button) return null;
      const header = button.closest('header'), r = button.getBoundingClientRect(), style = getComputedStyle(button);
      const h = header?.getBoundingClientRect();
      return { text: button.textContent.trim(), tag: button.tagName, disabled: button.disabled, inHeader: Boolean(header),
        visible: style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0 && r.width > 0 && r.height > 0,
        fitsHeader: Boolean(h && r.left >= h.left && r.right <= h.right && r.top >= h.top && r.bottom <= h.bottom),
        fitsViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
    })()`);
    assert.ok(state, 'real renderer must show the 支持作者 button in the software header');
    assert.equal(state.tag, 'BUTTON');
    assert.equal(state.text, '支持作者');
    assert.equal(state.disabled, false, 'support is available before importing a route or generating a model');
    assert.equal(state.inHeader && state.visible && state.fitsHeader && state.fitsViewport, true, 'support button must be completely visible in the header');
  };
  const open = async () => {
    await clickElement('#support-author');
    await wait(modalOpen, 'support dialog opens');
    await wait(() => js("(() => { const img = document.querySelector('#author-support-dialog img'); return Boolean(img?.complete && img.naturalWidth > 0); })()"), 'original QR image loads');
    assert.equal(await focusedInDialog(), true, 'opening the modal must focus its controls');
    assert.equal(windowsCreated, 1, 'support must reuse the main window');
    assert.equal(generationRequests, 0, 'support must not require a model task');
  };
  const assertClosed = async label => {
    await wait(async () => !await modalOpen(), label);
    assert.equal(await js("document.activeElement?.id"), 'support-author', 'closing must restore focus to the support button');
    checks.push(label);
  };
  const imageState = () => js(`(() => {
    const dialog = document.querySelector('#author-support-dialog'), img = dialog?.querySelector('img');
    if (!dialog || !img) return null;
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const clips = [];
    for (let el = img.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (['hidden', 'clip', 'auto', 'scroll'].includes(s.overflowX) || ['hidden', 'clip', 'auto', 'scroll'].includes(s.overflowY)) clips.push({ rect: rect(el), overflowX: s.overflowX, overflowY: s.overflowY });
      if (el === dialog) break;
    }
    const labelledBy = dialog.getAttribute('aria-labelledby'), style = getComputedStyle(img);
    return { tag: dialog.tagName, modal: dialog.matches(':modal'), labelledBy, title: labelledBy ? document.getElementById(labelledBy)?.textContent.trim() : null,
      alt: img.alt, src: img.currentSrc || img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      objectFit: style.objectFit, image: rect(img), dialog: rect(dialog), viewport: { width: innerWidth, height: innerHeight }, clips };
  })()`);
  const checkImage = async () => {
    const state = await imageState();
    assert.ok(state, 'dialog must contain the author QR image');
    assert.equal(state.tag, 'DIALOG');
    assert.equal(state.modal, true, 'support must open as a native modal dialog');
    assert.ok(state.labelledBy, 'dialog must have an accessible title');
    assert.equal(state.title, '支持作者');
    assert.equal(state.alt, '作者微信收款码');
    assert.equal(state.naturalWidth, dimensions.width);
    assert.equal(state.naturalHeight, dimensions.height);
    assert.equal(new URL(state.src).protocol, 'file:', 'the payment image must load from the installed local assets');
    const displayedBytes = await readFile(fileURLToPath(state.src));
    assert.equal(sha256(displayedBytes), originalSha256, 'displayed image must preserve every original QR image byte');
    assert.equal(state.objectFit, 'contain', 'the complete image must fit inside its display area');
    const { image: i, dialog: d, viewport: v } = state;
    assert.ok(i.width > 0 && i.height > 0);
    assert.ok(Math.abs(i.width / i.height - dimensions.width / dimensions.height) < 0.003, 'display must preserve the original image aspect ratio');
    assert.ok(d.left >= -1 && d.top >= -1 && d.right <= v.width + 1 && d.bottom <= v.height + 1, 'dialog must fit the viewport');
    assert.ok(i.left >= d.left - 1 && i.top >= d.top - 1 && i.right <= d.right + 1 && i.bottom <= d.bottom + 1, 'the complete payment image must fit the dialog');
    for (const clip of state.clips) {
      if (['hidden', 'clip', 'auto', 'scroll'].includes(clip.overflowX)) assert.ok(i.left >= clip.rect.left - 1 && i.right <= clip.rect.right + 1, 'ancestor must not clip image horizontally');
      if (['hidden', 'clip', 'auto', 'scroll'].includes(clip.overflowY)) assert.ok(i.top >= clip.rect.top - 1 && i.bottom <= clip.rect.bottom + 1, 'ancestor must not clip image vertically');
    }
    return state;
  };
  const capture = async (name, width, height) => {
    window.setContentSize(width, height);
    await delay(300);
    await checkHeaderButton();
    const state = await checkImage();
    const screenshot = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    assert.deepEqual(screenshot.getSize(), { width, height });
    await writeFile(join(output, name), screenshot.toPNG());
    screenshots.push({ name, width, height, ...state });
  };

  await wait(() => js("[...document.querySelectorAll('button')].some(el => el.textContent.trim() === '导入路线' && !el.disabled)"), 'renderer startup');
  await checkHeaderButton();
  assert.equal(await modalOpen(), false, 'startup must not automatically open the payment dialog');
  await open();
  await capture('01-author-support-1280x900.png', 1280, 900);

  // Use real Chromium keyboard events to check forward/backward focus cycling.
  for (const modifiers of [[], [], ['shift'], ['shift']]) {
    await key('Tab', modifiers);
    const focus = await js("(() => { const dialog=document.querySelector('#author-support-dialog'), active=document.activeElement; return {inside:dialog.contains(active),open:dialog.open,activeTag:active?.tagName,activeId:active?.id,hasDocumentFocus:document.hasFocus()}; })()");
    assert.equal(focus.inside, true, `Tab and Shift+Tab must retain focus inside the payment modal: ${JSON.stringify({ modifiers, ...focus })}`);
  }
  checks.push('keyboard focus stays in modal');
  const closeButton = await js("(() => { const button = [...document.querySelectorAll('#author-support-dialog button')].find(el => el.textContent.trim() === '关闭收款码'); return button?.id || null; })()");
  if (closeButton) await clickElement(`#${closeButton}`);
  else {
    const bounds = await js("(() => { const button = [...document.querySelectorAll('#author-support-dialog button')].find(el => el.textContent.trim() === '关闭收款码'); if (!button) throw Error('Close payment image button missing'); const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    await mouseClick(bounds.x, bounds.y);
  }
  await assertClosed('close button closes payment image');

  await open();
  await key('Escape');
  await assertClosed('Escape closes payment image');

  await open();
  await capture('02-author-support-960x720.png', 960, 720);
  const outside = await js("(() => { const r = document.querySelector('#author-support-dialog').getBoundingClientRect(); if (r.left > 5) return { x: r.left / 2, y: innerHeight / 2 }; if (r.top > 5) return { x: innerWidth / 2, y: r.top / 2 }; if (innerWidth - r.right > 5) return { x: (r.right + innerWidth) / 2, y: innerHeight / 2 }; throw Error('No visible modal backdrop to click'); })()");
  await mouseClick(outside.x, outside.y);
  await assertClosed('backdrop closes payment image');

  await open();
  await checkImage();
  await key('Escape');
  await assertClosed('repeated opening works');
  assert.equal(windowsCreated, 1, 'repeated support clicks must not create another BrowserWindow');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(generationRequests, 0, 'support must stay independent of terrain generation');
  assert.deepEqual(externalRequests, [], 'support UI must make no external network requests');
  assert.deepEqual(errors, [], 'renderer must not report unexpected errors');
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, renderer, reference, dimensions, originalSha256,
    originalBytes: original.length, windowsCreated, generationRequests, checks, screenshots, errors, externalRequests }, null, 2));
  console.log(`Author support UI verified: ${dimensions.width}x${dimensions.height}, original SHA256 ${originalSha256}`);
}

run().then(() => {
  window?.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error);
  await writeFile(join(output, 'failure.txt'), error.stack ?? String(error));
  if (window && !window.isDestroyed()) await writeFile(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
  window?.destroy(); app.exit(1);
});
