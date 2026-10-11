import assert from 'node:assert/strict';
import { join, resolve, relative, sep } from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';
import { assertPermanentSaveTarget, saveModelFile } from '../main/save-model.mjs';

test('printing files cannot be saved into a temporary task or its descendants',()=>{
  const root=resolve('artifacts/permanent-save/tasks');
  for(const target of [root,join(root,'abc','model.stl'),join(root,'abc','color.3mf'),join(root,'abc','bundle.zip')]){
    assert.throws(()=>assertPermanentSaveTarget(target,root),error=>error.code==='SAME_PATH');
  }
  assert.doesNotThrow(()=>assertPermanentSaveTarget(join(root+'-exports','model.3mf'),root));
  assert.doesNotThrow(()=>assertPermanentSaveTarget(join(root,'..','saved','model.3mf'),root));
});

test('Windows temporary save guard also rejects a case variant of the task path', {skip:process.platform!=='win32'},()=>{
  const root=resolve('artifacts/permanent-save/tasks');
  assert.throws(()=>assertPermanentSaveTarget(join(root.toUpperCase(),'abc','model.stl'),root),error=>error.code==='SAME_PATH');
});

async function fixture(t) {
  const parent=resolve(import.meta.dirname,'../../artifacts/permanent-save');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(join(parent,'case-'));
  t.after(async()=>{const within=relative(parent,directory);assert.ok(within&&!within.startsWith(`..${sep}`));await fs.rm(directory,{recursive:true,force:true});});
  const source=join(directory,'model.stl'),bytes=Buffer.from('frozen verified model');await fs.writeFile(source,bytes);
  return{directory,source,bytes};
}

test('frozen-byte STL saver preserves rejection of the internal source destination',async t=>{
  const{source,bytes}=await fixture(t);
  await assert.rejects(saveModelFile(bytes,source,{sourcePath:source,overwriteApproved:true}),error=>error.code==='SAME_PATH');
  assert.deepEqual(await fs.readFile(source),bytes);
});

test('frozen-byte STL saver rejects a hardlink alias of the internal source',async t=>{
  const{directory,source,bytes}=await fixture(t),target=join(directory,'hardlink.stl');
  try{await fs.link(source,target);}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Environment disallows hardlinks');return;}throw error;}
  await assert.rejects(saveModelFile(bytes,target,{sourcePath:source,overwriteApproved:true}),error=>error.code==='SAME_PATH');
  assert.equal((await fs.stat(source)).ino,(await fs.stat(target)).ino);
  assert.deepEqual(await fs.readFile(target),bytes);
});

test('frozen-byte STL saver cannot publish into an aliased temporary task directory',async t=>{
  const{directory,source,bytes}=await fixture(t),task=join(directory,'temporary-task'),alias=join(directory,'outside-alias');
  await fs.mkdir(task);
  try{await fs.symlink(task,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Environment disallows directory links');return;}throw error;}
  await assert.rejects(saveModelFile(bytes,join(alias,'saved.stl'),{sourcePath:source}),error=>error.code==='DESTINATION_CHANGED');
  assert.deepEqual(await fs.readdir(task),[]);
});
