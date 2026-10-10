import { readFile } from 'node:fs/promises';
import { assertPrintableMesh } from '../src/mesh/validate.js';
const path=process.argv[2];
if(!path)throw new Error('用法：node dist/scripts/verify-stl.js outputs/stage1/Longquanshan_Terrain.stl');
const buffer=await readFile(path);
if(buffer.length<84)throw new Error('STL 文件过短');
const count=buffer.readUInt32LE(80);
if(buffer.length!==84+count*50)throw new Error('STL 三角面数量与文件长度不匹配');
const positions:number[]=[],indices:number[]=[];
for(let face=0;face<count;face++)for(let vertex=0;vertex<3;vertex++) {
  const offset=84+face*50+12+vertex*12;
  indices.push(indices.length);
  positions.push(buffer.readFloatLE(offset),buffer.readFloatLE(offset+4),buffer.readFloatLE(offset+8));
}
console.log(JSON.stringify({file:path,bytes:buffer.length,validation:assertPrintableMesh({positions,indices})},null,2));
