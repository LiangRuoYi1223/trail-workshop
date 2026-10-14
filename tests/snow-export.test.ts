import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { recolorModelAppearance } from '../src/appearance/apply.js';
import type { ModelAppearance } from '../src/appearance/types.js';

type Mesh = {positions:number[];indices:number[]};
type Part = Mesh & {id:'terrain'|'snow'|'route';faceClasses?:string[];faceKinds?:string[]};
type AssemblyMesh = Mesh & {materialParts?:Part[]};
function box(low:number,high:number): Mesh {
  return {positions:[0,0,low,10,0,low,10,8,low,0,8,low,0,0,high,10,0,high,10,8,high,0,8,high],
    indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]};
}
function fixture(): {mesh:AssemblyMesh;appearance:ModelAppearance} {
  const mesh:AssemblyMesh = {...box(0,4),materialParts:[
    {...box(0,2),id:'terrain',faceClasses:['rock','rock','grass','grass',...Array(8).fill('rock')]},
    {...box(2,3),id:'snow',faceClasses:Array(12).fill('snow')},
    {...box(3,4),id:'route',faceClasses:Array(12).fill('route')},
  ]};
  // The covered grass top is absent from the outer shell palette, but must be retained on the terrain solid.
  const value = {schemaVersion:1,faceClasses:['rock','rock','route','route',...Array(8).fill('snow')],
    faceMaterials:[0,0,1,1,...Array(8).fill(2)],palette:[
      {id:'rock',name:'山石',color:'#998877'},{id:'route',name:'路线',color:'#ee3311'},{id:'snow',name:'白雪',color:'#ffffff'},
    ],options:{maxColors:4,grassColor:'#228844',rockColor:'#998877',routeColor:'#ee3311'},classification:'uniform'};
  return {mesh,appearance:{...value,hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')} as ModelAppearance};
}
async function api() {
  return {writeColor3mf:(await import(new URL('../src/export/color-3mf.js',import.meta.url).href)).writeColor3mf as (mesh:AssemblyMesh,appearance:ModelAppearance)=>Buffer,
    writeObjBundle:(await import(new URL('../src/export/color-obj.js',import.meta.url).href)).writeObjBundle as (mesh:AssemblyMesh,appearance:ModelAppearance)=>Buffer,
    validateMaterialParts:(await import(new URL('../src/export/material-parts.js',import.meta.url).href)).validateMaterialParts as (mesh:AssemblyMesh)=>any};
}
function unzip(bytes:Buffer):Map<string,Buffer> {
  const files = new Map<string,Buffer>();
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  let cursor=bytes.readUInt32LE(bytes.length-6);
  const count=bytes.readUInt16LE(bytes.length-12);
  for(let i=0;i<count;i++) {
    assert.equal(bytes.readUInt32LE(cursor),0x02014b50);
    const length=bytes.readUInt32LE(cursor+20),nameLength=bytes.readUInt16LE(cursor+28),local=bytes.readUInt32LE(cursor+42);
    const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
    const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    const data=bytes.subarray(start,start+length);
    files.set(name,bytes.readUInt16LE(cursor+10)===8?inflateRawSync(data):data);
    cursor+=46+nameLength+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);
  }
  return files;
}
interface Node {name:string;attrs:Record<string,string>;children:Node[]}
function xml(bytes:Buffer):Node {
  const roots:Node[]=[],stack:Node[]=[];
  const parser=new SaxesParser({xmlns:true});
  parser.on('opentag',tag=> {
    const node:Node={name:tag.local,attrs:Object.fromEntries(Object.entries(tag.attributes).map(([name,attr])=>[name,attr.value])),children:[]};
    (stack.at(-1)?.children??roots).push(node);stack.push(node);
  });
  parser.on('closetag',()=>{stack.pop();});parser.write(bytes.toString('utf8')).close();
  return roots[0];
}
function children(node:Node,name:string):Node[] {return node.children.filter(child=>child.name===name);}
function one(node:Node,name:string):Node {assert.equal(children(node,name).length,1);return children(node,name)[0];}
function objectMesh(object:Node):Mesh {
  const mesh=one(object,'mesh');
  return {positions:children(one(mesh,'vertices'),'vertex').flatMap(node=>['x','y','z'].map(key=>Number(node.attrs[key]))),
    indices:children(one(mesh,'triangles'),'triangle').flatMap(node=>['v1','v2','v3'].map(key=>Number(node.attrs[key])))};
}
// Independent edge counts and signed volume catch surface-only exports, lost solids, and winding/index errors.
function solidVolume(mesh:Mesh):number {
  const edges=new Map<string,number>();let sixVolume=0;
  for(let i=0;i<mesh.indices.length;i+=3) {
    const ids=mesh.indices.slice(i,i+3),p=ids.map(id=>mesh.positions.slice(id*3,id*3+3));
    assert.ok(ids.every(id=>Number.isInteger(id)&&id>=0&&id<mesh.positions.length/3));
    const [a,b,c]=p;
    sixVolume+=a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    for(const [from,to] of [[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[0]]]) {
      const key=[from,to].sort((a,b)=>a-b).join(',');edges.set(key,(edges.get(key)??0)+1);
    }
  }
  assert.ok([...edges.values()].every(count=>count===2),'every solid is independently closed');
  assert.ok(sixVolume>0);return sixVolume/6;
}

test('snow 3MF retains three closed solids, uniform base materials, and one coordinate-preserving assembly',async()=> {
  const {writeColor3mf}=await api(),{mesh,appearance}=fixture();
  const files=unzip(writeColor3mf(mesh,appearance));
  const model=xml(files.get('3D/3dmodel.model')!),resources=one(model,'resources');
  const bases=one(resources,'basematerials'),baseColors=children(bases,'base').map(node=>node.attrs.displaycolor.toLowerCase());
  assert.deepEqual([...baseColors].sort(),['#228844ff','#998877ff','#ee3311ff','#ffffffff']);
  const objects=children(resources,'object'),solidObjects=objects.filter(object=>children(object,'mesh').length);
  assert.deepEqual(solidObjects.map(object=>object.attrs.name),['terrain','snow','route']);
  assert.deepEqual(solidObjects.map(object=>solidVolume(objectMesh(object))),[160,80,80]);
  for(const [role,color,z] of [['snow','#ffffffff',2],['route','#ee3311ff',3]] as const) {
    const object=solidObjects.find(object=>object.attrs.name===role)!;
    assert.equal(object.attrs.pid,bases.attrs.id);
    assert.equal(baseColors[Number(object.attrs.pindex)],color);
    const triangles=children(one(one(object,'mesh'),'triangles'),'triangle');
    for(const triangle of triangles) {
      assert.equal(triangle.attrs.pid??object.attrs.pid,bases.attrs.id);
      assert.equal(baseColors[Number(triangle.attrs.p1??object.attrs.pindex)],color);
      assert.equal(triangle.attrs.p2??triangle.attrs.p1??object.attrs.pindex,triangle.attrs.p1??object.attrs.pindex);
      assert.equal(triangle.attrs.p3??triangle.attrs.p1??object.attrs.pindex,triangle.attrs.p1??object.attrs.pindex);
    }
    assert.equal(Math.min(...objectMesh(object).positions.filter((_,index)=>index%3===2)),z);
  }
  const terrain=solidObjects[0],group=one(resources,'colorgroup'),colors=children(group,'color').map(node=>node.attrs.color.toLowerCase());
  assert.deepEqual(children(one(one(terrain,'mesh'),'triangles'),'triangle').map(triangle=>colors[Number(triangle.attrs.p1)]),
    ['#998877ff','#998877ff','#228844ff','#228844ff',...Array(8).fill('#998877ff')]);
  assert.ok(children(one(one(terrain,'mesh'),'triangles'),'triangle').every(triangle=>triangle.attrs.pid===group.attrs.id
    &&triangle.attrs.p1===triangle.attrs.p2&&triangle.attrs.p1===triangle.attrs.p3));
  const assembly=objects.find(object=>children(object,'components').length)!;
  assert.deepEqual(children(one(assembly,'components'),'component').map(node=>node.attrs.objectid),solidObjects.map(object=>object.attrs.id));
  assert.ok(children(one(assembly,'components'),'component').every(node=>node.attrs.transform===undefined||node.attrs.transform==='1 0 0 0 1 0 0 0 1 0 0 0'));
  const item=one(one(model,'build'),'item');assert.equal(item.attrs.objectid,assembly.attrs.id);assert.equal(item.attrs.transform,undefined);
  const manifest=JSON.parse(files.get('Metadata/manifest.json')!.toString('utf8'));
  assert.deepEqual(manifest.materialParts.map((part:any)=>[part.id,part.volumeMm3]),[['terrain',160],['snow',80],['route',80]]);
  assert.equal(manifest.appearance.palette.length,4);
});

test('snow 3MF safely preserves user material names containing XML special characters',async()=> {
  const {writeColor3mf}=await api(),{mesh,appearance}=fixture();
  appearance.palette[0].name='岩石 " & < >';
  const {hash,...contents}=appearance;
  appearance.hash=createHash('sha256').update(JSON.stringify(contents)).digest('hex');
  const model=xml(unzip(writeColor3mf(mesh,appearance)).get('3D/3dmodel.model')!);
  assert.equal(children(one(one(model,'resources'),'basematerials'),'base')[0].attrs.name,'岩石 " & < >');
});

test('snow OBJ contains individually closed objects and current fixed MTL colors after recoloring',async()=> {
  const {writeObjBundle}=await api(),{mesh,appearance}=fixture();
  const recolored=recolorModelAppearance(appearance,{grassColor:'#123456',rockColor:'#654321',routeColor:'#778899'});
  const files=unzip(writeObjBundle(mesh,recolored)),obj=files.get('model.obj')!.toString('utf8');
  const positions:number[]=[],objects=new Map<string,{indices:number[];materials:string[]}>();
  let current:string|undefined,material='';
  for(const line of obj.split('\n')) {
    const [kind,...values]=line.trim().split(/\s+/);
    if(kind==='v') positions.push(...values.map(Number));
    if(kind==='o') {current=values.join(' ');objects.set(current,{indices:[],materials:[]});}
    if(kind==='usemtl') material=values[0];
    if(kind==='f') {const object=objects.get(current!)!;object.indices.push(...values.map(value=>Number(value.split('/')[0])-1));object.materials.push(material);}
  }
  assert.deepEqual([...objects.keys()],['terrain','snow','route']);
  assert.deepEqual([...objects.values()].map(object=>solidVolume({positions,indices:object.indices})),[160,80,80]);
  const mtl=files.get('model.mtl')!.toString('utf8'),mtlColors=new Map<string,number[]>();let name='';
  for(const line of mtl.split('\n')) {
    const [kind,...values]=line.trim().split(/\s+/);if(kind==='newmtl') name=values[0];if(kind==='Kd') mtlColors.set(name,values.map(Number));
  }
  const hex=(name:string)=>'#'+mtlColors.get(name)!.map(value=>Math.round(value*255).toString(16).padStart(2,'0')).join('');
  assert.deepEqual([...mtlColors.keys()].map(hex).sort(),['#123456','#654321','#778899','#ffffff']);
  assert.ok(objects.get('snow')!.materials.every(name=>hex(name)==='#ffffff'));
  assert.ok(objects.get('route')!.materials.every(name=>hex(name)==='#778899'));
  assert.ok(objects.get('terrain')!.materials.some(name=>hex(name)==='#123456'),'covered grass retained using current options');
  const png=files.get('palette.png')!;
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),64);assert.equal(png.readUInt32BE(20),16);
  const compressed:Buffer[]=[];
  for(let offset=8;offset<png.length;) {
    const length=png.readUInt32BE(offset),kind=png.subarray(offset+4,offset+8).toString('ascii');
    if(kind==='IDAT') compressed.push(png.subarray(offset+8,offset+8+length));offset+=length+12;
  }
  const pixels=inflateSync(Buffer.concat(compressed)),swatches=new Set<string>();
  for(let row=0;row<16;row++) {
    const start=row*(64*3+1);assert.equal(pixels[start],0);
    for(let column=0;column<64;column++) swatches.add('#'+pixels.subarray(start+1+column*3,start+4+column*3).toString('hex'));
  }
  assert.deepEqual([...swatches].sort(),['#123456','#654321','#778899','#ffffff']);
  assert.equal(JSON.parse(files.get('manifest.json')!.toString()).appearance.hash,recolored.hash);
});

test('material part validation supports geometry-only data and rejects open, duplicate, corrupt and volume-inconsistent solids',async()=> {
  const {validateMaterialParts,writeColor3mf,writeObjBundle}=await api(),{mesh,appearance}=fixture();
  assert.equal(validateMaterialParts(box(0,4)),undefined);
  const report=validateMaterialParts({...mesh,materialParts:mesh.materialParts!.map(({faceClasses,...part})=>part)});
  assert.equal(report.volumeMm3,320);assert.equal(report.outerVolumeMm3,320);
  assert.deepEqual(report.parts.map((part:any)=>part.id),['terrain','snow','route']);
  const mutations:Array<(parts:Part[])=>void>=[
    parts=>{parts[1].indices.pop();},
    parts=>{parts[1].positions[0]=NaN;},
    parts=>{parts[1].indices=parts[1].indices.slice(0,-3);},
    parts=>{parts[2].id='snow';},
    parts=>{parts[1]= {...box(2,2.5),id:'snow',faceClasses:Array(12).fill('snow')};},
    parts=>{parts[0].faceClasses=['grass'];},
    parts=>{parts[1].faceClasses![0]='route';},
    parts=>{parts[0].faceKinds=Array(12).fill('invalid');},
    parts=>{parts[0].positions[0]=-1;},
  ];
  for(const mutate of mutations) {
    const changed=structuredClone(mesh);mutate(changed.materialParts!);
    assert.throws(()=>validateMaterialParts(changed),/material|part|volume|closed|boundary|triangle|finite|index|class|label|bounds/i);
    for(const writer of [writeColor3mf,writeObjBundle]) assert.throws(()=>writer(changed,appearance));
  }
  for(const materialParts of [[],[{...box(0,4),id:'snow'}]])
    assert.throws(()=>validateMaterialParts({...mesh,materialParts} as AssemblyMesh),/terrain|part/i);
  const unclassified=structuredClone(mesh);delete unclassified.materialParts![0].faceClasses;
  assert.doesNotThrow(()=>validateMaterialParts(unclassified));
  for(const writer of [writeColor3mf,writeObjBundle]) assert.throws(()=>writer(unclassified,appearance),/class|分类/i);
});

test('snow export capacity includes covered terrain RGB and permits collapsing it to a selected role',async()=>{
  const {writeColor3mf,writeObjBundle}=await api(),{mesh,appearance}=fixture();
  const outerOnly=recolorModelAppearance(appearance,{maxColors:3});
  assert.equal(outerOnly.palette.length,3);
  for(const writer of [writeColor3mf,writeObjBundle]) {
    assert.throws(()=>writer(mesh,outerOnly),/实际材料颜色.*预算/);
    const shared=recolorModelAppearance(outerOnly,{grassEnabled:false,rockEnabled:true});
    const files=unzip(writer(mesh,shared));
    const manifest=JSON.parse(files.get(files.has('manifest.json')?'manifest.json':'Metadata/manifest.json')!.toString());
    assert.deepEqual(manifest.appearance.palette.map((p:{color:string})=>p.color).sort(),['#998877','#ee3311','#ffffff']);
  }
});
