import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inflateRawSync} from 'node:zlib';
import {SaxesParser} from 'saxes';
import {buildHeightfieldTerrainMesh} from '../src/vendor/trailprint/heightfield-mesh.js';
import {writeBinaryStl} from '../src/vendor/trailprint/stl-writer.js';
import {buildIntegratedTerrainMesh} from '../src/mesh/integrated-model.js';
import {assertPrintableMesh,type PrintableMesh} from '../src/mesh/validate.js';
import {readBinaryStl} from '../src/mesh/sections.js';
import {generateTerrain} from '../src/generate-terrain.js';
import {generatePrintableTerrain} from '../src/generate-printable-terrain.js';
import {buildModelAppearance,recolorModelAppearance} from '../src/appearance/apply.js';
import {createAppearance,validateAppearanceOptions,validateModelAppearance} from '../src/appearance/palette.js';
import {prepareMaterialParts,validateMaterialParts} from '../src/export/material-parts.js';
import {writeColor3mf} from '../src/export/color-3mf.js';
import {writeObjBundle} from '../src/export/color-obj.js';

const selection={center:{lat:30,lon:104},bearingDeg:0,mmPerMeter:.1};
const path=[[{x:-8,y:0},{x:8,y:0}]];
function source() {
  const mesh=buildHeightfieldTerrainMesh({shape:'rectangle',widthMm:20,heightMm:20,centerLat:30,centerLon:104,bearingDeg:0,minLat:29.99,maxLat:30.01,minLon:103.99,maxLon:104.01},Float64Array.from({length:25},(_,i)=>i%5*.5),5,5,2);
  for(let i=2;i<mesh.positions.length;i+=3)mesh.positions[i]+=2;
  mesh.minSurfaceZ+=2;mesh.bottomZ=0;return mesh;
}
function unzip(bytes:Buffer) {
  const files=new Map<string,Buffer>();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50) {
    const method=bytes.readUInt16LE(offset+8),length=bytes.readUInt32LE(offset+18),n=bytes.readUInt16LE(offset+26),e=bytes.readUInt16LE(offset+28);
    const start=offset+30+n+e,payload=bytes.subarray(start,start+length);
    files.set(bytes.toString('utf8',offset+30,offset+30+n),method===8?inflateRawSync(payload):payload);offset=start+length;
  }return files;
}
function read3mf(xml:string) {
  const meshes=new Map<string,PrintableMesh>(),parser=new SaxesParser({xmlns:false});let name='',current:PrintableMesh={positions:[],indices:[]};
  parser.on('opentag',tag=>{
    if(tag.name==='object'){name=String(tag.attributes.name??'');current={positions:[],indices:[]};}
    if(tag.name==='vertex')current.positions.push(...['x','y','z'].map(key=>Number(tag.attributes[key])));
    if(tag.name==='triangle')current.indices.push(...['v1','v2','v3'].map(key=>Number(tag.attributes[key])));
  });
  parser.on('closetag',tag=>{if(tag.name==='object'&&current.indices.length)meshes.set(name,current);});
  parser.write(xml).close();return meshes;
}
function readObj(text:string) {
  const positions:number[]=[],objects=new Map<string,PrintableMesh>();let current:PrintableMesh|undefined;
  for(const line of text.split('\n')) {
    const [kind,...values]=line.trim().split(/\s+/);
    if(kind==='v')positions.push(...values.map(Number));
    if(kind==='o'){current={positions,indices:[]};objects.set(values.join(' '),current);}
    if(kind==='f')current!.indices.push(...values.map(v=>Number(v.split('/')[0])-1));
  }return objects;
}

test('disabled route emits neither exterior relief nor a route solid even outside the selected footprint',()=>{
  for(const routeSegmentsMm of [path,[[{x:30,y:30},{x:40,y:40}]],[]]) {
    const result=buildIntegratedTerrainMesh({terrainMesh:source(),routeSegmentsMm,frameWidthMm:0,routeEnabled:false} as any);
    assert.ok(!result.mesh.faceKinds!.some(kind=>kind==='route'||kind==='route-wall'));
    assert.ok(!result.mesh.materialParts!.some(part=>part.id==='route'));
    assert.equal(result.report.route.areaMm2,0);assert.equal(result.report.expectedAddedVolumeMm3,0);
    assert.equal(assertPrintableMesh(result.mesh).volumeMm3,1200);
    assert.equal(validateMaterialParts(result.mesh)!.parts.length,2);
  }
});

test('disabled text ignores retained glyph input and adds no text solid or automatic ledge',()=>{
  const result=buildIntegratedTerrainMesh({terrainMesh:source(),routeSegmentsMm:path,frameWidthMm:0,textEnabled:false,baseText:'未支持🧭',baseTextSizeMm:8,
    baseTextContours:[{outer:[{x:0,y:0},{x:100,y:0},{x:100,y:100}],holes:[]}]} as any);
  assert.ok(!result.mesh.faceKinds!.some(kind=>kind==='text'||kind==='text-wall'));
  assert.ok(!result.mesh.materialParts!.some(part=>part.id==='text'));
  assert.equal(result.report.frame.widthMm,0);assert.equal(result.report.baseText.volumeMm3,0);
  assert.equal(assertPrintableMesh(result.mesh).bounds.size.x,20);
  assert.equal(assertPrintableMesh(result.mesh).bounds.size.y,20);
});

test('disabled printable roles retain original GPX framing and route metadata without requiring glyphs',async()=>{
  const gpxXml='<gpx><trk><trkseg><trkpt lat="30" lon="104"/><trkpt lat="30.002" lon="104.003"/></trkseg></trk></gpx>';
  const options={widthMm:30,heightMm:20,gridColumns:17,frameWidthMm:0};
  const loadDem=async()=>({sample:(lat:number)=>500+(lat-30)*1000,metadata:{fixture:true}});
  const terrain=await generateTerrain({gpxXml,options,loadDem});
  const result=await generatePrintableTerrain({gpxXml,options:{...options,routeEnabled:false,textEnabled:false,baseText:'🧭'} as any,loadDem});
  assert.deepEqual(result.routeSegmentsMm,terrain.routeSegmentsMm);
  assert.deepEqual(result.report.selection,terrain.report.selection);
  assert.deepEqual(result.report.route,terrain.report.route);
  assert.ok(!result.mesh.materialParts!.some(part=>part.id==='route'||part.id==='text'));
  assert.equal((result.report.config as any).routeEnabled,false);assert.equal((result.report.config as any).textEnabled,false);
  assert.equal((result.report.integratedModel as any).route.areaMm2,0);
});

test('invalid role switches fail before loading DEM',async()=>{
  for(const bad of [{routeEnabled:0},{textEnabled:'false'},{routeEnabled:null},{textEnabled:null}]) {
    let loaded=false;
    await assert.rejects(generatePrintableTerrain({gpxXml:'',options:bad as any,loadDem:async()=>{loaded=true;return{sample:()=>0,metadata:{}};}}),{code:'CONFIG_INVALID'});
    assert.equal(loaded,false);
  }
});

test('one selected terrain role covers both semantic surface classes and linked base when recoloring',()=>{
  const before=createAppearance(['grass','rock','base','route'],validateAppearanceOptions({maxColors:6}),'uniform');
  for(const [flags,want] of [[{grassEnabled:true,rockEnabled:false},'#799278'],[{grassEnabled:false,rockEnabled:true},'#a9aa92']] as const) {
    const after=recolorModelAppearance(before,flags as any);
    assert.deepEqual(after.faceClasses,before.faceClasses);
    assert.deepEqual(after.faceMaterials.slice(0,3),[0,0,0]);
    assert.deepEqual(after.faceMaterials.map(i=>after.palette[i].color),[want,want,want,'#c84832']);
    validateModelAppearance(after,4);
  }
});

test('explicit dual terrain selection uses actual RGB capacity even at legacy two-color budget',()=>{
  const options=validateAppearanceOptions({maxColors:2,grassEnabled:true,rockEnabled:true} as any);
  const appearance=createAppearance(['grass','rock','base'],options,'uniform');
  assert.deepEqual(appearance.palette.map(p=>p.color),['#799278','#a9aa92']);
  assert.throws(()=>createAppearance(['grass','rock','route'],options,'uniform'),{code:'APPEARANCE_OPTIONS_INVALID'});
});

test('terrain switch validation rejects both disabled and nonboolean values',()=>{
  for(const input of [{grassEnabled:false,rockEnabled:false},{grassEnabled:'false'},{rockEnabled:0}])
    assert.throws(()=>validateAppearanceOptions(input as any),{code:'APPEARANCE_OPTIONS_INVALID'});
});

test('absent terrain switches preserve the exact old appearance hash and explicit switches enter hash',()=>{
  const old=createAppearance(['grass','rock','route'],validateAppearanceOptions({maxColors:3}),'uniform');
  const content={schemaVersion:1,faceClasses:['grass','rock','route'],faceMaterials:[0,1,2],
    palette:[{id:'grass',name:'草地',color:'#799278'},{id:'rock',name:'山石',color:'#a9aa92'},{id:'route',name:'路线',color:'#c84832'}],
    options:{maxColors:3,grassColor:'#799278',rockColor:'#a9aa92',routeColor:'#c84832',baseColorSource:'rock',baseColor:'#a9aa92',textColorSource:'route',textColor:'#c84832'},classification:'uniform'};
  assert.equal(old.hash,createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  assert.equal(Object.hasOwn(old.options,'grassEnabled'),false);assert.equal(Object.hasOwn(old.options,'rockEnabled'),false);
  validateModelAppearance(old,3);
  const explicit=recolorModelAppearance(old,{grassEnabled:true,rockEnabled:true} as any);
  assert.deepEqual(explicit.palette,old.palette);assert.notEqual(explicit.hash,old.hash);
  assert.throws(()=>validateModelAppearance({...explicit,options:{...explicit.options,rockEnabled:false}} as any,3));
});

test('all-white snow model exports one actual RGB through STL, 3MF and OBJ with disabled roles absent',async()=>{
  const result=buildIntegratedTerrainMesh({terrainMesh:source(),routeSegmentsMm:path,frameWidthMm:0,snowEnabled:true,snowCoveragePercent:50,
    routeEnabled:false,textEnabled:false,baseText:'保留文字'} as any);
  result.mesh.positions=result.mesh.positions.map(Math.fround);
  for(const part of result.mesh.materialParts!)part.positions=part.positions.map(Math.fround);
  const geometry=validateMaterialParts(result.mesh)!;
  assert.deepEqual(geometry.parts.map(part=>part.id),['base','terrain','snow']);
  const options={maxColors:1,grassEnabled:false,rockEnabled:true,grassColor:'#ffffff',rockColor:'#ffffff',baseColorSource:'rock'} as any;
  const appearance=buildModelAppearance(result.mesh,selection,options);
  for(const part of result.mesh.materialParts!)part.faceClasses=buildModelAppearance(part,selection,options).faceClasses;
  validateModelAppearance(appearance,result.mesh.indices.length/3);
  assert.deepEqual(prepareMaterialParts(result.mesh,appearance).palette.map(p=>p.color),['#ffffff']);
  const folder=await mkdtemp(join(tmpdir(),'shared-print-colors-'));
  try {
    const stlPath=join(folder,'model.stl');await writeBinaryStl(stlPath,result.mesh);
    const positions=Array.from(readBinaryStl(await readFile(stlPath)).coordinates);
    const stl=assertPrintableMesh({positions,indices:Array.from({length:positions.length/3},(_,i)=>i)});
    assert.equal(stl.boundaryEdges,0);assert.ok(Math.abs(stl.volumeMm3-geometry.outerVolumeMm3)<1e-5);
    for(const [format,zip] of [['3mf',writeColor3mf(result.mesh,appearance)],['obj',writeObjBundle(result.mesh,appearance)]] as const) {
      const files=unzip(zip);
      const meshes=format==='3mf'?read3mf(files.get('3D/3dmodel.model')!.toString()):readObj(files.get('model.obj')!.toString());
      assert.deepEqual([...meshes.keys()],['base','terrain','snow']);
      for(const part of geometry.parts) {
        const actual=assertPrintableMesh(meshes.get(part.id)!,{allowDisconnected:true});
        assert.equal(actual.boundaryEdges,0);assert.ok(actual.volumeMm3>0);assert.ok(Math.abs(actual.volumeMm3-part.volumeMm3)<1e-5);
      }
      const manifest=JSON.parse(files.get(format==='3mf'?'Metadata/manifest.json':'manifest.json')!.toString());
      assert.deepEqual(manifest.appearance.palette.map((p:{color:string})=>p.color),['#ffffff']);
    }
  } finally {await rm(folder,{recursive:true,force:true});}
});





test('optional relief combinations retain closed positive solids and conserved Float32 volume',()=>{
  const contours=[{outer:[{x:0,y:0},{x:3,y:0},{x:3,y:3},{x:0,y:3}],holes:[[{x:1,y:1},{x:2,y:1},{x:2,y:2},{x:1,y:2}]]}];
  for(const routeEnabled of [false,true])for(const textEnabled of [false,true])for(const snowEnabled of [false,true]) {
    const result=buildIntegratedTerrainMesh({terrainMesh:source(),routeSegmentsMm:path,routeEnabled,textEnabled,snowEnabled,snowCoveragePercent:50,
      baseText:'0',baseTextContours:contours,frameWidthMm:0});
    result.mesh.positions=result.mesh.positions.map(Math.fround);
    for(const part of result.mesh.materialParts!)part.positions=part.positions.map(Math.fround);
    const geometry=validateMaterialParts(result.mesh)!;
    assert.equal(geometry.outer.connectedComponents,1);
    assert.equal(geometry.parts.some(part=>part.id==='route'),routeEnabled);
    assert.equal(geometry.parts.some(part=>part.id==='text'),textEnabled);
    assert.equal(geometry.parts.some(part=>part.id==='snow'),snowEnabled);
    assert.ok(geometry.parts.every(part=>part.volumeMm3>0&&part.boundaryEdges===0));
    assert.ok(Math.abs(geometry.volumeMm3-geometry.outerVolumeMm3)<=geometry.volumeToleranceMm3);
  }
});

