import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {saveModelFile} from './save-model.mjs';
import {validateColorArtifact} from './runtime-check.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function checkRuntime({app,manager,routePath,demPath,destination}){
  const output=resolve(destination);await mkdir(output,{recursive:true});
  const report={passed:false,runtime:{packaged:app.isPackaged,version:app.getVersion(),applicationRoot:app.getAppPath()},cases:[]};
  try{
    assert.equal(app.isPackaged,true);assert.equal(app.getVersion(),'0.4.10');
    const core=await import(pathToFileURL(join(app.getAppPath(),'core/index.js')).href);
    const route=await manager.addRoute(resolve(routePath)),dem=await manager.addDem(resolve(demPath));
    const common={gridColumns:65,widthMm:120,heightMm:80,routeEnabled:true,textEnabled:true,baseText:'山行08',baseTextSizeMm:3,
      maxColors:6,grassColor:'#799278',rockColor:'#a9aa92',routeColor:'#cc5533',baseColorSource:'custom',baseColor:'#224466',textColorSource:'custom',textColor:'#ffbb00'};
    const cases=[
      {name:'圆形上方',shape:'circle',baseTextAngleDeg:0},
      {name:'圆形右侧',shape:'circle',baseTextAngleDeg:90},
      {name:'圆形左侧',shape:'circle',baseTextAngleDeg:270},
      {name:'五边形第5边',shape:'polygon',polygonSides:5,baseTextEdgeIndex:4,cornerRadiusMm:3},
    ];
    for(const item of cases){
      const {name,...placement}=item,options={...common,...placement};
      const inspection=await manager.inspect({routeId:route.id,options});assert.ok(inspection.baseTextPreview?.contoursMm.length);
      const task=await manager.start({routeId:route.id,demId:dem.id,demMode:'local',imageMode:'none',options});
      const limit=Date.now()+120000;
      while(['running','cancelling'].includes(manager.get(task.id).state)){assert.ok(Date.now()<limit,'generation timed out');await new Promise(done=>setTimeout(done,25));}
      const job=manager.get(task.id);assert.equal(job.state,'succeeded',JSON.stringify(job.error));
      const preview=await manager.preview(job.id),text=preview.report.integratedModel.baseText,material=core.validateMaterialParts(preview.mesh);
      assert.equal(material.outer.connectedComponents,1);assert.ok(material.parts.some(part=>part.id==='text'));
      assert.equal(text.text,common.baseText);assert.ok(text.contours.some(contour=>contour.holes.length>0));
      assert.equal(text.baseTextAngleDeg,placement.baseTextAngleDeg??180);assert.equal(text.baseTextEdgeIndex,placement.baseTextEdgeIndex??0);
      assert.ok(Math.hypot(text.anchorMm.x-inspection.baseTextPreview.anchorMm.x,text.anchorMm.y-inspection.baseTextPreview.anchorMm.y)<.03,'map and printable text anchor must agree');
      assert.ok(Math.abs(text.effectiveFrameWidthMm-inspection.baseTextPreview.effectiveFrameWidthMm)<.03);
      assert.equal(text.rotationDeg,inspection.baseTextPreview.rotationDeg);
      if(placement.shape==='circle'){
        if(placement.baseTextAngleDeg===0)assert.ok(text.anchorMm.y>60&&Math.abs(text.anchorMm.x)<.001);
        if(placement.baseTextAngleDeg===90)assert.ok(text.anchorMm.x>60&&Math.abs(text.anchorMm.y)<.001);
        if(placement.baseTextAngleDeg===270)assert.ok(text.anchorMm.x<-60&&Math.abs(text.anchorMm.y)<.001);
      }else{
        const center=text.edgeCentersMm[placement.baseTextEdgeIndex],len=Math.hypot(center.x,center.y);
        assert.ok(Math.abs(text.anchorMm.x*center.y/len-text.anchorMm.y*center.x/len)<.001,'glyph center lies on edge midpoint normal');
      }
      const formats=[];
      for(const format of ['3mf','obj','stl']){
        const artifact=await manager.exportModel(job.id,format,common),saved=await saveModelFile(artifact.bytes,join(output,name+artifact.extension));
        const bytes=await readFile(saved.path);assert.equal(sha(bytes),saved.sha256);
        if(format==='stl')assert.equal(saved.sha256,job.result.stlSha256);
        else{
          const recolored=core.recolorModelAppearance(preview.appearance,common),prepared=core.prepareMaterialParts(preview.mesh,recolored);
          const readback=validateColorArtifact(bytes,format,preview,recolored,core);
          assert.ok(prepared.palette.some(color=>color.color===common.textColor));assert.ok(prepared.palette.some(color=>color.color===common.baseColor));
          assert.ok(readback.roles.includes('text'));assert.equal(readback.actualGeometryReadback,true);
        }
        formats.push({format,...saved});
      }
      report.cases.push({name,options,text,material,job,formats});
    }
    report.passed=true;await writeFile(join(output,'runtime-check.json'),JSON.stringify(report,null,2));return report;
  }catch(error){report.error=error.stack??String(error);await writeFile(join(output,'runtime-check.json'),JSON.stringify(report,null,2));throw error;}
}
