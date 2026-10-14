import {app,BrowserWindow,ipcMain,protocol,utilityProcess} from 'electron';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createDesktopManager} from '../main/manager.mjs';
import {createSessionStore} from '../main/session.mjs';
import {saveModelFile} from '../main/save-model.mjs';
import {validateOptions} from '../main/files.mjs';
import {prepareBaseText} from '../main/base-text-font.mjs';

// Runs the real renderer, IPC, local font reader, manager and utility process.
// A hidden window receives actual mouse/keyboard events. Only native file-dialog
// choices and unavailable network tiles are supplied by this acceptance harness.
const root=fileURLToPath(new URL('../../',import.meta.url));
const rendererArg=process.argv.find(arg=>arg.startsWith('--renderer='))?.slice(11);
let renderer=rendererArg?resolve(rendererArg):join(root,'desktop/dist/renderer/index.html');
if(!renderer.toLowerCase().endsWith('.html'))renderer=join(renderer,'index.html');
const output=join(root,'artifacts','text-placement-acceptance',String(Date.now()));
mkdirSync(output,{recursive:true});
app.setPath('userData',join(output,'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
protocol.registerSchemesAsPrivileged([{scheme:'terrain-map',privileges:{standard:true,secure:true}}]);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={passed:false,output,renderer,checks:[],models:[],screenshots:[],logs:[],saves:[],jobStarts:0,workerStarts:0,inspectionCount:0};
let manager,store,window,core,lastJob,lastInspection,lastInspectionRequest,savedOptions,inspectionSerial=0,finishedSerial=0;
const log=(message,value)=>{const item={at:new Date().toISOString(),message,...(value===undefined?{}:{value})};report.logs.push(item);console.log(JSON.stringify(item));};
const check=(name,details={})=>{report.checks.push({name,passed:true,...details});log('PASS '+name,details);};
const js=source=>window.webContents.executeJavaScript(source);
const wait=async(predicate,label,timeout=120000)=>{const until=Date.now()+timeout;while(!await predicate()){if(lastJob?.state==='failed')throw Error(label+': '+JSON.stringify(lastJob.error));assert.ok(Date.now()<until,'Timed out: '+label+' '+await js("document.querySelector('.task-error')?.textContent??''"));await delay(50);}};
const ready=label=>js(`[...document.querySelectorAll('button')].some(el=>el.textContent===${JSON.stringify(label)}&&!el.disabled)`);
const click=label=>js(`(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)}&&!el.disabled);if(!el)throw Error('button unavailable: '+${JSON.stringify(label)});el.click();})()`);
const setInput=async(selector,value)=>{await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('input unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await delay(50);};
const setSelect=async(label,value)=>{await js(`(()=>{const el=[...document.querySelectorAll('label')].find(el=>el.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('select');if(!el||el.disabled)throw Error('select unavailable: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await delay(50);};
const inspectReady=async predicate=>{await wait(()=>lastInspection&&predicate(lastInspectionRequest.options,lastInspection)&&js("![...document.querySelectorAll('.map-notice')].some(el=>el.textContent.includes('正在更新'))"),'exact inspection');await delay(60);};
const paths=()=>js("[...document.querySelectorAll('path.map-base-text-glyph')].map(el=>({d:el.getAttribute('d'),fill:el.getAttribute('fill'),fillRule:el.getAttribute('fill-rule')}))");
const point=selector=>js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
const key=async(keyCode,modifiers=[])=>{window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(80);};
const pointerClick=async selector=>{const p=await point(selector);window.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});await delay(80);};
const screen=async name=>{await delay(250);const path=join(output,name+'.png');await writeFile(path,(await window.webContents.capturePage()).toPNG());report.screenshots.push(path);};
const saveReady=()=>ready('保存彩色 3MF');
const visibleGlyphBounds=()=>js(`(()=>{const glyphs=[...document.querySelectorAll('path.map-base-text-glyph')].map(el=>el.getBoundingClientRect()),map=document.querySelector('.map-canvas').getBoundingClientRect();return {glyphs:glyphs.map(r=>({x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height})),map:{x:map.x,y:map.y,right:map.right,bottom:map.bottom},fits:glyphs.length>0&&glyphs.every(r=>r.x>=map.x-1&&r.y>=map.y-1&&r.right<=map.right+1&&r.bottom<=map.bottom+1)};})()`);
const markersClear=()=>js(`(()=>{const glyphs=[...document.querySelectorAll('path.map-base-text-glyph')].map(el=>el.getBoundingClientRect()),markers=[...document.querySelectorAll('.map-text-edge-marker')].map(el=>el.getBoundingClientRect()),center=document.querySelector('.map-center-marker').getBoundingClientRect(),overlap=(a,b)=>a.x<b.right&&a.right>b.x&&a.y<b.bottom&&a.bottom>b.y;return markers.every(marker=>!overlap(marker,center)&&glyphs.every(glyph=>!overlap(marker,glyph)));})()`);
async function generate(label){
  const oldId=lastJob?.id;
  await wait(async()=>await ready('重新生成')||await ready('生成模型'),label+' generate ready');
  await click(await ready('重新生成')?'重新生成':'生成模型');
  await wait(async()=>lastJob?.id!==oldId&&await saveReady(),label+' model ready');
  assert.equal(lastJob.state,'succeeded');
  const preview=await manager.preview(lastJob.id),validation=core.validateMaterialParts(preview.mesh);
  assert.equal(validation.outer.connectedComponents,1);assert.ok(validation.parts.some(part=>part.id==='text'&&part.volumeMm3>0));
  const text=preview.report.integratedModel.baseText;
  assert.match(text.fontIdentity.sha256,/^[a-f0-9]{64}$/);assert.ok(text.contours.some(contour=>contour.holes.length>0));
  const record={label,jobId:lastJob.id,triangles:lastJob.result.triangleCount,stlSha256:lastJob.result.stlSha256,validation,text};report.models.push(record);
  await js("document.querySelector('#route-tab').click()");await delay(100);
  return preview;
}
function contourBounds(contours){const points=contours.flatMap(contour=>contour.outer);return {minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};}
function verifyParity(mapText,solidText,label){
  assert.equal(mapText.contoursMm.length,solidText.contours.length,label+' contour count');
  assert.equal(mapText.contoursMm.reduce((n,c)=>n+c.holes.length,0),solidText.contours.reduce((n,c)=>n+c.holes.length,0),label+' glyph holes');
  for(const axis of ['x','y'])assert.ok(Math.abs(mapText.anchorMm[axis]-solidText.anchorMm[axis])<.001,label+' anchor '+axis);
  const a=contourBounds(mapText.contoursMm),b=contourBounds(solidText.contours);
  for(const key of Object.keys(a))assert.ok(Math.abs(a[key]-b[key])<.001,label+' glyph bounds '+key);
  return {mapAnchor:mapText.anchorMm,solidAnchor:solidText.anchorMm,mapBounds:a,solidBounds:b,toleranceMm:.001};
}
async function run(){
  await app.whenReady();protocol.handle('terrain-map',()=>new Response(null,{status:404}));
  core=await import(pathToFileURL(join(root,'dist/src/index.js')).href);
  manager=createDesktopManager({taskRoot:join(output,'tasks'),coreModuleUrl:pathToFileURL(join(root,'dist/src/index.js')).href,
    workerFactory:({workerPath,taskDir})=>{report.workerStarts++;const child=utilityProcess.fork(workerPath,[],{cwd:taskDir,stdio:'pipe'});child.stdout?.on('data',data=>log('worker stdout',String(data)));child.stderr?.on('data',data=>log('worker stderr',String(data)));return child;},
    onJob:job=>{lastJob=job;window?.webContents.send('terrain:job',job);}});
  store=createSessionStore({userDataDirectory:app.getPath('userData'),manager});
  const routePath=join(root,'fixtures/sample-trail.gpx'),demPath=join(root,'data/copernicus-longquanshan.tif');
  const route=await manager.addRoute(routePath),dem=await manager.addDem(demPath);
  report.input={route:routePath,routeSha256:sha(await readFile(routePath)),dem:demPath,demSha256:sha(await readFile(demPath)),imageMode:'none'};
  const options=validateOptions({shape:'circle',gridColumns:65,textEnabled:true,baseText:'山行08',baseTextSizeMm:3,baseTextAngleDeg:180,baseTextEdgeIndex:0,
    textColorSource:'custom',textColor:'#ffbb00',baseColorSource:'custom',baseColor:'#224466',frameWidthMm:3});
  const request={routeId:route.id,demId:dem.id,demMode:'local',imageMode:'none',offlineOnly:true,options};
  const handle=(name,fn)=>ipcMain.handle('terrain:'+name,async(_event,...args)=>{try{return {ok:true,value:await fn(...args)};}catch(error){log('IPC '+name+' error',{code:error.code,message:error.message});return {ok:false,error:{code:error.code??'ACCEPTANCE',message:error.message}};}});
  handle('runtime',()=>({version:'0.4.9 acceptance',units:'mm',platform:'win32',packaged:false}));handle('cache-info',()=>({path:output,elevationBytes:0,mapBytes:0,imageBytes:0}));
  handle('session-get',()=>store.getSession());handle('session-save',request=>{savedOptions=structuredClone(request.options);return store.saveSession(request);});handle('session-restore',()=>store.restoreSession());
  handle('choose-route',()=>manager.addRoute(routePath));handle('choose-dem',()=>manager.addDem(demPath));
  handle('inspect',async request=>{const serial=++inspectionSerial;report.inspectionCount++;const value=await manager.inspect(request);if(serial>finishedSerial){finishedSerial=serial;lastInspection=value;lastInspectionRequest=structuredClone(request);}return value;});
  handle('start',request=>{report.jobStarts++;return manager.start(request);});handle('get',id=>manager.get(id));handle('preview',id=>manager.preview(id));handle('cancel',id=>manager.cancel(id));
  handle('save-model',async request=>{const artifact=await manager.exportModel(request.id,request.format,request.options),path=join(output,'saved-'+report.saves.length+artifact.extension),saved=await saveModelFile(artifact.bytes,path);assert.equal(sha(await readFile(path)),saved.sha256);report.saves.push({request,...saved});return {cancelled:false,...saved};});
  await store.saveSession(request);
  window=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{preload:join(root,'desktop/main/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  window.webContents.on('console-message',event=>{if(event.level==='error'&&!event.message.includes('terrain-map'))log('renderer console',event.message);});
  await window.loadFile(renderer);await wait(()=>ready('恢复上次项目'),'restore ready');await click('恢复上次项目');
  await inspectReady(options=>options.shape==='circle'&&options.baseTextAngleDeg===180);
  await wait(()=>js("document.querySelectorAll('path.map-base-text-glyph').length>0&&!!document.querySelector('.map-text-rotation-marker')"),'real glyphs and text handle');
  await js("document.querySelector('.map-basemap input').click();document.querySelector('.base-style-section').scrollIntoView({block:'center'})");
  const prepared=await prepareBaseText(options.baseText,options.baseTextSizeMm),fontLayout=core.prepareTextLayout({...options,baseTextContours:prepared.contours,baseTextFontIdentity:prepared.fontIdentity},lastInspection.outlineMm.map(p=>({X:p.x*100000,Y:p.y*100000})),options.frameWidthMm);
  assert.deepEqual(lastInspection.baseTextPreview.contoursMm,fontLayout.report.contours);
  const initialPaths=await paths(),holeCount=lastInspection.baseTextPreview.contoursMm.reduce((n,c)=>n+c.holes.length,0);
  assert.ok(holeCount>0);assert.equal(initialPaths.length,lastInspection.baseTextPreview.contoursMm.length);assert.ok(initialPaths.every(path=>path.fillRule==='evenodd'&&path.fill==='#ffbb00'));
  assert.equal(initialPaths.reduce((n,path)=>n+(path.d.match(/M/g)??[]).length-1,0),holeCount);
  check('actual local font glyphs and counters visible before generation',{fontIdentity:prepared.fontIdentity,glyphContours:initialPaths.length,holeCount,jobStarts:report.jobStarts});
  await setInput('#base-text-angle-number',0);await inspectReady(options=>options.baseTextAngleDeg===0);assert.ok(lastInspection.baseTextPreview.anchorMm.y>60);const at0=structuredClone(lastInspection.baseTextPreview.contoursMm);
  await setInput('#base-text-angle-number',360);await inspectReady(options=>options.baseTextAngleDeg===360);assert.deepEqual(lastInspection.baseTextPreview.contoursMm,at0);
  await setInput('#base-text-angle',90);await inspectReady(options=>options.baseTextAngleDeg===90);assert.ok(lastInspection.baseTextPreview.anchorMm.x>60);assert.ok(Math.abs(lastInspection.baseTextPreview.anchorMm.y)<.001);assert.equal(await js("document.querySelector('#base-text-angle-number').value"),'90');assert.notDeepEqual(await paths(),initialPaths);
  assert.equal(report.jobStarts,0);assert.equal(report.workerStarts,0);check('absolute number and range move real paths; circle 0 and 360 coincide',{jobStarts:0});
  const beforePrecision=report.inspectionCount;await setSelect('建模精度',129);await inspectReady(options=>options.gridColumns===129);await setSelect('建模精度',65);await inspectReady(options=>options.gridColumns===65);assert.ok(report.inspectionCount>=beforePrecision+2);assert.equal(report.jobStarts,0);check('precision changes refresh actual text footprint without generation');
  await setInput('#base-text-angle-number',180);await inspectReady(options=>options.baseTextAngleDeg===180);
  const center=await point('.map-center-marker'),handlePoint=await point('.map-text-rotation-marker'),radius=Math.hypot(handlePoint.x-center.x,handlePoint.y-center.y),beforeDrag=await paths(),bearingBefore=savedOptions.bearingDeg;
  window.webContents.focus();window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(handlePoint.x),y:Math.round(handlePoint.y)});window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(handlePoint.x),y:Math.round(handlePoint.y)});
  for(let step=1;step<=12;step++){const angle=(180-step*90/12)*Math.PI/180;window.webContents.sendInputEvent({type:'mouseMove',button:'left',x:Math.round(center.x+Math.sin(angle)*radius),y:Math.round(center.y-Math.cos(angle)*radius)});await delay(25);}
  assert.notDeepEqual(await paths(),beforeDrag,'glyphs visibly update before mouse release');assert.ok(await js("document.querySelector('.map-rotation-status')?.textContent.includes('文字周向角度')"));
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(center.x+radius),y:Math.round(center.y)});
  await inspectReady(options=>Math.abs(options.baseTextAngleDeg-90)<1);assert.equal(savedOptions.bearingDeg,bearingBefore);assert.ok(lastInspection.baseTextPreview.anchorMm.x>60);assert.equal(report.jobStarts,0);
  check('real mouse arc drag rotates only text and updates paths during drag',{start:handlePoint,center,radiusPx:radius,angle:savedOptions.baseTextAngleDeg,bearing:savedOptions.bearingDeg});
  await setInput('#base-text-angle-number',90);await inspectReady(options=>options.baseTextAngleDeg===90);
  await js("document.querySelector('.map-text-rotation-marker').focus()");await key('Right');await inspectReady(options=>options.baseTextAngleDeg===91);assert.ok(await js("document.activeElement.classList.contains('map-text-rotation-marker')"));await key('Right',['shift']);await inspectReady(options=>options.baseTextAngleDeg===101);
  check('text handle keyboard changes absolute angle and retains focus',{angle:savedOptions.baseTextAngleDeg});
  await setInput('#base-text-angle-number',90);await inspectReady(options=>options.baseTextAngleDeg===90);await click('显示全貌');assert.ok((await visibleGlyphBounds()).fits);
  const inspectCount=report.inspectionCount;
  await js("document.querySelector('button[aria-label=\"编辑文字颜色\"]').click()");for(const [index,value] of [17,34,51].entries())await setInput(`.rgb-field:nth-child(${index+1}) input`,value);
  assert.ok((await paths()).every(path=>path.fill==='#112233'));await delay(350);assert.equal(report.inspectionCount,inspectCount);assert.equal(report.jobStarts,0);check('actual SVG text recolors immediately without inspect or generate',{color:'#112233'});
  await js("document.querySelector('.base-style-section').scrollIntoView({block:'center'})");await screen('circle-map-1400x1000');window.setSize(960,720);await delay(150);await click('显示全貌');await screen('circle-map-960x720');
  assert.ok((await visibleGlyphBounds()).fits);window.setSize(1400,1000);await delay(150);await click('显示全貌');
  const mapAt90=structuredClone(lastInspection.baseTextPreview),circle=await generate('circle angle 90');
  assert.ok(circle.report.integratedModel.baseText.anchorMm.x>60);assert.ok(Math.abs(circle.report.integratedModel.baseText.anchorMm.y)<.001);
  check('real circle solid matches map glyphs and closes',verifyParity(mapAt90,circle.report.integratedModel.baseText,'circle90'));
  await click('保存彩色 3MF');await wait(()=>js("!!document.querySelector('.saved-path')"),'actual color save');
  const circleId=lastJob.id;await setInput('#base-text-angle-number',270);assert.equal(await saveReady(),false);assert.ok(await js("!!document.querySelector('.result-state.stale')"));await inspectReady(options=>options.baseTextAngleDeg===270);assert.equal(lastJob.id,circleId);assert.equal(report.jobStarts,1);
  const regenerated=await generate('circle angle 270');assert.ok(regenerated.report.integratedModel.baseText.anchorMm.x< -60);assert.notEqual(lastJob.id,circleId);assert.equal(await saveReady(),true);
  check('position change marks old model stale and disables Save until real regenerate',{jobs:report.jobStarts});
  await setSelect('成品外形','polygon');await setSelect('多边形边数',5);await inspectReady(options=>options.shape==='polygon'&&options.polygonSides===5);
  await setInput('#base-text-edge-number',4);await inspectReady(options=>options.baseTextEdgeIndex===3);assert.equal(await js("document.querySelectorAll('.map-text-edge-marker').length"),5);assert.equal(await js("document.querySelector('.map-text-edge-marker[aria-pressed=true]').textContent"),'4');
  const edge3=structuredClone(lastInspection.baseTextPreview);
  await pointerClick('.map-text-edge-marker[title="选择第 2 边"]');await inspectReady(options=>options.baseTextEdgeIndex===1);assert.equal(await js("document.querySelector('#base-text-edge-number').value"),'2');assert.notDeepEqual(lastInspection.baseTextPreview.contoursMm,edge3.contoursMm);
  await js("document.querySelector('.map-text-edge-marker[title=\"选择第 5 边\"]').focus()");await key('Return');await inspectReady(options=>options.baseTextEdgeIndex===4);assert.equal(await js("document.querySelector('#base-text-edge-number').value"),'5');assert.ok(await js("document.activeElement.classList.contains('map-text-edge-marker')"));
  check('polygon number, real marker mouse click and keyboard pick selected centered edge',{sides:5,index:savedOptions.baseTextEdgeIndex});
  await setSelect('多边形边数',8);await inspectReady(options=>options.polygonSides===8);await setInput('#base-text-edge-number',8);await inspectReady(options=>options.baseTextEdgeIndex===7);assert.equal(await js("document.querySelectorAll('.map-text-edge-marker').length"),8);
  await setSelect('多边形边数',3);await inspectReady(options=>options.polygonSides===3&&options.baseTextEdgeIndex===2);assert.equal(await js("document.querySelector('#base-text-edge-number').value"),'3');assert.equal(await js("document.querySelectorAll('.map-text-edge-marker').length"),3);
  check('polygon 3, 5 and 8 sides and shrink clamp remain valid',{sides:savedOptions.polygonSides,index:savedOptions.baseTextEdgeIndex});
  await setInput('#base-text-edge-number',1);await inspectReady(options=>options.baseTextEdgeIndex===0);assert.ok(lastInspection.baseTextPreview.anchorMm.y<0);assert.ok(Math.abs(lastInspection.baseTextPreview.anchorMm.x)<.001);
  await click('显示全貌');assert.ok((await visibleGlyphBounds()).fits);assert.ok(await markersClear(),'edge markers must not cover glyphs or the center');
  await js("document.querySelector('.leaflet-control-zoom-in').click()");await delay(350);assert.ok(await markersClear(),'edge marker clearance after zoom');await js("document.querySelector('.leaflet-control-zoom-out').click()");await delay(350);
  await js("document.querySelector('.base-style-section').scrollIntoView({block:'center'})");await screen('polygon-map-1400x1000');window.setSize(960,720);await delay(150);await click('显示全貌');assert.ok(await markersClear(),'edge marker clearance after resize');await screen('polygon-map-960x720');check('edge numbers leave glyphs and center clear after zoom and resize');
  const footer=await js("[...document.querySelectorAll('.task-footer button,.task-footer select')].map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent,fit:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};})");assert.ok(footer.every(item=>item.fit));assert.ok((await visibleGlyphBounds()).fits);check('true glyphs and footer fit both window sizes with offline basemap',{footer});
  window.setSize(1400,1000);await delay(100);
  const jobCount=report.jobStarts;await js("document.querySelector('#text-enabled').click()");await wait(()=>js("document.querySelectorAll('.map-base-text-glyph,.map-text-edge-marker,.map-text-rotation-marker').length===0"),'text off clears overlays');
  assert.equal(await js("document.querySelector('#base-text').value"),options.baseText);await inspectReady(options=>options.textEnabled===false);assert.equal(lastInspection.baseTextPreview,undefined);assert.equal(report.jobStarts,jobCount);check('disabled text clears glyphs and all selection handles and retains input');
  await js("document.querySelector('#text-enabled').click()");await inspectReady(options=>options.textEnabled===true);await setInput('#base-text','😀');await inspectReady(options=>options.baseText==='😀');assert.ok(lastInspection.outlineGeo.length>0);assert.match(lastInspection.baseTextPreview.error,/字体|字形/);assert.ok(await js("document.querySelector('.text-preview-error')?.textContent.includes('文字预览')"));assert.ok(await js("document.querySelector('.map-notice')?.textContent.includes('文字预览')"));assert.ok(await js("document.querySelector('.map-center-marker')!==null"));
  check('font error appears beside text and map without losing route framing');
  await setInput('#base-text','   ');await inspectReady(options=>options.baseText==='   ');assert.equal(lastInspection.baseTextPreview,undefined);assert.equal(await js("document.querySelectorAll('.map-base-text-glyph,.map-text-edge-marker,.map-text-rotation-marker').length"),0);check('whitespace removes font preview and handles');
  report.finalOptions=savedOptions;report.passed=true;
}
run().catch(async error=>{report.error=error.stack??String(error);console.error(report.error);if(window&&!window.isDestroyed()){try{report.failureDom=await js("({error:document.querySelector('.task-error')?.textContent,status:document.querySelector('.result-state')?.textContent,footer:document.querySelector('.task-footer')?.textContent,body:document.body.textContent})");await screen('failure');}catch{}}}).finally(async()=>{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await writeFile(join(output,'run.log'),report.logs.map(item=>JSON.stringify(item)).join('\n'));await store?.close();window?.destroy();await manager?.close();console.log(JSON.stringify({passed:report.passed,report:join(output,'report.json')}));app.exit(report.passed?0:1);});
