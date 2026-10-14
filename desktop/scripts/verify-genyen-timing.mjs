import assert from 'node:assert/strict';
import {mkdirSync,createWriteStream,realpathSync,readFileSync,lstatSync} from 'node:fs';
import {mkdir,readdir,lstat,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {inflateRawSync} from 'node:zlib';
import {BOUNDS,ROUTE_SHA256} from './verification/genyen-observer.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url);
const {values}=parseArgs({options:{mode:{type:'string',default:'preflight'},'run-root':{type:'string'},
  'warm-runs':{type:'string',default:'7'},'resume-run':{type:'string'},help:{type:'boolean',default:false}}});
assert.ok(['preflight','run'].includes(values.mode));
if(values['resume-run']){assert.equal(values.mode,'run');assert.match(values['resume-run'],/^r[a-z0-9]{6,20}$/);}
const warmRuns=Number(values['warm-runs']);
assert.ok(Number.isInteger(warmRuns)&&warmRuns>=7&&warmRuns<=15,'Run 7–15 chronological warm tasks');
const runRoot=resolve(values['run-root']??'D:/AI聊天数据/ChatGPT-Workspaces/路线3D打印‘/artifacts/gt');
assert.equal(basename(runRoot),'gt');assert.equal(basename(resolve(runRoot,'..')),'artifacts');
assert.ok(runRoot.length<=105,'Use a short canonical artifacts/gt directory');
const OPTIONS=Object.freeze({shape:'polygon',widthMm:120,heightMm:80,polygonSides:6,cornerRadiusMm:0,bearingDeg:0,paddingFraction:.1,
  baseThicknessMm:2,zExaggeration:2,gridColumns:257,smoothing:'raw',maxMissingFraction:.01,
  routeWidthMm:1,routeHeightMm:1,routeColor:'#353ac8',frameWidthMm:3,maxColors:6,
  grassColor:'#799278',rockColor:'#c1c1ae',snowEnabled:true,snowCoveragePercent:30,snowMaxThicknessMm:1,
  baseText:'格聂牧场 · 2026',baseTextSizeMm:3,baseColorSource:'grass',textColorSource:'route'});
const sha256=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const estimateOf=value=>({estimatedTotalMs:value.estimatedTotalMs,estimatedRangeMs:value.estimatedRangeMs,
  confidence:value.confidence,estimateVersion:value.estimateVersion});
let app,utilityProcess,manager,output,logStream,current,heartbeat;
const report={schema:1,purpose:'actual-production-whole-flow-timing',mode:values.mode,softwareVersion:'genyen-timing-verify',
  startedAt:new Date().toISOString(),options:OPTIONS,expectedBounds:BOUNDS,requestedWarmRuns:warmRuns,
  passed:false,liveGenerationExecuted:false,runs:[],limitations:[
    'passed denotes successful structural verification; timingTargetPassed separately reports actual measured 10% results.',
    'Cold and warm tasks use real manager/worker clocks. No injected clocks, fake workers, copied user caches or harness retries.',
    'This cohort uses automatic DEM/imagery; local-input accuracy is measured in a separate local cohort.',
    'Per-phase millisecond durations come from the production history sample; observed phase-change timestamps are supporting evidence.']};

function unzip(bytes) {
  const files=new Map();let offset=0,total=0;
  while(offset+30<=bytes.length&&bytes.readUInt32LE(offset)===0x04034b50) {
    const flags=bytes.readUInt16LE(offset+6),method=bytes.readUInt16LE(offset+8),compressed=bytes.readUInt32LE(offset+18),
      expanded=bytes.readUInt32LE(offset+22),nameLength=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
    assert.equal(flags&8,0,'Archive sizes are in headers');assert.ok([0,8].includes(method));
    assert.ok(expanded<=100*1024*1024&&compressed<=100*1024*1024);
    const start=offset+30+nameLength+extra;assert.ok(start+compressed<=bytes.length);
    const name=bytes.toString('utf8',offset+30,offset+30+nameLength),payload=bytes.subarray(start,start+compressed);
    const data=method===8?inflateRawSync(payload,{maxOutputLength:100*1024*1024}):payload;
    assert.equal(data.length,expanded);assert.ok(!files.has(name));files.set(name,data);
    total+=data.length;assert.ok(total<=300*1024*1024&&files.size<=12);
    offset=start+compressed;
  }
  assert.ok(files.size>0);return files;
}
const attribute=(value,key)=>{const match=new RegExp('\\b'+key+'="([^"]+)"').exec(value);assert.ok(match,'Missing '+key);return match[1];};
function read3mf(xml,palette) {
  assert.ok(xml.includes('unit="millimeter"')&&xml.includes('<components>'));
  const parts=[];
  for(const object of xml.matchAll(/<object\b[^>]*name="([^"]+)"[^>]*><mesh>([\s\S]*?)<\/mesh><\/object>/g)) {
    const positions=[],indices=[];
    for(const vertex of object[2].matchAll(/<vertex\b([^>]+)\/>/g))
      for(const axis of ['x','y','z'])positions.push(Number(attribute(vertex[1],axis)));
    for(const face of object[2].matchAll(/<triangle\b([^>]+)\/>/g)) {
      for(const axis of ['v1','v2','v3'])indices.push(Number(attribute(face[1],axis)));
      const colors=['p1','p2','p3'].map(key=>Number(attribute(face[1],key)));
      assert.ok(colors.every(value=>Number.isInteger(value)&&value===colors[0]&&value>=0&&value<palette.length));
    }
    parts.push({id:object[1],positions,indices});
  }
  assert.equal((xml.match(/<component objectid=/g)??[]).length,parts.length);
  return parts;
}
function readObj(text) {
  const parts=[];let currentPart,globalVertices=0;
  for(const line of text.split('\n')) {
    if(line.startsWith('o ')){currentPart={id:line.slice(2),positions:[],indices:[],offset:globalVertices};parts.push(currentPart);}
    else if(line.startsWith('v ')){assert.ok(currentPart);const values=line.slice(2).trim().split(/\s+/).map(Number);assert.equal(values.length,3);
      currentPart.positions.push(...values);globalVertices++;}
    else if(line.startsWith('f ')){assert.ok(currentPart);const values=line.slice(2).trim().split(/\s+/).map(Number);assert.equal(values.length,3);
      currentPart.indices.push(...values.map(value=>value-currentPart.offset-1));}
  }
  return parts;
}
function readStl(bytes) {
  const count=bytes.readUInt32LE(80);assert.equal(bytes.length,84+count*50);
  const positions=[],indices=[],vertices=new Map();
  for(let face=0;face<count;face++)for(let corner=0;corner<3;corner++) {
    const offset=84+face*50+12+corner*12,point=[0,4,8].map(axis=>bytes.readFloatLE(offset+axis));
    assert.ok(point.every(Number.isFinite));const key=point.join(',');
    let index=vertices.get(key);if(index===undefined){index=positions.length/3;vertices.set(key,index);positions.push(...point);}
    indices.push(index);
  }
  return{positions,indices};
}
async function history() {
  try {const bytes=await readFile(join(output,'timing.json'));const value=JSON.parse(bytes);
    assert.equal(value.schema,1);assert.ok(Array.isArray(value.samples));return{sha256:sha256(bytes),samples:value.samples};}
  catch(error){if(error.code==='ENOENT')return{sha256:null,samples:[]};throw error;}
}
async function summarizeCache(directory) {
  let files=0,bytes=0;
  const walk=async path=>{for(const entry of await readdir(path,{withFileTypes:true})) {
    assert.ok(!entry.isSymbolicLink());const target=join(path,entry.name);
    if(entry.isDirectory())await walk(target);else if(entry.isFile()){files++;bytes+=(await lstat(target)).size;}
  }};
  await walk(directory);return{files,bytes};
}
function onJob(job) {
  if(!current)return;
  const now=performance.now(),event={trial:current.index,observedMs:now-current.startedClock,id:job.id,state:job.state,
    phase:job.phase,progress:job.progress,message:job.message,timing:job.timing,acquisition:job.acquisition,error:job.error};
  current.id??=job.id;current.acceptedObservedAt??=now;
  if(job.timing) {
    const initial=estimateOf(job.timing);
    if(!current.initialEstimate)current.initialEstimate=structuredClone(initial);
    else if(JSON.stringify(initial)!==JSON.stringify(current.initialEstimate))current.initialEstimateImmutable=false;
  }
  if(!current.phases.some(value=>value.phase===job.phase)) {
    current.phases.push({phase:job.phase,atMs:now-current.acceptedObservedAt});
    console.log('GENYEN_TIMING_STAGE '+JSON.stringify({trial:current.index,cohort:current.cohort,phase:job.phase,message:job.message}));
  }
  if(!['running','cancelling'].includes(job.state))current.finishedObservedAt=now;
  logStream.write(JSON.stringify(event)+'\n');
}
async function waitFor(id) {
  const deadline=performance.now()+1050000;
  while(performance.now()<deadline) {
    const job=manager.get(id);if(!['running','cancelling'].includes(job.state))return job;
    await delay(50);
  }
  manager.cancel(id);throw new Error('Real manager task exceeded the external 1050-second harness guard');
}
async function awaitSample(beforeCount,job) {
  const deadline=performance.now()+5000;let after;
  do {
    after=await history();
    if(after.samples.length>beforeCount)return after;
    await delay(40);
  }while(performance.now()<deadline);
  return after;
}
async function verifyExports(core,job) {
  const {saveModelFile}=await import(new URL('../main/save-model.mjs',import.meta.url));
  const preview=await manager.preview(job.id),materials=core.validateMaterialParts(preview.mesh);
  assert.ok(materials);assert.equal(materials.outer.connectedComponents,1);
  assert.deepEqual(materials.parts.map(part=>part.id).sort(),['base','route','snow','terrain','text']);
  assert.ok(materials.parts.every(part=>part.volumeMm3>0&&part.boundaryEdges===0&&part.nonManifoldEdges===0));
  assert.ok(Math.abs(materials.volumeMm3-materials.outerVolumeMm3)<=materials.volumeToleranceMm3);
  const text=preview.report.integratedModel.baseText;assert.equal(text.text,OPTIONS.baseText);assert.equal(text.sizeMm,3);
  assert.equal(text.reliefHeightMm,.6);assert.ok(text.fontIdentity?.sha256);
  assert.ok(text.effectiveFrameWidthMm>=OPTIONS.frameWidthMm&&text.effectiveFrameWidthMm<=20);
  const counts={};for(const kind of preview.appearance.faceClasses)counts[kind]=(counts[kind]??0)+1;
  const saved=[],exportRoot=join(output,'exports');await mkdir(exportRoot);
  const frozenBefore=manager.get(job.id).timing;
  for(const format of ['stl','3mf','obj']) {
    const artifact=await manager.exportModel(job.id,format,OPTIONS);
    const target=join(exportRoot,'格聂_'+format+artifact.extension);
    const savedFile=await saveModelFile(artifact.bytes,target,{expectedSha256:sha256(artifact.bytes)});
    const bytes=await readFile(savedFile.path);assert.equal(sha256(bytes),savedFile.sha256);
    let readback;
    if(format==='stl') {
      assert.equal(savedFile.sha256,job.result.stlSha256);
      readback=core.assertPrintableMesh(readStl(bytes));assert.equal(readback.triangleCount,materials.outer.triangleCount);
      assert.equal(readback.connectedComponents,1);
      assert.ok(Math.abs(readback.volumeMm3-materials.outerVolumeMm3)<Math.max(.01,materials.outerVolumeMm3*1e-5));
    }else {
      const files=unzip(bytes),manifest=JSON.parse(files.get(format==='3mf'?'Metadata/manifest.json':'manifest.json'));
      assert.equal(manifest.unit,'mm');assert.equal(manifest.appearance.hash,artifact.appearanceHash);
      assert.deepEqual(manifest.metadata.imageSource,job.result.imageSource);
      const palette=manifest.appearance.palette;assert.ok(palette.length<=OPTIONS.maxColors);
      assert.equal(new Set(palette.map(value=>value.color)).size,palette.length);
      const parts=format==='3mf'?read3mf(files.get('3D/3dmodel.model').toString('utf8'),palette):readObj(files.get('model.obj').toString('utf8'));
      assert.deepEqual(parts.map(part=>part.id).sort(),materials.parts.map(part=>part.id).sort());
      const reports=parts.map(part=>({id:part.id,...core.assertPrintableMesh(part,{allowDisconnected:true})}));
      for(const part of reports) {
        const expected=materials.parts.find(value=>value.id===part.id),stored=manifest.materialParts.find(value=>value.id===part.id);
        assert.equal(part.vertexCount,expected.vertexCount);assert.equal(part.triangleCount,expected.triangleCount);
        assert.equal(stored.vertexCount,part.vertexCount);assert.equal(stored.triangleCount,part.triangleCount);
        assert.ok(Math.abs(part.volumeMm3-expected.volumeMm3)<=Math.max(1e-6,expected.volumeMm3*1e-6));
        const color=palette[stored.defaultMaterial]?.color;
        if(part.id==='base')assert.equal(color,OPTIONS.grassColor);
        if(part.id==='text'||part.id==='route')assert.equal(color,OPTIONS.routeColor);
      }
      assert.ok(Math.abs(reports.reduce((sum,part)=>sum+part.volumeMm3,0)-manifest.materialVolumeMm3)<=materials.volumeToleranceMm3);
      readback={unit:manifest.unit,parts:reports,palette,appearanceHash:manifest.appearance.hash,
        sourceIdentitySha256:sha256(JSON.stringify(manifest.metadata.imageSource))};
    }
    saved.push({format,...savedFile,readback});
  }
  await delay(1000);const frozenAfter=manager.get(job.id).timing;
  assert.equal(frozenAfter.totalDurationMs,frozenBefore.totalDurationMs);
  assert.equal(frozenAfter.elapsedMs,frozenBefore.totalDurationMs);
  assert.deepEqual(estimateOf(frozenAfter),estimateOf(frozenBefore));
  return{passed:true,materials,classes:counts,appearanceClassification:preview.appearance.classification,
    baseText:{text:text.text,sizeMm:text.sizeMm,reliefHeightMm:text.reliefHeightMm,fontIdentity:text.fontIdentity,
      requestedFrameWidthMm:text.requestedFrameWidthMm,effectiveFrameWidthMm:text.effectiveFrameWidthMm,
      areaMm2:text.areaMm2,volumeMm3:text.volumeMm3,finalSizeMm:text.finalSizeMm,
      contoursSha256:sha256(JSON.stringify(text.contours)),ringCount:text.contours.reduce((n,c)=>n+1+c.holes.length,0)},
    frozenAcrossLaterExports:true,formats:saved};
}
function accuracy(runs) {
  const summarize=group=>({count:group.length,passed10Percent:group.filter(run=>run.relativeError<=.1).length,
    passRate:group.length?group.filter(run=>run.relativeError<=.1).length/group.length:null,
    calibratedCount:group.filter(run=>run.initialEstimate.confidence==='calibrated').length,
    errors:group.map(run=>({index:run.index,relativeError:run.relativeError,confidence:run.initialEstimate.confidence}))});
  const successful=runs.filter(run=>run.state==='succeeded');
  return{targetRelativeError:.1,cold:summarize(successful.filter(run=>run.cohort==='cold-network')),
    warm:summarize(successful.filter(run=>run.cohort==='warm-cache')),
    calibratedWarm:summarize(successful.filter(run=>run.cohort==='warm-cache'&&run.initialEstimate.confidence==='calibrated')),
    local:{executed:false},all:summarize(successful)};
}
async function main() {
  mkdirSync(runRoot,{recursive:true});
  assert.equal(resolve(realpathSync(runRoot)),runRoot,'Run root must be canonical: production caches reject ancestor junction aliases');
  if(values['resume-run']) {
    output=join(runRoot,values['resume-run']);
    assert.ok(lstatSync(output).isDirectory()&&!lstatSync(output).isSymbolicLink());
    assert.equal(resolve(realpathSync(output)),output);
    const previous=JSON.parse(readFileSync(join(output,'report.json'),'utf8'));
    assert.equal(previous.purpose,report.purpose);assert.equal(previous.schema,1);
    assert.equal(previous.route.sha256,ROUTE_SHA256);assert.deepEqual(previous.options,OPTIONS);
    assert.equal(previous.cacheInitially.dem.files,0);assert.equal(previous.cacheInitially.image.files,0);
    assert.equal(previous.runs[0].state,'succeeded');assert.equal(previous.runs[0].cohort,'cold-network');
    assert.equal(previous.runs[0].cache.dem,false);assert.equal(previous.runs[0].cache.image,false);
    assert.ok(previous.runs.every(run=>run.state==='succeeded'));
    Object.assign(report,previous);
    report.previousHarnessErrors=[...(previous.previousHarnessErrors??[]),...(previous.error?[previous.error]:[])];
    report.resumedAt=new Date().toISOString();report.passed=false;delete report.error;delete report.finishedAt;
    report.harnessCorrections=[...(previous.harnessCorrections??[]),'Read base-text metadata from integratedModel; preserve cold sample and resume warm trials without pretending a second cold run.'];
  }else {
    output=join(runRoot,'r'+Date.now().toString(36)+randomBytes(2).toString('hex'));mkdirSync(output);
  }
  const paths={profile:join(output,'p'),tasks:join(output,'t'),demCache:join(output,'d'),imageCache:join(output,'i'),
    timingHistory:join(output,'timing.json')};
  for(const path of [paths.profile,paths.tasks,paths.demCache,paths.imageCache]){if(values['resume-run']){assert.ok(lstatSync(path).isDirectory()&&!lstatSync(path).isSymbolicLink());assert.equal(resolve(realpathSync(path)),path);}else mkdirSync(path);}
  report.output=output;report.paths=paths;report.runtime={electron:process.versions.electron,node:process.versions.node};
  if(app){app.setPath('userData',paths.profile);app.disableHardwareAcceleration();await app.whenReady();}
  const core=await import(pathToFileURL(join(repo,'dist/src/index.js')).href);
  const routePath='C:/Users/ander/Desktop/20261012_115743.kml',routeBytes=await readFile(routePath);
  assert.equal(sha256(routeBytes),ROUTE_SHA256);
  const route=core.parseRouteXml(routeBytes.toString('utf8'),{fileName:basename(routePath)});
  const points=route.segments.flatMap(segment=>segment.points);assert.equal(points.length,2586);
  const frame=core.createTerrainFrame(points,OPTIONS);
  for(const key of Object.keys(BOUNDS))assert.ok(Math.abs(frame.bounds[key]-BOUNDS[key])<1e-10,'Accepted full Genyen view: '+key);
  report.route={path:routePath,sha256:ROUTE_SHA256,pointCount:points.length,name:route.name??'格聂牧场'};
  report.computedBounds=frame.bounds;report.pinnedAcquisitionHarnessBounds=BOUNDS;
  report.concurrencyNote='Root authorized a separate fault-injection network acquisition concurrently with the first cold job; root will avoid full test suites during warm timing trials.';
  report.boundsDelta=Object.fromEntries(Object.keys(BOUNDS).map(key=>[key,frame.bounds[key]-BOUNDS[key]]));
  if(!values['resume-run'])report.cacheInitially={dem:await summarizeCache(paths.demCache),image:await summarizeCache(paths.imageCache)};
  assert.equal(report.cacheInitially.dem.files,0);assert.equal(report.cacheInitially.image.files,0);
  if(!values['resume-run'])assert.equal((await history()).samples.length,0);
  const {prepareBaseText}=await import(new URL('../main/base-text-font.mjs',import.meta.url));
  const prepared=await prepareBaseText(OPTIONS.baseText,OPTIONS.baseTextSizeMm);
  report.preflightFont={fontIdentity:prepared.fontIdentity,contours:prepared.contours.length};
  if(values.mode==='preflight') {report.passed=true;return;}
  assert.ok(app&&utilityProcess,'Live tasks require Electron utility processes');
  const {createDesktopManager}=await import(new URL('../main/manager.mjs',import.meta.url));
  logStream=createWriteStream(join(output,'events.ndjson'),{flags:values['resume-run']?'a':'wx'});
  manager=createDesktopManager({taskRoot:paths.tasks,coreModuleUrl:pathToFileURL(join(repo,'dist/src/index.js')).href,
    demCacheDir:paths.demCache,imageCacheDir:paths.imageCache,timingHistoryPath:paths.timingHistory,
    softwareVersion:report.softwareVersion,onJob,
    workerFactory:({workerPath,taskDir})=>{
      const child=utilityProcess.fork(workerPath,[],{cwd:taskDir,stdio:'pipe',serviceName:'Genyen real timing verification'});
      child.stdout?.on('data',bytes=>logStream.write(JSON.stringify({type:'worker-stdout',trial:current?.index,text:bytes.toString().slice(0,2000)})+'\n'));
      child.stderr?.on('data',bytes=>logStream.write(JSON.stringify({type:'worker-stderr',trial:current?.index,text:bytes.toString().slice(0,2000)})+'\n'));
      return child;
    }});
  const importedRoute=await manager.addRoute(routePath);assert.equal(importedRoute.pointCount,2586);
  report.liveGenerationExecuted=true;
  heartbeat=setInterval(()=>{
    if(current?.id)try {
      const job=manager.get(current.id);
      if(['running','cancelling'].includes(job.state))console.log('GENYEN_TIMING_HEARTBEAT '+JSON.stringify({trial:current.index,cohort:current.cohort,
        phase:job.phase,elapsedMs:job.timing?.elapsedMs,message:job.message}));
    }catch{}
  },10000);heartbeat.unref?.();
  let firstResult=report.runs[0]?.result;
  const firstIndex=report.runs.length,lastIndex=Math.max(warmRuns,(!report.modelVerification&&firstIndex>warmRuns)?firstIndex:warmRuns);
  for(let index=firstIndex;index<=lastIndex;index++) {
    const before=await history();
    current={index,cohort:index===0?'cold-network':'warm-cache',startedClock:performance.now(),initialEstimateImmutable:true,phases:[],
      historyBefore:{sha256:before.sha256,samples:before.samples.length}};
    const task=await manager.start({routeId:importedRoute.id,demMode:'auto',imageMode:'auto',imageLookbackMonths:24,options:OPTIONS});
    current.id=task.id;
    const job=await waitFor(task.id),timing=job.timing;
    assert.ok(current.initialEstimate,'Capture the original estimate before job completion');
    assert.equal(current.initialEstimateImmutable,true);assert.deepEqual(estimateOf(timing),current.initialEstimate);
    const actual=timing?.totalDurationMs;assert.ok(Number.isFinite(actual)&&actual>0);
    const run={index,cohort:current.cohort,id:job.id,state:job.state,createdAt:job.createdAt,finishedAt:timing.finishedAt,
      initialEstimate:current.initialEstimate,actualTotalMs:actual,relativeError:Math.abs(current.initialEstimate.estimatedTotalMs-actual)/actual,
      initialEstimateImmutable:true,observedAcceptedToFinishedMs:current.finishedObservedAt-current.acceptedObservedAt,
      phaseObservations:current.phases,acquisition:job.acquisition,historyBefore:current.historyBefore,error:job.error};
    report.runs.push(run);
    if(job.state!=='succeeded')throw Object.assign(new Error(job.error?.message??'Real manager generation failed'),{code:job.error?.code});
    run.result=job.result;run.cache={dem:job.result.demSource?.cacheHit,image:job.result.imageSource?.cacheHit};
    assert.equal(run.cache.dem,index>0,'Cold then warm DEM identity');assert.equal(run.cache.image,index>0,'Cold then warm imagery identity');
    if(index===0)assert.equal(current.initialEstimate.confidence,'uncalibrated','First network prediction is honestly uncalibrated');
    else {
      assert.equal(job.acquisition?.dem?.downloadedBytes??0,0);assert.equal(job.acquisition?.image?.downloadedBytes??0,0);
      assert.equal(job.result.stlSha256,firstResult.stlSha256);assert.equal(job.result.appearanceHash,firstResult.appearanceHash);
      assert.deepEqual(job.result.imageSource.scenes,firstResult.imageSource.scenes);
      assert.deepEqual(job.result.imageSource.bounds,firstResult.imageSource.bounds);
    }
    const after=await awaitSample(before.samples.length,job),sample=after.samples.find(value=>value.finishedAt===timing.finishedAt);
    run.historyAfter={sha256:after.sha256,samples:after.samples.length,recorded:Boolean(sample)};
    if(sample) {
      assert.equal(after.samples.length,before.samples.length+1);
      assert.equal(sample.initialEstimateMs,current.initialEstimate.estimatedTotalMs);assert.equal(sample.totalDurationMs,actual);
      assert.ok(Math.abs(sample.relativeError-run.relativeError)<1e-12);run.phaseDurationsMs=sample.phaseDurationsMs;run.historyKey=sample.key;
      run.previousMatchingSamples=before.samples.filter(value=>value.key===sample.key).length;
      if(current.initialEstimate.confidence==='calibrated') {
        const cohort=before.samples.filter(value=>value.key===sample.key).slice(-12);
        assert.ok(cohort.length>=5&&cohort.slice(-3).every(value=>value.relativeError<=.1),'Calibration uses only previous successes');
      }
    }else run.historyWarning='Production history did not append this success within 5 seconds; this run cannot teach later predictions.';
    const frozen=manager.get(task.id).timing;await delay(200);
    assert.equal(manager.get(task.id).timing.totalDurationMs,frozen.totalDurationMs);run.totalFrozen=true;
    if(index===0)firstResult=structuredClone(job.result);
    if(!report.modelVerification) {
      report.modelVerification=await verifyExports(core,job);report.exportedTrialIndex=index;
      report.cacheAfterCold={dem:await summarizeCache(paths.demCache),image:await summarizeCache(paths.imageCache)};
    }
    console.log('GENYEN_TIMING_TRIAL '+JSON.stringify({index,cohort:run.cohort,initialEstimate:run.initialEstimate,actualTotalMs:actual,
      relativeError:run.relativeError,historyBefore:run.historyBefore.samples,historyAfter:run.historyAfter.samples,cache:run.cache}));
    await writeFile(join(output,'report.json'),JSON.stringify({...report,accuracy:accuracy(report.runs)},null,2)+'\n');
    current=undefined;
  }
  report.accuracy=accuracy(report.runs);
  report.timingTargetPassed=report.accuracy.all.count>=warmRuns+1&&report.accuracy.all.passed10Percent===report.accuracy.all.count;
  report.warmTimingTargetPassed=report.accuracy.warm.passed10Percent===report.accuracy.warm.count;
  report.calibratedWarmTimingTargetPassed=report.accuracy.calibratedWarm.count>0
    &&report.accuracy.calibratedWarm.passed10Percent===report.accuracy.calibratedWarm.count;
  report.passed=true;
}
async function finish(error) {
  if(error){report.passed=false;report.error={name:error.name,code:error.code,message:error.message,stack:error.stack};}
  clearInterval(heartbeat);
  try{await manager?.close();}catch(issue){report.cleanupError=String(issue);}
  if(logStream)await new Promise(done=>{logStream.once('error',done);logStream.end(done);});
  report.finishedAt=new Date().toISOString();
  report.accuracy??=accuracy(report.runs);
  if(output)await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('GENYEN_TIMING_REPORT '+JSON.stringify({passed:report.passed,output,liveGenerationExecuted:report.liveGenerationExecuted,
    timingTargetPassed:report.timingTargetPassed,warmTimingTargetPassed:report.warmTimingTargetPassed,
    calibratedWarmTimingTargetPassed:report.calibratedWarmTimingTargetPassed,accuracy:report.accuracy,error:report.error}));
  if(app)app.exit(report.passed?0:1);else process.exitCode=report.passed?0:1;
}
async function launchElectron() {
  const electron=require('electron'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),...process.argv.slice(2)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  child.stdout.on('data',bytes=>process.stdout.write(bytes));child.stderr.on('data',bytes=>process.stderr.write(bytes));
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',value=>done(value??1));});process.exitCode=code;
}
if(values.help)console.log('verify-genyen-timing.mjs --mode=preflight|run [--warm-runs=7] [--resume-run=r...] [--run-root=SHORT_CANONICAL_PATH/artifacts/gt]');
else if(values.mode==='run'&&!process.versions.electron)void launchElectron().catch(error=>{console.error(error);process.exitCode=1;});
else {
  if(process.versions.electron){const electron=require('electron');app=electron.app;utilityProcess=electron.utilityProcess;}
  // App readiness and all work are inside this async function; no top-level await can deadlock Electron startup.
  void main().then(()=>finish()).catch(error=>finish(error)).catch(error=>{console.error(error);if(app)app.exit(1);else process.exitCode=1;});
}



