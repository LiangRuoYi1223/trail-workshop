import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {checkRuntime} from '../main/runtime-check-snow.mjs';
import * as core from '../../dist/src/index.js';

// Four hand-defined stacked unit cubes exercise the packaging contract without
// launching Electron or running terrain generation during timing measurements.
function cube(bottom,top,kind) {
  return {positions:[0,0,bottom,1,0,bottom,1,1,bottom,0,1,bottom,0,0,top,1,0,top,1,1,top,0,1,top],
    indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
    faceKinds:Array(12).fill(kind)};
}
test('packaged snow check accepts current base/terrain/snow/route solids and saves all formats',async t=>{
  const folder=await realpath(await mkdtemp(join(tmpdir(),'snow-runtime-contract-')));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  await mkdir(join(folder,'core'));
  await writeFile(join(folder,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(join(folder,'core/index.js'),`export * from ${JSON.stringify(new URL('../../dist/src/index.js',import.meta.url).href)};`);
  const mesh={...cube(0,4,'terrain'),materialParts:['base','terrain','snow','route'].map((id,index)=>({id,...cube(index,index+1,id)}))};
  const colors={maxColors:4,grassColor:'#799278',rockColor:'#a9aa92',routeColor:'#c84832'};
  const selection={center:{lat:30,lon:104},bearingDeg:0,mmPerMeter:1};
  const appearance=core.buildModelAppearance(mesh,selection,colors);
  for(const part of mesh.materialParts)part.faceClasses=core.buildModelAppearance(part,selection,colors).faceClasses;
  const stl=Buffer.alloc(84+12*50);stl.writeUInt32LE(12,80);
  mesh.indices.forEach((vertex,index)=>{for(let axis=0;axis<3;axis++)stl.writeFloatLE(mesh.positions[vertex*3+axis],84+Math.floor(index/3)*50+12+(index%3)*12+axis*4);});
  const preview={mesh,appearance,report:{snow:{actualCoveragePercent:30},validation:core.validateMaterialParts(mesh).outer}};
  const job={id:'fixture',state:'succeeded',result:{stlSha256:createHash('sha256').update(stl).digest('hex')}};
  const manager={addRoute:async()=>({id:'route'}),addDem:async()=>({id:'dem'}),start:async()=>job,get:()=>job,preview:async()=>preview,
    async exportModel(id,format,options){
      const current=core.recolorModelAppearance(appearance,options);
      return {bytes:format==='stl'?stl:format==='3mf'?core.writeColor3mf(mesh,current):core.writeObjBundle(mesh,current),extension:format==='obj'?'.zip':'.'+format};
    }};
  const output=join(folder,'output');
  const result=await checkRuntime({app:{isPackaged:true,getVersion:()=> '0.4.6',getAppPath:()=>folder},manager,routePath:'route.kml',demPath:'dem.tif',destination:output});
  assert.equal(result.passed,true);
  assert.deepEqual(result.materials.parts.map(part=>part.id),['base','terrain','snow','route']);
  assert.deepEqual(result.formats.map(value=>value.format),['3mf','obj','stl']);
  assert.equal(JSON.parse(await readFile(join(output,'runtime-check.json'),'utf8')).passed,true);
});
