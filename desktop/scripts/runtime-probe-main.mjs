import { app,utilityProcess } from 'electron';
import { mkdir,writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const destination=path.join(root,'artifacts','desktop-runtime-probe');
mkdirSync(path.join(destination,'electron-profile'),{recursive:true});
app.setPath('userData',path.join(destination,'electron-profile'));
app.disableHardwareAcceleration();
async function probe() {
await app.whenReady();
await mkdir(destination,{recursive:true});
const child=utilityProcess.fork(fileURLToPath(new URL('./runtime-probe-worker.mjs',import.meta.url)),[root,destination],{stdio:'pipe',cwd:destination,serviceName:'Terrain Runtime Probe'});
let report;
const timer=setTimeout(()=>{child.kill();app.exit(1);},60000);
child.on('message',message=>{report=message;});
child.on('exit',async code=>{
  clearTimeout(timer);
  const result={mainRuntime:{electron:process.versions.electron,node:process.versions.node},exitCode:code,...report};
  await writeFile(path.join(destination,'runtime.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));app.exit(report?.passed&&code===0?0:1);
});
child.stderr?.on('data',data=>process.stderr.write(data));
}
void probe().catch(error=>{console.error(error);app.exit(1);});
