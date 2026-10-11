import { packager } from '@electron/packager';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const releaseRoot=path.join(root,'desktop','release','v0.4.3');
const releasePath=path.join(releaseRoot,'TerrainWorkshop-win32-x64');
if(existsSync(releasePath))throw new Error('软件输出目录已经存在，请先保留或移走上一版完整文件夹，再重新打包。');
const parent=path.join(root,'artifacts','desktop-packaging');
await mkdir(parent,{recursive:true});
const stage=await mkdtemp(path.join(parent,'input-'));
const temporary=await mkdtemp(path.join(parent,'packager-'));
const zipDirectoryArgument=process.argv.indexOf('--electron-zip-dir');
const electronZipDir=zipDirectoryArgument<0?undefined:process.argv[zipDirectoryArgument+1];
if(zipDirectoryArgument>=0&&!electronZipDir)throw new Error('请指定 Electron ZIP 缓存目录。');
for(const [from,to] of [
  ['dist/src','core'],['desktop/main','main'],['desktop/dist/renderer','renderer'],
  ['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md'],
  ['src/vendor/trailprint/LICENSE','core/vendor/trailprint/LICENSE'],
  ['desktop/licenses','licenses'],
]) {
  const target=path.join(stage,to);await mkdir(path.dirname(target),{recursive:true});
  await cp(path.join(root,from),target,{recursive:true,errorOnExist:true,force:false,
    filter:source=>path.basename(source)!=='Copernicus-GLO30-SAMPLE.md'});
}
const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const application={name:'terrain-workshop',productName:'徒步地形工坊',version:'0.4.3',author:'TerrainWorkshop contributors',private:true,type:'module',main:'main/main.mjs',dependencies:sourcePackage.dependencies};
await writeFile(path.join(stage,'package.json'),JSON.stringify(application,null,2)+'\n');
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
lock.name=application.name;lock.version=application.version;
lock.packages['']={name:application.name,version:application.version,dependencies:application.dependencies};
await writeFile(path.join(stage,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
const npmEntry=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
const installed=spawnSync(process.execPath,[npmEntry,'ci','--offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit'});
if(installed.error)throw installed.error;
if(installed.status!==0)throw new Error('桌面包生产依赖安装失败；请先在本项目完成依赖安装。');
const outputs=await packager({dir:stage,name:'TerrainWorkshop',executableName:'TerrainWorkshop',appVersion:application.version,
  electronVersion:sourcePackage.devDependencies.electron,platform:'win32',arch:'x64',out:releaseRoot,
  asar:false,prune:false,overwrite:false,tmpdir:temporary,electronZipDir,download:{cacheRoot:path.join(root,'artifacts','electron-cache')},
  appCopyright:'TerrainWorkshop contributors; third-party licenses included',
});
for(const output of outputs)for(const document of ['更新说明-v0.4.3.txt','最终验证清单-v0.4.3.txt']) {
  await cp(path.join(root,document),path.join(output,document),{errorOnExist:true,force:false});
}
await writeFile(path.join(root,'artifacts','desktop-packaging','latest.json'),JSON.stringify({stage,outputs,version:application.version,electron:sourcePackage.devDependencies.electron},null,2)+'\n');
console.log(JSON.stringify({application:outputs[0],executable:path.join(outputs[0],'TerrainWorkshop.exe')}));
