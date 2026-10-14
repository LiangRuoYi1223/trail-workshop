import assert from 'node:assert/strict';
import {mkdirSync,realpathSync} from 'node:fs';
import {mkdir,readFile,readdir,writeFile,appendFile,lstat} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {BOUNDS,ROUTE_SHA256,LIMITS,sha256,assertBounds,inspectImage,createObserver} from './verification/genyen-observer.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const {values}=parseArgs({options:{mode:{type:'string',default:'preflight'},'run-root':{type:'string'},
  'reuse-run':{type:'string'},help:{type:'boolean',default:false}}});
const mode=values.mode;
if(values.help) {
  console.log('verify-genyen-acquisition.mjs --mode=preflight|cold|fault-two|fault-exhaust|offline [--run-root=SHORT_PATH/artifacts/new-verification] [--reuse-run=r...]');
  process.exit(0);
}
assert.ok(['preflight','cold','fault-two','fault-exhaust','offline'].includes(mode));
if(!process.versions.electron && mode!=='preflight') {
  const {default:electron}=await import('electron');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),...process.argv.slice(2)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  child.stdout.on('data',bytes=>process.stdout.write(bytes));
  child.stderr.on('data',bytes=>process.stderr.write(bytes));
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',value=>done(value??1));});
  process.exit(code);
}
const electronApi=process.versions.electron ? await import('electron') : undefined;
const app=electronApi?.app,net=electronApi?.net;
// Short output/profile/cache paths avoid Windows path failures. No user cache is read or copied.
const requestedRunRoot=resolve(values['run-root']??'C:/Users/ander/Documents/ChatGPT/路线3D打印‘/artifacts/new-verification');
assert.equal(basename(requestedRunRoot),'new-verification');
assert.equal(basename(resolve(requestedRunRoot,'..')),'artifacts');
mkdirSync(requestedRunRoot,{recursive:true});
const runRoot=realpathSync(requestedRunRoot);
assert.equal(basename(runRoot),'new-verification');
assert.equal(basename(resolve(runRoot,'..')),'artifacts');
assert.ok(runRoot.length<=105,'Use a shorter owned artifacts/new-verification run root');
if(values['reuse-run'])assert.match(values['reuse-run'],/^r[a-z0-9]{6,20}$/);
assert.equal(Boolean(values['reuse-run']),mode==='offline','Only standalone offline mode accepts/requires --reuse-run');
const runId='r'+Date.now().toString(36)+randomBytes(2).toString('hex'),output=join(runRoot,runId),profile=join(output,'p');
mkdirSync(runRoot,{recursive:true});mkdirSync(output);mkdirSync(profile);
app?.setPath('userData',profile);app?.disableHardwareAcceleration();
const report={schema:1,mode,runId,output,startedAt:new Date().toISOString(),
  route:{path:'C:/Users/ander/Desktop/20261012_115743.kml',sha256:ROUTE_SHA256,expectedPoints:2586},
  expectedBounds:BOUNDS,limits:LIMITS,runtime:{electron:process.versions.electron,node:process.versions.node},
  passed:false,liveAcquisitionExecuted:false,assumptions:[]};
let logs=Promise.resolve(),observer;
function record(value) {
  logs=logs.then(()=>appendFile(join(output,'events.ndjson'),JSON.stringify(value)+'\n'));
  if(value.type==='progress'&&(['query','cloud','complete'].includes(value.stage)||value.retryCount!==undefined))
    console.log('GENYEN_PROGRESS '+JSON.stringify(value));
}
async function inventory(directory) {
  const entries=[];
  for(const name of await readdir(directory,{withFileTypes:true})) {
    assert.ok(!name.isSymbolicLink(),'Test cache contains no links');
    const path=join(directory,name.name),stat=await lstat(path);
    if(name.isDirectory())for(const entry of await inventory(path))entries.push({path:name.name+'/'+entry.path,bytes:entry.bytes,sha256:entry.sha256});
    else if(name.isFile())entries.push({path:name.name,bytes:stat.size,sha256:sha256(await readFile(path))});
  }
  return entries;
}
async function offlineCheck(core,cacheDir,expected) {
  let networkCalls=0;
  const offlineProgress=[];
  const loaded=await core.loadSentinelColorImage(BOUNDS,{cacheDir,lookbackMonths:24,offlineOnly:true,
    fetch:async()=>{networkCalls++;throw new Error('Offline verification attempted network');},
    onProgress:event=>offlineProgress.push(event)});
  const actual=inspectImage(loaded);
  assert.equal(networkCalls,0);assert.equal(actual.source.cacheHit,true);
  for(const field of ['pixelSha256','boundarySha256','sourceIdentitySha256'])assert.equal(actual[field],expected[field],field);
  assert.equal(actual.metadata.sha256,expected.metadata.sha256);
  assert.deepEqual(actual.source.scenes,expected.source.scenes);assertBounds(actual.source.bounds);
  assert.ok(offlineProgress.every(event=>(event.downloadedBytes??0)===0),'Offline mode downloads zero bytes');
  return {passed:true,networkCalls,downloadedBytes:0,...actual,progress:offlineProgress};
}
async function run() {
  await app?.whenReady();
  const core=await import(pathToFileURL(join(repo,'dist/src/index.js')).href);
  const routeBytes=await readFile(report.route.path);
  assert.equal(sha256(routeBytes),ROUTE_SHA256,'Exact KML input identity');
  const route=core.parseRouteXml(routeBytes.toString('utf8'),{fileName:'20261012_115743.kml'});
  const points=route.segments.flatMap(segment=>segment.points);
  assert.equal(points.length,2586);
  const options={shape:'polygon',widthMm:120,heightMm:80,polygonSides:6,cornerRadiusMm:0,bearingDeg:0,paddingFraction:.1,
    baseThicknessMm:2,zExaggeration:2,gridColumns:257,smoothing:'raw',maxMissingFraction:.01,
    routeWidthMm:1,routeHeightMm:1,frameWidthMm:3};
  const frame=core.createTerrainFrame(points,options);
  for(const key of Object.keys(BOUNDS))assert.ok(Math.abs(frame.bounds[key]-BOUNDS[key])<1e-10,'Current framing reproduces the accepted view: '+key);
  // Acquisition always receives BOUNDS exactly; computed frame has platform floating-point drift.
  report.route.actualPoints=points.length;report.route.name=route.name;report.frame=frame.bounds;
  report.groundExtentKm={width:(BOUNDS.east-BOUNDS.west)*111320*Math.cos((BOUNDS.south+BOUNDS.north)*Math.PI/360)/1000,
    height:(BOUNDS.north-BOUNDS.south)*111320/1000};
  assert.ok(Math.abs(report.groundExtentKm.width-18.60)<.02&&Math.abs(report.groundExtentKm.height-18.60)<.02);
  const cacheDir=mode==='offline'?join(runRoot,values['reuse-run'],'c'):join(output,'c');
  report.cacheDir=cacheDir;
  if(mode==='offline') {
    const previous=JSON.parse(await readFile(join(runRoot,values['reuse-run'],'report.json'),'utf8'));
    assert.equal(previous.passed,true,'Offline source is a successful recorded live run');
    assert.equal(previous.route.sha256,ROUTE_SHA256);
    report.offline=await offlineCheck(core,cacheDir,previous.result);
    report.passed=true;return;
  }
  await mkdir(cacheDir);report.cacheBefore=await inventory(cacheDir);
  assert.equal(report.cacheBefore.length,0,'Cold/fault run cache must begin entirely empty');
  report.coldCacheVerified=true;
  if(mode==='preflight') {
    report.assumptions.push('Preflight contacts no service and does not claim acquisition success.');
    report.passed=true;return;
  }
  const faultLimit=mode==='fault-two'?2:mode==='fault-exhaust'?3:0;
  observer=createObserver({transport:(input,init)=>net.fetch(input,init),faultLimit,onRecord:record});
  report.liveAcquisitionExecuted=true;
  let loaded,error;
  try {
    // One invocation: all retry decisions, cumulative accounting and deadlines belong to production.
    loaded=await core.loadSentinelColorImage(BOUNDS,{cacheDir,lookbackMonths:24,timeoutMs:LIMITS.timeoutMs,
      fetch:observer.fetch,onProgress:observer.progress});
  }catch(issue){error=issue;}
  report.trace=observer.summary();report.cacheAfter=await inventory(cacheDir);
  assert.equal(report.trace.ledger.monotonic,true,'Download counter must not reset across retries');
  assert.ok(report.trace.stats.assetBytes<=LIMITS.downloadBytes,'Actual asset traffic stays within shared 512 MiB budget');
  assert.ok(report.trace.ledger.lastDownloadedBytes<=LIMITS.downloadBytes);
  assert.ok(report.trace.elapsedMs<LIMITS.timeoutMs+15000,'Retry-inclusive wall time stays within shared deadline');
  const retryEvents=report.trace.progress.filter(event=>Number.isInteger(event.retryCount));
  if(retryEvents.length)assert.ok(retryEvents.every(event=>event.retryCount<=LIMITS.retries));
  report.assumptions.push('Shared budget is checked through monotonic provider counters against real streamed bytes; reservation unit tests remain required.',
    'Shared deadline evidence records one loader call and real total elapsed time; a short fault run does not itself exercise expiry.',
    'Scene span includes intervening concurrent work; coverage attribution is explicit sceneId or last scene asset read.');
  if(mode==='fault-exhaust') {
    assert.ok(error,'Third injected transient failure must exhaust two retry credits');
    assert.equal(report.trace.stats.injectedFaults,3,'Initial plus exactly two retry opportunities');
    assert.match(error.code??'',/^IMAGE_(NETWORK|TIMEOUT)/);
    assert.ok(!report.cacheAfter.some(entry=>/sentinel-[a-f0-9]+\.json$/.test(entry.path)),'Failed run must not publish complete RGB cache');
    assert.ok(report.cacheAfter.some(entry=>entry.path.endsWith('.block')),'Verified blocks survive failure');
    assert.equal(report.trace.ledger.partialStreamBytesAccounted,true,'Failed partial transfers count in cumulative ledger');
    report.expectedFailure={code:error.code,message:error.message};report.passed=true;return;
  }
  if(error)throw error;
  assert.equal(loaded.source.cacheHit,false,'Fresh cache success came from online acquisition');
  report.result=inspectImage(loaded);
  assert.equal(report.trace.ledger.partialStreamBytesAccounted,true,'Every streamed asset byte, including interrupted bytes, counts');
  assert.equal(report.trace.progress.at(-1)?.coverage,1,'Provider certifies center and edge coverage complete');
  if(mode==='fault-two') {
    assert.equal(report.trace.stats.injectedFaults,2,'Both transient faults exercised');
    assert.ok(report.trace.stats.assetBytes>0);assert.ok(report.cacheAfter.some(entry=>entry.path.endsWith('.block')));
  }
  report.offline=await offlineCheck(core,cacheDir,report.result);
  report.passed=true;
}
async function main() {
try {await run();}
catch(error){report.passed=false;report.error={name:error.name,code:error.code,message:error.message,stack:error.stack};
  if(observer)report.trace=observer.summary();}
await logs;
report.finishedAt=new Date().toISOString();
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log('GENYEN_REPORT '+JSON.stringify({passed:report.passed,mode,output,error:report.error,liveAcquisitionExecuted:report.liveAcquisitionExecuted}));
if(app)app.exit(report.passed?0:1);else process.exit(report.passed?0:1);






}
void main();
