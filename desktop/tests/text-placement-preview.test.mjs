import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDesktopManager} from '../main/manager.mjs';
import {createSessionStore} from '../main/session.mjs';
import {prepareBaseText} from '../main/base-text-font.mjs';
const root=resolve(import.meta.dirname,'../..'),parent=join(root,'artifacts','text-placement-tests');
const coreModuleUrl=pathToFileURL(join(root,'dist/src/index.js')).href;
async function fixture(t){
  await mkdir(parent,{recursive:true});const temp=await mkdtemp(join(parent,'case-'));
  const path=join(temp,'route.gpx');await writeFile(path,'<gpx><trk><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>');
  let workers=0;const manager=createDesktopManager({taskRoot:join(temp,'tasks'),coreModuleUrl,workerFactory:()=>{workers++;throw Error('No generation in map preview');}});
  const store=createSessionStore({userDataDirectory:join(temp,'profile'),manager});
  t.after(async()=>{await store.close();await manager.close();const rel=relative(parent,temp);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(temp,{recursive:true,force:true});});
  const route=await manager.addRoute(path);return{manager,store,route,workers:()=>workers};
}
test('inspection previews actual local glyphs at circle positions without generating',async t=>{
  const f=await fixture(t),options={shape:'circle',baseText:'山行08',baseTextSizeMm:3,textEnabled:true,baseTextAngleDeg:90};
  const inspection=await f.manager.inspect({routeId:f.route.id,options});
  const preview=inspection.baseTextPreview;assert.ok(preview?.contoursMm?.length);assert.ok(preview.anchorMm.x>60);assert.ok(Math.abs(preview.anchorMm.y)<1e-3);assert.equal(preview.rotationDeg,90);
  const core=await import(coreModuleUrl),font=await prepareBaseText(options.baseText,3);
  const layout=core.prepareTextLayout({...options,widthMm:120,heightMm:80,polygonSides:6,...{baseTextContours:font.contours,baseTextFontIdentity:font.fontIdentity}},inspection.outlineMm.map(p=>({X:p.x*100000,Y:p.y*100000})),3);
  assert.deepEqual(preview.contoursMm,layout.report.contours);assert.equal(preview.effectiveFrameWidthMm,layout.effectiveFrameWidthMm);
  assert.equal(preview.contoursGeo.length,preview.contoursMm.length);assert.ok(preview.outlineGeo.length>0);assert.equal(f.workers(),0);
});
test('preview errors leave route/selection intact; disabled and blank text do not need fonts',async t=>{
  const f=await fixture(t);
  const unsupported=await f.manager.inspect({routeId:f.route.id,options:{textEnabled:true,baseText:'😀'}});
  assert.ok(unsupported.outlineGeo.length>0);assert.match(unsupported.baseTextPreview?.error??'',/字形|字体/);
  for(const options of [{textEnabled:false,baseText:'😀'},{textEnabled:true,baseText:'   '}])assert.equal((await f.manager.inspect({routeId:f.route.id,options})).baseTextPreview,undefined);
  assert.equal(f.workers(),0);
});
test('polygon edge selection has numbered centers and persists with circle angle',async t=>{
  const f=await fixture(t),options={shape:'polygon',polygonSides:5,textEnabled:true,baseText:'山行08',baseTextEdgeIndex:4,baseTextAngleDeg:37.5};
  const request={routeId:f.route.id,demMode:'auto',imageMode:'none',offlineOnly:false,options};
  const preview=(await f.manager.inspect(request)).baseTextPreview;
  assert.equal(preview?.edgeCentersMm.length,5);assert.equal(preview?.edgeCentersGeo.length,5);
  await f.store.saveSession(request);const restored=await f.store.restoreSession();
  assert.equal(restored.options.baseTextEdgeIndex,4);assert.equal(restored.options.baseTextAngleDeg,37.5);assert.equal(f.workers(),0);
});
test('circle preview uses the printable adaptive footprint at non-cardinal angles',async t=>{
  const f=await fixture(t),core=await import(coreModuleUrl),prepared=await prepareBaseText('山行08',3);
  for(const [gridColumns,baseTextAngleDeg] of [[65,2.25],[129,37],[257,211]]){
    const options={shape:'circle',widthMm:120,gridColumns,baseText:'山行08',baseTextSizeMm:3,textEnabled:true,routeEnabled:false,baseTextAngleDeg};
    const inspection=await f.manager.inspect({routeId:f.route.id,options});
    const generated=await core.generatePrintableTerrain({gpxXml:'<gpx><trk><trkseg><trkpt lat="30.56" lon="104.28"/><trkpt lat="30.57" lon="104.30"/></trkseg></trk></gpx>',options:{...options,baseTextContours:prepared.contours,baseTextFontIdentity:prepared.fontIdentity},loadDem:async()=>({sample:()=>100,metadata:{}})});
    const before=inspection.baseTextPreview,after=generated.report.integratedModel.baseText;
    assert.ok(Math.hypot(before.anchorMm.x-after.anchorMm.x,before.anchorMm.y-after.anchorMm.y)<.001,'map label must match actual printable anchor');
    assert.ok(Math.abs(before.effectiveFrameWidthMm-after.effectiveFrameWidthMm)<.001,'map must reserve the actual final ledge');
    assert.ok(Math.abs(before.outlineMm.reduce((value,p)=>Math.max(value,p.x),-Infinity)-generated.report.validation.bounds.max.x)<.001);
  }
  assert.equal(f.workers(),0);
});
