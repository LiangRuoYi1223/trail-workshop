import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {saveModelFile} from './save-model.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function unzip(bytes){const files=new Map();let o=0;while(bytes.readUInt32LE(o)===0x04034b50){const method=bytes.readUInt16LE(o+8),length=bytes.readUInt32LE(o+18),n=bytes.readUInt16LE(o+26),e=bytes.readUInt16LE(o+28),name=bytes.toString('utf8',o+30,o+30+n),start=o+30+n+e,payload=bytes.subarray(start,start+length);files.set(name,method===8?inflateRawSync(payload):payload);o=start+length;}return files;}
export async function checkRuntime({app,manager,routePath,demPath,destination}){
 const output=resolve(destination);await mkdir(output,{recursive:true});
 const report={passed:false,runtime:{packaged:app.isPackaged,version:app.getVersion(),platform:process.platform,applicationRoot:app.getAppPath()},trials:[],formats:[]};
 try{
  assert.equal(app.isPackaged,true);
  const core=await import(pathToFileURL(join(app.getAppPath(),'core/index.js')).href);
  const route=await manager.addRoute(resolve(routePath)),dem=await manager.addDem(resolve(demPath));
  const colors={maxColors:6,grassColor:'#799278',rockColor:'#a9aa92',routeColor:'#cc4422',baseColorSource:'custom',baseColor:'#112233',textColorSource:'custom',textColor:'#ffcc00'};
  const options={...colors,gridColumns:65,baseText:'格聂牧场 · 日回08',baseTextSizeMm:3,widthMm:120,heightMm:80};
  let final;
  for(let trial=0;trial<7;trial++){
   const initial=await manager.start({routeId:route.id,demId:dem.id,demMode:'local',imageMode:'none',options});
   const end=Date.now()+120000;
   while(['running','cancelling'].includes(manager.get(initial.id).state)){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,20));}
   const job=manager.get(initial.id);assert.equal(job.state,'succeeded',JSON.stringify(job.error));
   assert.equal(job.timing.estimatedTotalMs,initial.timing.estimatedTotalMs);assert.ok(job.timing.totalDurationMs>0);
   const errorFraction=Math.abs(initial.timing.estimatedTotalMs-job.timing.totalDurationMs)/job.timing.totalDurationMs;
   report.trials.push({cacheClass:'local',initial:initial.timing,actual:job.timing,errorFraction,within10Percent:errorFraction<=.1});final=job;
  }
  const preview=await manager.preview(final.id),materials=core.validateMaterialParts(preview.mesh);
  assert.ok(materials.parts.some(p=>p.id==='base'));assert.ok(materials.parts.some(p=>p.id==='text'));
  assert.equal(materials.outer.connectedComponents,1);assert.ok(Math.abs(materials.volumeMm3-materials.outerVolumeMm3)<=materials.volumeToleranceMm3);
  assert.equal(preview.report.integratedModel.baseText.text,options.baseText);assert.match(preview.report.integratedModel.baseText.fontIdentity.sha256,/^[a-f0-9]{64}$/);
  report.materials=materials;report.text=preview.report.integratedModel.baseText;
  for(const format of ['3mf','obj','stl']){
   const selected={...colors,baseColor:'#445577',textColor:'#eeeeee'};
   const artifact=await manager.exportModel(final.id,format,selected),saved=await saveModelFile(artifact.bytes,join(output,'凸字模型'+artifact.extension));
   assert.equal(sha(await readFile(saved.path)),saved.sha256);
   if(format==='stl')assert.equal(saved.sha256,final.result.stlSha256);else{
    const files=unzip(artifact.bytes),manifest=JSON.parse(files.get(format==='3mf'?'Metadata/manifest.json':'manifest.json').toString('utf8'));
    assert.deepEqual(manifest.materialParts.map(p=>p.id).sort(),materials.parts.map(p=>p.id).sort());
    assert.ok(manifest.appearance.palette.some(p=>p.color==='#445577'));assert.ok(manifest.appearance.palette.some(p=>p.color==='#eeeeee'));
    if(format==='3mf'){
     const xml=files.get('3D/3dmodel.model').toString('utf8');assert.match(xml,/<components>/);
     assert.equal((xml.match(/<mesh>/g)??[]).length,materials.parts.length);
     const objects=[...xml.matchAll(/<object[^>]*name="([^"]+)"[^>]*><mesh><vertices>(.*?)<\/vertices><triangles>(.*?)<\/triangles><\/mesh><\/object>/gs)];
     assert.equal(objects.length,preview.mesh.materialParts.length);
     for(const object of objects){const part=preview.mesh.materialParts.find(p=>p.id===object[1]),vertices=[...object[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)],faces=[...object[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)];
      assert.equal(vertices.length,part.positions.length/3);assert.equal(faces.length,part.indices.length/3);
      vertices.forEach((v,i)=>{for(let axis=0;axis<3;axis++)assert.equal(Number(v[axis+1]),part.positions[i*3+axis]);});
      faces.forEach((f,i)=>{for(let axis=0;axis<3;axis++)assert.equal(Number(f[axis+1]),part.indices[i*3+axis]);});
     }
    }else assert.deepEqual((files.get('model.obj').toString('utf8').match(/^o .+$/gm)??[]).sort(),materials.parts.map(p=>'o '+p.id).sort());
   }
   report.formats.push({format,...saved});
  }
  const fixed=manager.get(final.id).timing.totalDurationMs;await new Promise(r=>setTimeout(r,50));assert.equal(manager.get(final.id).timing.totalDurationMs,fixed);
  report.job=final;report.saved=report.formats.find(f=>f.format==='stl');report.passed=true;
  await writeFile(join(output,'runtime-check.json'),JSON.stringify(report,null,2));return report;
 }catch(error){report.error=error.stack??String(error);await writeFile(join(output,'runtime-check.json'),JSON.stringify(report,null,2));throw error;}
}
