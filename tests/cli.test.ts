import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
function checkError(args:string[]) {
  const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
  assert.equal(result.status,1);
  const error=JSON.parse(result.stderr.trim());
  assert.equal(error.error,'CONFIG_INVALID');assert.equal(typeof error.message,'string');
}
test('未知命令参数返回可读错误，不输出调用栈',()=>checkError(['--unsupported']));
test('无效 JSON 和路径参数类型在开始生成前明确报错',async()=>{
  const parent=resolve(tmpdir()),folder=await mkdtemp(join(parent,'terrain-cli-test-')),path=join(folder,'config.json');
  try {
    for(const config of ['{broken',JSON.stringify({gpx:12,output:'a.stl',dem:{file:'dem.tif'}}),JSON.stringify({gpx:'a.gpx',output:'a.stl',dem:{file:12}}),JSON.stringify({gpx:'a.gpx',output:'a.stl',dem:{file:'dem.tif'},terrain:[]} )]) {
      await writeFile(path,config);checkError(['--config',path]);
    }
  } finally {assert.equal(dirname(resolve(folder)),parent);assert.ok(basename(folder).startsWith('terrain-cli-test-'));await rm(folder,{recursive:true,force:true});}
});
