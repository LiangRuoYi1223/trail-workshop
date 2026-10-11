import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generateTerrain } from '../src/generate-terrain.js';
import { publishTerrainOutput } from '../src/export/publish.js';
import { readMatchingDemSource } from '../src/export/provenance.js';

async function workspace(run: (folder:string)=>Promise<void>): Promise<void> {
  // Use the writable project: Windows app-container Temp permits I/O but forbids cross-directory rename.
  const parent=resolve('outputs/test-workspaces');await mkdir(parent,{recursive:true});
  const folder=await mkdtemp(join(parent,'terrain-export-test-'));
  try { await run(folder); }
  finally { assert.equal(dirname(resolve(folder)),parent);assert.ok(basename(folder).startsWith('terrain-export-test-'));await rm(folder,{recursive:true,force:true}); }
}
async function model() {
  return generateTerrain({gpxXml:'<gpx><trk><trkseg><trkpt lat="30.55" lon="104.275"/><trkpt lat="30.57" lon="104.305"/></trkseg></trk></gpx>',options:{gridColumns:17},loadDem:async()=>({sample:()=>100,metadata:{}})});
}

test('导出前拒绝预览位置被目录占用，已有 STL 和报告保持原样',async()=>workspace(async folder=>{
  const output=join(folder,'terrain.stl');
  await writeFile(output,'previous-stl');await writeFile(join(folder,'terrain.report.json'),'previous-report');await mkdir(join(folder,'terrain.preview.json'));
  await assert.rejects(publishTerrainOutput(output,await model()),/普通文件/);
  assert.equal(await readFile(output,'utf8'),'previous-stl');
  assert.equal(await readFile(join(folder,'terrain.report.json'),'utf8'),'previous-report');
  assert.equal((await readdir(folder)).filter(name=>name.startsWith('.terrain-export-')).length,0);
}));

test('临时生成失败不会替换已有输出，也不会遗留临时目录',async()=>workspace(async folder=>{
  const output=join(folder,'terrain.stl');await writeFile(output,'previous-stl');
  const result=await model();result.report.circular=result.report;
  await assert.rejects(publishTerrainOutput(output,result),/circular/i);
  assert.equal(await readFile(output,'utf8'),'previous-stl');
  assert.deepEqual(await readdir(folder),['terrain.stl']);
}));

test('导出完整替换，报告校验值与最终 STL 相符',async()=>workspace(async folder=>{
  const output=join(folder,'terrain.stl');
  for(const ext of ['stl','report.json','preview.json'])await writeFile(join(folder,`terrain.${ext}`),'previous');
  await publishTerrainOutput(output,await model());
  const bytes=await readFile(output),report=JSON.parse(await readFile(join(folder,'terrain.report.json'),'utf8'));
  assert.equal(report.output.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(bytes.length,84+50*bytes.readUInt32LE(80));
  assert.equal(JSON.parse(await readFile(join(folder,'terrain.preview.json'),'utf8')).unit,'mm');
  assert.equal((await readdir(folder)).filter(name=>name.startsWith('.terrain-export-')).length,0);
}));

test('同时发布同一个文件只有一个成功，报告与最终模型仍一致',async()=>workspace(async folder=>{
  const output=join(folder,'terrain.stl'),a=await model(),b=await model();
  a.report.request='a';b.report.request='b';
  // A different STL makes cross-bundle interleaving detectable, rather than testing identical bytes.
  for(let i=0;i<b.mesh.positions.length;i+=3)b.mesh.positions[i]+=1;
  const results=await Promise.allSettled([publishTerrainOutput(output,a),publishTerrainOutput(output,b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.code,'OUTPUT_BUSY');
  const bytes=await readFile(output),report=JSON.parse(await readFile(join(folder,'terrain.report.json'),'utf8'));
  assert.equal(report.output.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await readdir(folder)).some(name=>name.endsWith('.lock')||name.startsWith('.terrain-export-')),false);
}));

test('预先存在的输出锁不会被抢占或删除',async()=>workspace(async folder=>{
  const output=join(folder,'terrain.stl');await writeFile(output+'.lock','another-process');
  await assert.rejects(publishTerrainOutput(output,await model()),/正在生成/);
  assert.equal(await readFile(output+'.lock','utf8'),'another-process');
}));

test('发布途中 I/O 失败会恢复三份旧输出',async t=>workspace(async folder=>{
  const output=join(folder,'terrain.stl');
  for(const ext of ['stl','report.json','preview.json'])await writeFile(join(folder,`terrain.${ext}`),`previous-${ext}`);
  const result=await model(),originalRename=fsPromises.rename;
  t.mock.method(fsPromises,'rename',async(...args:Parameters<typeof originalRename>)=>{
    if(basename(dirname(String(args[0]))).startsWith('.terrain-export-')&&basename(String(args[0]))==='terrain.preview.json')
      throw Object.assign(new Error('simulated publication failure'),{code:'EIO'});
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publishTerrainOutput(output,result),/simulated publication failure/);
    for(const ext of ['stl','report.json','preview.json'])assert.equal(await readFile(join(folder,`terrain.${ext}`),'utf8'),`previous-${ext}`);
    assert.equal((await readdir(folder)).some(name=>name.endsWith('.lock')||name.startsWith('.terrain-export-')),false);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();}
}));

test('完整生成后的临时清理失败返回警示，模型仍成功且报告匹配',async t=>workspace(async folder=>{
  const output=join(folder,'terrain.stl'),result=await model(),originalRm=fsPromises.rm;
  t.mock.method(fsPromises,'rm',async(...args:Parameters<typeof originalRm>)=>{
    if(basename(String(args[0])).startsWith('.terrain-export-'))throw Object.assign(new Error('simulated cleanup failure'),{code:'EACCES'});
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try {
    const publication=await publishTerrainOutput(output,result);
    assert.equal(publication.warnings.length,1);assert.match(publication.warnings[0],/临时输出清理失败/);
    const bytes=await readFile(output),report=JSON.parse(await readFile(join(folder,'terrain.report.json'),'utf8'));
    assert.equal(report.output.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await readdir(folder)).some(name=>name.endsWith('.lock')),false);
  } finally {t.mock.restoreAll();syncBuiltinESMExports();}
}));

test('DEM 来源只有与当前文件匹配时才纳入报告',async()=>workspace(async folder=>{
  const path=join(folder,'region.tif'),sourcePath=join(folder,'region.source.json');
  assert.equal(await readMatchingDemSource(path,'expected'),undefined);
  await writeFile(sourcePath,JSON.stringify({sha256:'old',dataset:'COP30'}));
  await assert.rejects(readMatchingDemSource(path,'expected'),/校验值/);
  await writeFile(sourcePath,JSON.stringify({sha256:'expected',dataset:'COP30',sourceUrl:'https://example.org/region.tif',unknown:'untrusted'}));
  assert.deepEqual(await readMatchingDemSource(path,'expected'),{sha256:'expected',dataset:'COP30',sourceUrl:'https://example.org/region.tif'});
  await writeFile(sourcePath,'{broken');
  await assert.rejects(readMatchingDemSource(path,'expected'),/JSON/);
}));
