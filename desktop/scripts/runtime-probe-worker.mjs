import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root,destination]=process.argv.slice(2);
try {
  const core=await import(pathToFileURL(path.join(root,'dist','src','index.js')).href);
  const result=await core.generatePrintableTerrain({gpxXml:await readFile(path.join(root,'fixtures','sample-trail.gpx'),'utf8'),
    fileName:'sample-trail.gpx',options:{widthMm:120,heightMm:80,baseThicknessMm:2,zExaggeration:2,gridColumns:129,routeWidthMm:1,frameWidthMm:3},
    loadDem:()=>core.loadLocalDem(path.join(root,'data','copernicus-longquanshan.tif'))});
  await core.publishTerrainOutput(path.join(destination,'probe.stl'),result);
  process.parentPort.postMessage({passed:true,workerRuntime:{electron:process.versions.electron,node:process.versions.node},validation:result.report.validation,output:result.report.output,route:result.report.integratedModel.route});
} catch(error) {process.parentPort.postMessage({passed:false,error:{name:error.name,message:error.message}});process.exitCode=1;}
setTimeout(()=>process.exit(process.exitCode ?? 0),25);
