import {app,BrowserWindow,ipcMain,protocol,utilityProcess} from 'electron';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {createDesktopManager} from '../main/manager.mjs';
import {createSessionStore} from '../main/session.mjs';
import {saveModelFile} from '../main/save-model.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=join(root,'artifacts','bt',String(Date.now()));
mkdirSync(output,{recursive:true});app.setPath('userData',join(output,'p'));app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'terrain-map',privileges:{standard:true,secure:true}}]);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const sha=b=>createHash('sha256').update(b).digest('hex');
function unzip(bytes){const files=new Map();let o=0;while(bytes.readUInt32LE(o)===0x04034b50){const method=bytes.readUInt16LE(o+8),length=bytes.readUInt32LE(o+18),n=bytes.readUInt16LE(o+26),e=bytes.readUInt16LE(o+28),name=bytes.toString('utf8',o+30,o+30+n),start=o+30+n+e,payload=bytes.subarray(start,start+length);files.set(name,method===8?inflateRawSync(payload):payload);o=start+length;}return files;}
let manager,store,window,lastJob;
const report={passed:false,trials:[],formats:[],output};
async function run(){
 await app.whenReady();protocol.handle('terrain-map',()=>new Response(null,{status:404}));
 const core=await import(pathToFileURL(join(root,'dist/src/index.js')).href);
 manager=createDesktopManager({taskRoot:join(output,'t'),coreModuleUrl:pathToFileURL(join(root,'dist/src/index.js')).href,timingHistoryPath:join(output,'timing.json'),softwareVersion:'base-text-verification',
 workerFactory:({workerPath,taskDir})=>utilityProcess.fork(workerPath,[],{cwd:taskDir,stdio:'pipe'}),onJob:job=>{lastJob=job;window?.webContents.send('terrain:job',job);}});
 store=createSessionStore({userDataDirectory:app.getPath('userData'),manager});
 const route=await manager.addRoute(join(root,'fixtures/sample-trail.gpx')),dem=await manager.addDem(join(root,'data/copernicus-longquanshan.tif'));
 const options={gridColumns:65,maxColors:6,baseText:'格聂牧场 · 2026',baseTextSizeMm:3,baseColorSource:'custom',baseColor:'#224466',textColorSource:'custom',textColor:'#ffcc00'};
 const request={routeId:route.id,demId:dem.id,demMode:'local',imageMode:'none',offlineOnly:true,options};
 const waitJob=async task=>{const until=Date.now()+120000;while(['running','cancelling'].includes(manager.get(task.id).state)){assert.ok(Date.now()<until,'generation timed out');await delay(25);}const job=manager.get(task.id);assert.equal(job.state,'succeeded',JSON.stringify(job.error));return job;};
 // Each prediction can only use earlier completed runs; no mock delays are calibration evidence.
 for(let n=0;n<7;n++){const initial=await manager.start(request),job=await waitJob(initial);assert.ok(job.timing.totalDurationMs>0);assert.equal(initial.timing.estimatedTotalMs,job.timing.estimatedTotalMs);
 const errorFraction=Math.abs(initial.timing.estimatedTotalMs-job.timing.totalDurationMs)/job.timing.totalDurationMs;
 report.trials.push({cacheClass:'local',initial:initial.timing,actual:job.timing,errorFraction,within10Percent:errorFraction<=.1});}
 const job=lastJob,preview=await manager.preview(job.id),materials=core.validateMaterialParts(preview.mesh);
 assert.ok(materials.parts.some(p=>p.id==='base'));assert.ok(materials.parts.some(p=>p.id==='text'));
 assert.equal(materials.outer.connectedComponents,1);assert.ok(Math.abs(materials.volumeMm3-materials.outerVolumeMm3)<=materials.volumeToleranceMm3);
 assert.equal(preview.report.integratedModel.baseText.text,options.baseText);
 report.materials=materials;report.text=preview.report.integratedModel.baseText;
 const colors={...preview.appearance.options,baseColor:'#112233',textColor:'#ffffff'};
 for(const format of ['3mf','obj','stl']){const artifact=await manager.exportModel(job.id,format,colors),saved=await saveModelFile(artifact.bytes,join(output,'label'+artifact.extension));
 assert.equal(sha(await readFile(saved.path)),saved.sha256);
 if(format==='stl')assert.equal(saved.sha256,job.result.stlSha256);else{const files=unzip(artifact.bytes),manifest=JSON.parse(files.get(format==='3mf'?'Metadata/manifest.json':'manifest.json').toString('utf8'));assert.ok(manifest.materialParts.some(p=>p.id==='text'));assert.ok(manifest.appearance.palette.some(p=>p.color==='#112233'));assert.ok(manifest.appearance.palette.some(p=>p.color==='#ffffff'));}
 report.formats.push({format,...saved});}
 const duration=manager.get(job.id).timing.totalDurationMs;await delay(50);assert.equal(manager.get(job.id).timing.totalDurationMs,duration);
 const handle=(name,fn)=>ipcMain.handle('terrain:'+name,async(_,...args)=>{try{return {ok:true,value:await fn(...args)};}catch(e){return {ok:false,error:{code:e.code??'TEST',message:e.message}};}});
 handle('runtime',()=>({version:'verification',units:'mm',platform:'win32',packaged:false}));handle('cache-info',()=>({path:output,elevationBytes:0,mapBytes:0,imageBytes:0}));
 handle('session-get',()=>store.getSession());handle('session-save',r=>store.saveSession(r));handle('session-restore',()=>store.restoreSession());
 handle('choose-route',()=>manager.addRoute(join(root,'fixtures/sample-trail.gpx')));handle('choose-dem',()=>manager.addDem(join(root,'data/copernicus-longquanshan.tif')));
 handle('inspect',r=>manager.inspect(r));handle('start',r=>manager.start(r));handle('get',id=>manager.get(id));handle('preview',id=>manager.preview(id));handle('cancel',id=>manager.cancel(id));
 await store.saveSession(request);
 window=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{preload:join(root,'desktop/main/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
 await window.loadFile(join(root,'desktop/dist/renderer/index.html'));
 const js=code=>window.webContents.executeJavaScript(code);
 const wait=async(fn,name)=>{const until=Date.now()+90000;while(!await fn()){assert.ok(Date.now()<until,name+' '+await js("document.querySelector('.task-error')?.textContent??''"));await delay(50);}};
 const ready=label=>js(`[...document.querySelectorAll('button')].some(el=>el.textContent===${JSON.stringify(label)}&&!el.disabled)`);
 const click=label=>js(`[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)}&&!el.disabled).click()`);
 await wait(()=>ready('恢复上次项目'),'restore ready');await click('恢复上次项目');await wait(()=>ready('生成模型'),'import restored');
 assert.equal(await js("document.querySelector('#base-text').value"),options.baseText);
 await js("document.querySelector('#base-text').scrollIntoView({block:'center'})");await delay(100);await writeFile(join(output,'settings.png'),(await window.webContents.capturePage()).toPNG());
 await click('生成模型');await wait(()=>js("!!document.querySelector('.estimate-time')"),'estimate visible');
 assert.equal(await js("document.querySelector('.estimate-time').compareDocumentPosition(document.querySelector('.elapsed-time'))&Node.DOCUMENT_POSITION_FOLLOWING?true:false"),true);
 await writeFile(join(output,'running.png'),(await window.webContents.capturePage()).toPNG());
 await wait(()=>ready('保存彩色 3MF'),'result ready');assert.match(await js("document.querySelector('.total-generation-time')?.textContent??''"),/建模总用时/);
 await js("document.querySelector('#model-tab').click()");await delay(300);await writeFile(join(output,'model.png'),(await window.webContents.capturePage()).toPNG());
 window.setSize(960,720);await delay(200);await writeFile(join(output,'small-model.png'),(await window.webContents.capturePage()).toPNG());
 assert.equal(await js(`(() => [...document.querySelectorAll('.task-footer .status-line,.task-footer button,.task-footer select')].every(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}))()`),true,'footer must fit small window');
 report.passed=true;report.finalJob=lastJob;
}
run().catch(e=>{report.error=e.stack??String(e);console.error(report.error);process.exitCode=1;}).finally(async()=>{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await store?.close();window?.destroy();await manager?.close();console.log(JSON.stringify({passed:report.passed,report:join(output,'report.json')}));app.exit(report.passed?0:1);});
