import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveModelFile } from './save-model.mjs';

function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength), start = offset + 30 + nameLength + extra;
    const payload = bytes.subarray(start, start + length);
    files.set(name, method === 8 ? inflateRawSync(payload) : payload); offset = start + length;
  }
  return files;
}

/** Explicit packaging smoke check; uses the installed app's real manager and worker. */
export async function checkRuntime({ app, manager, routePath, demPath, imagePath, destination }) {
  const output = resolve(destination); await mkdir(output, {recursive:true});
  const runtime = {packaged:app.isPackaged, version:app.getVersion(), applicationRoot:app.getAppPath(), platform:process.platform};
  try {
    assert.equal(runtime.packaged, true); assert.equal(runtime.version, '0.4.7');
    const core = await import(pathToFileURL(join(app.getAppPath(), 'core/index.js')).href);
    const route = await manager.addRoute(resolve(routePath)), dem = await manager.addDem(resolve(demPath));
    const image = imagePath ? await manager.addImage(resolve(imagePath)) : undefined;
    const colors = {maxColors:4, grassColor:'#799278', rockColor:'#a9aa92', routeColor:'#c84832'};
    const options = {...colors, widthMm:123.1234, heightMm:80, gridColumns:129,
      snowEnabled:true, snowCoveragePercent:30, snowMaxThicknessMm:1};
    const task = await manager.start({routeId:route.id, demId:dem.id, demMode:'local',
      imageMode:image?'local':'none', ...(image?{imageId:image.id}:{}), options});
    const deadline = Date.now()+120000;
    while (['running','cancelling'].includes(manager.get(task.id).state)) {
      assert.ok(Date.now()<deadline, 'Packaged snow generation timed out');
      await new Promise(done=>setTimeout(done,30));
    }
    const job = manager.get(task.id); assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    const preview = await manager.preview(task.id), materials = core.validateMaterialParts(preview.mesh);
    assert.deepEqual(materials.parts.map(part=>part.id).sort(), ['route','snow','terrain']);
    assert.equal(materials.outer.connectedComponents,1);
    assert.ok(Math.abs(preview.report.snow.actualCoveragePercent-30)<=0.02);
    const formats = [];
    for (const format of ['3mf','obj','stl']) {
      const selection = format==='obj'?{...colors,routeColor:'#0055ff'}:colors;
      const artifact = await manager.exportModel(task.id,format,selection);
      const saved = await saveModelFile(artifact.bytes,join(output,`积雪模型${artifact.extension}`));
      const bytes = await readFile(saved.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256);
      if (format==='3mf') {
        const files=unzip(bytes), xml=files.get('3D/3dmodel.model').toString('utf8');
        assert.equal((xml.match(/<mesh>/g)??[]).length,3); assert.match(xml, /<components>/);
        assert.match(xml,/displaycolor="#ffffffff"/i);
      } else if(format==='obj') {
        const files=unzip(bytes);
        assert.deepEqual((files.get('model.obj').toString('utf8').match(/^o .+$/gm)??[]).sort(),['o route','o snow','o terrain']);
        assert.match(files.get('model.mtl').toString('utf8'), /Kd 0 0\.3333333333333333 1/);
      } else assert.equal(saved.sha256, job.result.stlSha256);
      formats.push({format,...saved});
    }
    await assert.rejects(manager.exportModel(task.id,'3mf',{...colors,maxColors:3}),{code:'CONFIG_INVALID'});
    const result={passed:true,runtime,job,saved:formats.find(value=>value.format==='stl'),snow:preview.report.snow,validation:preview.report.validation,materials,formats};
    await writeFile(join(output,'runtime-check.json'),JSON.stringify(result,null,2)); return result;
  } catch(error) {
    await writeFile(join(output,'runtime-check.json'),JSON.stringify({passed:false,runtime,error:error.stack??String(error)},null,2)); throw error;
  }
}
