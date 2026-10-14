import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {saveModelFile} from './save-model.mjs';
import {validateColorArtifact} from './runtime-check.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function unzip(bytes){const files=new Map();let i=0;while(bytes.readUInt32LE(i)===0x04034b50){const method=bytes.readUInt16LE(i+8),size=bytes.readUInt32LE(i+18),n=bytes.readUInt16LE(i+26),e=bytes.readUInt16LE(i+28),name=bytes.toString('utf8',i+30,i+30+n),start=i+30+n+e;const b=bytes.subarray(start,start+size);files.set(name,method===8?inflateRawSync(b):b);i=start+size;}return files;}
function stlMesh(bytes){const count=bytes.readUInt32LE(80),positions=[],indices=[],map=new Map();assert.equal(bytes.length,84+count*50);for(let f=0;f<count;f++)for(let c=0;c<3;c++){const p=[0,4,8].map(a=>bytes.readFloatLE(84+f*50+12+c*12+a)),key=p.join(',');let id=map.get(key);if(id===undefined){id=positions.length/3;positions.push(...p);map.set(key,id);}indices.push(id);}return{positions,indices};}
export async function checkRuntime({app,manager,routePath,demPath,destination}){
 const output=resolve(destination);await mkdir(output,{recursive:true});
 const report={passed:false,runtime:{packaged:app.isPackaged,version:app.getVersion(),applicationRoot:app.getAppPath()},cases:[]};
 try{
  assert.equal(app.isPackaged,true);assert.equal(app.getVersion(),'0.4.9');
  const core=await import(pathToFileURL(join(app.getAppPath(),'core/index.js')).href);
  const route=await manager.addRoute(resolve(routePath)),dem=await manager.addDem(resolve(demPath));
  const common={maxColors:6,gridColumns:33,widthMm:120,heightMm:80,snowEnabled:true,snowCoveragePercent:30,snowMaxThicknessMm:1,frameWidthMm:3,
   grassColor:'#799278',rockColor:'#a9aa92',routeColor:'#cc5533',baseColorSource:'custom',baseColor:'#112233',textColorSource:'custom',textColor:'#ffbb00',baseTextSizeMm:3};
  const cases=[
   {name:'关闭路线文字_单色积雪',options:{...common,grassEnabled:false,rockEnabled:true,rockColor:'#ffffff',baseColorSource:'grass',routeEnabled:false,textEnabled:false,baseText:'😀'},roles:['base','snow','terrain'],colors:1},
   {name:'全部开启',options:{...common,grassEnabled:true,rockEnabled:true,routeEnabled:true,textEnabled:true,baseText:'格聂 · 日回08'},roles:['base','route','snow','terrain','text']},
   {name:'关闭文字',options:{...common,grassEnabled:true,rockEnabled:false,routeEnabled:true,textEnabled:false,baseText:'😀'},roles:['base','route','snow','terrain']},
   {name:'关闭路线',options:{...common,grassEnabled:false,rockEnabled:true,routeEnabled:false,textEnabled:true,baseText:'格聂牧场'},roles:['base','snow','terrain','text']},
  ];
  for(const c of cases){
   const initial=await manager.start({routeId:route.id,demId:dem.id,demMode:'local',imageMode:'none',options:c.options});
   const limit=Date.now()+120000;while(['running','cancelling'].includes(manager.get(initial.id).state)){assert.ok(Date.now()<limit);await new Promise(r=>setTimeout(r,20));}
   const job=manager.get(initial.id);assert.equal(job.state,'succeeded',JSON.stringify(job.error));
   const preview=await manager.preview(job.id),materials=core.validateMaterialParts(preview.mesh);
   assert.deepEqual(materials.parts.map(p=>p.id).sort(),c.roles);assert.equal(materials.outer.connectedComponents,1);
   assert.ok(Math.abs(materials.volumeMm3-materials.outerVolumeMm3)<=materials.volumeToleranceMm3);
   assert.equal(preview.report.config.routeEnabled,c.options.routeEnabled);assert.equal(preview.report.config.textEnabled,c.options.textEnabled);
   if(!c.options.textEnabled){assert.equal(preview.report.integratedModel.baseText.text,'');assert.equal(preview.report.config.baseText,c.options.baseText);assert.equal(preview.report.integratedModel.baseText.effectiveFrameWidthMm,3);}
   if(!c.options.routeEnabled)assert.ok(!preview.mesh.faceKinds.some(k=>k==='route'||k==='route-wall'));
   const formats=[];
   for(const format of ['3mf','obj','stl']){
    const artifact=await manager.exportModel(job.id,format,c.options),saved=await saveModelFile(artifact.bytes,join(output,c.name+artifact.extension));
    const bytes=await readFile(saved.path);assert.equal(sha(bytes),saved.sha256);
    if(format==='stl'){assert.equal(saved.sha256,job.result.stlSha256);const outer=core.assertPrintableMesh(stlMesh(bytes));assert.equal(outer.connectedComponents,1);}
    else{
     const readback=validateColorArtifact(bytes,format,preview,core.recolorModelAppearance(preview.appearance,c.options),core);
     const files=unzip(bytes),manifest=JSON.parse(files.get(format==='3mf'?'Metadata/manifest.json':'manifest.json').toString('utf8'));
     assert.deepEqual(manifest.materialParts.map(p=>p.id).sort(),c.roles);assert.ok(manifest.appearance.palette.some(p=>p.color==='#ffffff'));
     if(c.colors)assert.equal(manifest.appearance.palette.length,c.colors);
     if(format==='3mf'){const xml=files.get('3D/3dmodel.model').toString('utf8');assert.equal((xml.match(/<mesh>/g)??[]).length,c.roles.length);assert.match(xml,/<components>/);}
     else assert.deepEqual((files.get('model.obj').toString('utf8').match(/^o .+$/gm)??[]).sort(),c.roles.map(id=>'o '+id));
     formats.push({format,...saved,colors:manifest.appearance.palette.length,roles:manifest.materialParts.map(p=>p.id),readback});continue;
    }
    formats.push({format,...saved});
   }
   if(c.options.routeEnabled&&c.options.textEnabled){
    const recolored=await manager.exportModel(job.id,'3mf',{...c.options,grassEnabled:false,rockEnabled:true,rockColor:'#335577'});
    const manifest=JSON.parse(unzip(recolored.bytes).get('Metadata/manifest.json').toString('utf8'));
    assert.ok(!manifest.appearance.palette.some(p=>p.color===c.options.grassColor));
    assert.equal(sha((await manager.exportModel(job.id,'stl',{...c.options,grassEnabled:false,rockEnabled:true,rockColor:'#335577'})).bytes),job.result.stlSha256);
   }
   const frozen=job.timing.totalDurationMs;assert.ok(frozen>0);assert.equal(manager.get(job.id).timing.totalDurationMs,frozen);
   report.cases.push({name:c.name,options:c.options,job,materials,formats});
  }
  report.passed=true;await writeFile(join(output,'runtime-check.json'),JSON.stringify(report,null,2));return report;
 }catch(error){report.error=error.stack??String(error);await writeFile(join(output,'runtime-check.json'),JSON.stringify(report,null,2));throw error;}
}
