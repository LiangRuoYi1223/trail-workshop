import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTerrainFrame } from '../src/geo/frame.js';
import { createTerrainSampleDomain } from '../src/geo/sample-domain.js';
import { generateTerrain } from '../src/generate-terrain.js';
import { TerrainError } from '../src/errors.js';
import type { GenerationResult, TerrainOptions } from '../src/types.js';

const points=[{lat:30.55,lon:104.275},{lat:30.57,lon:104.305}];
const gpxXml='<gpx version="1.1"><trk><trkseg><trkpt lat="30.55" lon="104.275"/><trkpt lat="30.57" lon="104.305"/></trkseg></trk></gpx>';
const circleOptions: TerrainOptions={shape:'circle',widthMm:120,gridColumns:33,groundWidthM:4000,baseThicknessMm:2,zExaggeration:2};

function elevationReport(result: GenerationResult) {
  return result.report.elevation as {
    minimumM:number; maximumM:number; reliefMm:number;
    missingSamples:number; missingFraction:number; filledSamples:number;
    sampleDomain:{gridSamples:number;surfaceSupportSamples:number;requiredSamples:number;smoothingHaloSamples:number;excludedSamples:number};
  };
}

function topRange(result: GenerationResult) {
  let min=Infinity,max=-Infinity;
  for(let offset=2;offset<result.mesh.positions.length;offset+=3) {
    const z=result.mesh.positions[offset];
    if(z>0){min=Math.min(min,z);max=Math.max(max,z);}
  }
  return {min,max};
}

function near(actual:number,expected:number,tolerance=1e-9) {
  assert.ok(Math.abs(actual-expected)<tolerance,`${actual} differs from ${expected}`);
}

function gridIndex(x:number,y:number,cols:number,rows:number,width:number,height:number) {
  const col=Math.round((x/width+0.5)*(cols-1));
  const row=Math.round((y/height+0.5)*(rows-1));
  return row*cols+col;
}

test('irrelevant circle bounding-box values cannot raise its floor, inflate relief or reject valid terrain',async()=>{
  const frame=createTerrainFrame(points,circleOptions);
  let baseline:GenerationResult|undefined;
  for(const outside of [100,0,null,10000]) {
    const result=await generateTerrain({gpxXml,options:circleOptions,loadDem:async()=>({
      sample:(lat,lon)=>{const p=frame.geoToMm({lat,lon});return Math.hypot(p.x,p.y)>66?outside:100;},
      metadata:{provider:'domain-test-only'},
    })});
    if(!baseline)baseline=result;
    assert.deepEqual(result.mesh.positions,baseline.mesh.positions);
    assert.deepEqual(result.mesh.indices,baseline.mesh.indices);
    const report=elevationReport(result),range=topRange(result);
    near(range.min,2);near(range.max,2);near(report.reliefMm,0);
    near(report.minimumM,100);near(report.maximumM,100);
    assert.equal(result.mesh.minSurfaceZ,range.min);
    assert.equal(report.missingSamples,0);assert.equal(report.filledSamples,0);
    assert.ok(report.sampleDomain.excludedSamples>0);
  }
});

test('missing data inside the real footprint is still rejected',async()=>{
  const frame=createTerrainFrame(points,circleOptions);
  await assert.rejects(generateTerrain({gpxXml,options:circleOptions,loadDem:async()=>({
    sample:(lat,lon)=>{const p=frame.geoToMm({lat,lon});return Math.hypot(p.x,p.y)<30?null:100;},metadata:{},
  })}),(error:unknown)=>error instanceof TerrainError&&error.code==='DEM_COVERAGE_MISSING');
});

test('positive-weight interpolation support outside the outline is checked rather than skipped',async()=>{
  const frame=createTerrainFrame(points,circleOptions);
  // x=60, y=3.75 lies just outside a radius-60 circle, but contributes to
  // triangles cut by the circular boundary. A simple inside-point mask loses it.
  const boundaryIndex=17*33+32;
  const domain=createTerrainSampleDomain(frame.crop,33,33,'raw');
  assert.equal(domain.required[boundaryIndex],1);
  let sampled=false;
  await assert.rejects(generateTerrain({gpxXml,options:{...circleOptions,maxMissingFraction:0},loadDem:async()=>({
    sample:(lat,lon)=>{
      const p=frame.geoToMm({lat,lon});
      if(gridIndex(p.x,p.y,33,33,120,120)===boundaryIndex){sampled=true;return null;}
      return 100;
    },metadata:{},
  })}),(error:unknown)=>error instanceof TerrainError&&error.code==='DEM_COVERAGE_MISSING');
  assert.equal(sampled,true);
});

test('smoothing includes its original-data halo, and a missing halo sample cannot be hidden',async()=>{
  const options={...circleOptions,gridColumns:65};
  const frame=createTerrainFrame(points,options);
  const rawDomain=createTerrainSampleDomain(frame.crop,65,65,'raw');
  const lightDomain=createTerrainSampleDomain(frame.crop,65,65,'light');
  const haloIndex=Array.from(lightDomain.required).findIndex((required,index)=>required===1&&rawDomain.required[index]===0);
  assert.ok(haloIndex>=0);
  const sampler=(value:number|null)=>({sample:(lat:number,lon:number)=>{
    const p=frame.geoToMm({lat,lon});return gridIndex(p.x,p.y,65,65,120,120)===haloIndex?value:100;
  },metadata:{}});
  const raw=await generateTerrain({gpxXml,options:{...options,maxMissingFraction:0},loadDem:async()=>sampler(null)});
  near(elevationReport(raw).reliefMm,0);
  await assert.rejects(generateTerrain({gpxXml,options:{...options,smoothing:'light',maxMissingFraction:0},loadDem:async()=>sampler(null)}),
    (error:unknown)=>error instanceof TerrainError&&error.code==='DEM_COVERAGE_MISSING');
  const smoothed=await generateTerrain({gpxXml,options:{...options,smoothing:'light'},loadDem:async()=>sampler(700)});
  assert.ok(elevationReport(smoothed).reliefMm>0,'valid halo data must contribute to smoothing');
  assert.ok(elevationReport(smoothed).sampleDomain.smoothingHaloSamples>0);
});

test('all smoothing levels accept complete dependency data without filling irrelevant NoData corners',async()=>{
  const options={...circleOptions,gridColumns:65,maxMissingFraction:0};
  const frame=createTerrainFrame(points,options);
  for(const smoothing of ['raw','light','medium','heavy'] as const) {
    const domain=createTerrainSampleDomain(frame.crop,65,65,smoothing);
    assert.ok(domain.requiredCount<65*65);
    const result=await generateTerrain({gpxXml,options:{...options,smoothing},loadDem:async()=>({
      sample:(lat,lon)=>{const p=frame.geoToMm({lat,lon});return domain.required[gridIndex(p.x,p.y,65,65,120,120)]?100:null;},
      metadata:{},
    })});
    const report=elevationReport(result),range=topRange(result);
    assert.equal(report.missingSamples,0);assert.equal(report.filledSamples,0);
    assert.equal(report.sampleDomain.requiredSamples,domain.requiredCount);
    near(range.min,2);near(range.max,2);
  }
});

test('approved small holes are filled only in the required domain and counted honestly',async()=>{
  const options={...circleOptions,maxMissingFraction:0.01};
  const frame=createTerrainFrame(points,options);
  const domain=createTerrainSampleDomain(frame.crop,33,33,'raw');
  const centre=16*33+16;
  const result=await generateTerrain({gpxXml,options,loadDem:async()=>({sample:(lat,lon)=>{
    const p=frame.geoToMm({lat,lon}),index=gridIndex(p.x,p.y,33,33,120,120);
    return index===centre||!domain.required[index]?null:100;
  },metadata:{}})});
  const report=elevationReport(result),range=topRange(result);
  assert.equal(report.missingSamples,1);assert.equal(report.filledSamples,1);
  assert.equal(report.missingFraction,1/domain.requiredCount);
  near(range.min,2);near(range.max,2);
});

test('polygon and rounded rectangle elevation reports match the actual printed surface',async()=>{
  for(const shapeOptions of [
    {shape:'polygon' as const,polygonSides:5},
    {shape:'rectangle' as const,heightMm:80,cornerRadiusMm:20},
  ]) {
    const options={...circleOptions,...shapeOptions},frame=createTerrainFrame(points,options);
    const result=await generateTerrain({gpxXml,options,loadDem:async()=>({sample:(lat,lon)=>{
      const p=frame.geoToMm({lat,lon});return 500+2*p.x+3*p.y;
    },metadata:{}})});
    let minimumM=Infinity,maximumM=-Infinity;
    for(let offset=0;offset<result.mesh.positions.length;offset+=3) {
      if(result.mesh.positions[offset+2]<=0)continue;
      const value=500+2*result.mesh.positions[offset]+3*result.mesh.positions[offset+1];
      minimumM=Math.min(minimumM,value);maximumM=Math.max(maximumM,value);
    }
    const report=elevationReport(result),range=topRange(result);
    near(report.minimumM,minimumM,1e-6);near(report.maximumM,maximumM,1e-6);
    near(range.min,2);assert.equal(result.mesh.minSurfaceZ,range.min);
    near(report.reliefMm,range.max-range.min);
    const size=(result.report.validation as {bounds:{size:{z:number}}}).bounds.size;
    near(size.z,2+report.reliefMm);
  }
});

test('the existing plain rectangle arithmetic and geometry remain unchanged',async()=>{
  const result=await generateTerrain({gpxXml,options:{gridColumns:33,widthMm:120,heightMm:80,groundWidthM:4000,baseThicknessMm:2,zExaggeration:2},
    loadDem:async()=>({sample:(lat,lon)=>500+(lat-30.55)*1000+(lon-104.275)*200,metadata:{}})});
  const hash=createHash('sha256').update(JSON.stringify({positions:result.mesh.positions,indices:result.mesh.indices})).digest('hex');
  assert.equal(hash,'8ead89ddd5f101e2b06690daf3a6c3b0bfe73e4d7af63ab5ca58f1b02acb5057');
});

test('loader receives cancellation context and aborting during DEM loading stops before sampling',async()=>{
  const controller=new AbortController();let sampled=false;
  await assert.rejects(generateTerrain({gpxXml,signal:controller.signal,loadDem:async(_bounds,context)=>{
    assert.equal(context.signal,controller.signal);controller.abort();
    return {sample:()=>{sampled=true;return 100;},metadata:{}};
  }}),/abort/i);
  assert.equal(sampled,false);
});

test('oversized meshes fail preflight before loading DEM or allocating the surface template',async()=>{
  let called=false;
  await assert.rejects(generateTerrain({gpxXml,options:{gridColumns:513,widthMm:120,heightMm:120},loadDem:async()=>{
    called=true;return {sample:()=>100,metadata:{}};
  }}),(error:unknown)=>error instanceof TerrainError&&error.code==='MESH_TOO_COMPLEX');
  assert.equal(called,false);
});
