import {app,BrowserWindow,ipcMain,protocol} from 'electron';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const rendererArg=process.argv.find(value=>value.startsWith('--renderer='))?.slice(11);
const renderer=rendererArg?resolve(rendererArg):join(root,'desktop/dist/renderer/index.html');
const output=join(root,'artifacts','usage-guide-check',String(Date.now()));
mkdirSync(output,{recursive:true});app.setPath('userData',join(output,'profile'));app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'terrain-map',privileges:{standard:true,secure:true}}]);
const report={passed:false,renderer,checks:[],screenshots:[],requests:[],modelActions:0};
let window;const delay=ms=>new Promise(done=>setTimeout(done,ms));
const js=source=>window.webContents.executeJavaScript(source);
const check=name=>report.checks.push({name,passed:true});
const wait=async(fn,name)=>{const until=Date.now()+5000;while(!await fn()){assert.ok(Date.now()<until,name);await delay(25);}};
const click=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(50);};
const open=async()=>{await click('#usage-guide');await wait(()=>js("document.querySelector('#usage-guide-dialog')?.open"),'guide opens');};
async function run(){
  await app.whenReady();protocol.handle('terrain-map',()=>new Response(null,{status:404}));
  const handle=(name,fn)=>ipcMain.handle('terrain:'+name,async(_,...args)=>({ok:true,value:await fn(...args)}));
  const session={schemaVersion:1,preferences:{options:{},demMode:'auto',imageMode:'auto',imageLookbackMonths:24,offlineOnly:false},warnings:[]};
  handle('runtime',()=>({version:'0.4.10',platform:'win32',packaged:false,units:'mm'}));
  handle('cache-info',()=>({path:output,elevationBytes:0,imageBytes:0,mapBytes:0}));
  handle('session-get',()=>session);handle('session-save',request=>{session.preferences={options:request.options,demMode:request.demMode,imageMode:request.imageMode,imageLookbackMonths:request.imageLookbackMonths,offlineOnly:request.offlineOnly};return session;});
  for(const name of ['start','save-model','choose-route','choose-dem','choose-image','clear-cache'])handle(name,()=>{report.modelActions++;throw Error('Usage guide must not perform model actions');});
  window=new BrowserWindow({show:false,useContentSize:true,width:1400,height:1000,webPreferences:{preload:join(root,'desktop/main/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{report.requests.push(request.url);done({cancel:true});});
  await window.loadFile(renderer);window.webContents.focus();
  await delay(250);
  assert.equal(await js("!!document.querySelector('#usage-guide')"),true,'使用说明 button exists');
  assert.equal(await js("document.querySelector('#usage-guide').compareDocumentPosition(document.querySelector('#support-author'))&Node.DOCUMENT_POSITION_FOLLOWING?true:false"),true);
  const positions=await js("['usage-guide','support-author'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,right:r.right}})");assert.ok(positions[0].right<=positions[1].x);
  check('usage button is immediately left of author support');
  const settingsBefore=structuredClone(session.preferences);
  await open();assert.equal(await js("document.querySelector('#usage-guide').getAttribute('aria-expanded')"),'true');
  assert.equal(await js("document.querySelector('#usage-guide-dialog').contains(document.activeElement)"),true);
  const headings=await js("[...document.querySelectorAll('.usage-guide-section h3')].map(el=>el.textContent)");
  for(const title of ['第一次使用','路线与高程','地形取景','模型尺寸','地形积雪','路线样式','底座与文字','更多设置','本地缓存','地图取景','三维模型','生成与保存'])assert.ok(headings.includes(title),'guide covers '+title);
  const text=await js("document.querySelector('#usage-guide-dialog').textContent");
  for(const keyword of ['草地识别强度','草地连片程度','共用颜色盘','32 MB','0–360','居中','3MF','OBJ','STL','重新生成'])assert.ok(text.includes(keyword),'guide includes '+keyword);
  check('all modules and current grass/color/text/export operations covered');
  const links=await js("[...document.querySelectorAll('.usage-guide-nav button')].map(el=>el.getAttribute('aria-controls'))");assert.ok(links.length>=15);
  for(const id of links){await click(`.usage-guide-nav button[aria-controls="${id}"]`);assert.equal(await js(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top>=document.querySelector('.usage-guide-content').getBoundingClientRect().top-2`),true);}
  check('contents navigation reaches every section');
  await js("document.querySelector('#usage-guide-close').focus()");
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await delay(50);
  assert.equal(await js("document.querySelector('#usage-guide-dialog').contains(document.activeElement)"),true);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await delay(50);
  assert.equal(await js("document.querySelector('#usage-guide-dialog').contains(document.activeElement)"),true);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(()=>js("!document.querySelector('#usage-guide-dialog').open"),'Escape closes');
  await wait(()=>js("document.activeElement.id==='usage-guide'&&document.querySelector('#usage-guide').getAttribute('aria-expanded')==='false'"),'Escape restores trigger focus');check('keyboard focus stays inside and Escape returns to trigger');
  for(const [width,height] of [[1400,1000],[960,720]]){
    window.setContentSize(width,height);await delay(100);await open();
    const bounds=await js("(()=>{const d=document.querySelector('#usage-guide-dialog'),r=d.getBoundingClientRect(),c=document.querySelector('.usage-guide-content');return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,noHorizontalOverflow:c.scrollWidth<=c.clientWidth+1}})()");
    assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.viewportWidth&&bounds.bottom<=bounds.viewportHeight&&bounds.noHorizontalOverflow,JSON.stringify(bounds));
    const file=join(output,`guide-${width}x${height}.png`);await writeFile(file,(await window.webContents.capturePage()).toPNG());report.screenshots.push(file);
    await click('#usage-guide-close');assert.equal(await js("document.activeElement.id"),'usage-guide');
  }
  check('guide and header fit normal and minimum window sizes');
  await open();window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:5,y:5});window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:5,y:5});await wait(()=>js("!document.querySelector('#usage-guide-dialog').open"),'outside click closes');
  await click('#support-author');assert.equal(await js("document.querySelector('#author-support-dialog').open"),true);await js("document.querySelector('#author-support-dialog').close()");
  assert.deepEqual(session.preferences,settingsBefore);assert.equal(report.modelActions,0);assert.deepEqual(report.requests,[]);
  check('local guide preserves author support, settings and model actions');report.passed=true;
}
run().catch(error=>{report.error=error.stack??String(error);console.error(report.error);}).finally(async()=>{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));window?.destroy();console.log(JSON.stringify({passed:report.passed,report:join(output,'report.json')}));app.exit(report.passed?0:1);});
