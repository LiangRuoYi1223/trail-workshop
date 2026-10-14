import ClipperLib from 'clipper-lib';
import {TerrainError} from '../errors.js';
import {precisePartition} from '../route/precise-partition.js';
import {SCALE,regionsAreaMm2,signedArea,type IntPoint,type PolygonRegion} from '../route/corridor.js';
import type {BaseTextContour,BaseTextFontIdentity} from '../types.js';
export const TEXT_RELIEF_MM=0.6;
const SAFE_MM=0.5,MAX_POINTS=20000;
export function validateBaseTextParameters(input:{baseText?:string;baseTextSizeMm?:number;baseTextContours?:BaseTextContour[]}) {
  const text=input.baseText??'',sizeMm=input.baseTextSizeMm??3;
  if(typeof text!=='string'||Array.from(text).length>32||/[\r\n\u0000-\u001f]/u.test(text))throw new TerrainError('CONFIG_INVALID','底座文字须为单行，最多 32 个 Unicode 字符');
  if(!Number.isFinite(sizeMm)||sizeMm<1.5||sizeMm>10)throw new TerrainError('CONFIG_INVALID','底座字号须在 1.5–10 mm 之间');
  if(text.trim()&&(!Array.isArray(input.baseTextContours)||!input.baseTextContours.length))throw new TerrainError('CONFIG_INVALID','文字缺少可用字形轮廓，请检查字体是否支持这些字');
  return{text,sizeMm};
}
export function prepareTextLayout(input:{baseText?:string;baseTextSizeMm?:number;baseTextContours?:BaseTextContour[];baseTextFontIdentity?:BaseTextFontIdentity},inner:IntPoint[],requestedFrameWidthMm:number){
  const {text,sizeMm}=validateBaseTextParameters(input);
  const invalid=(message:string):never=>{throw new TerrainError('CONFIG_INVALID',message);};
  const empty={text,sizeMm,reliefHeightMm:TEXT_RELIEF_MM,contours:[] as BaseTextContour[],requestedFrameWidthMm,effectiveFrameWidthMm:requestedFrameWidthMm,safetyMarginMm:SAFE_MM,areaMm2:0,volumeMm3:0,finalSizeMm:{width:0,height:0}};
  if(!text.trim())return{regions:[] as PolygonRegion[],effectiveFrameWidthMm:requestedFrameWidthMm,report:empty};
  const contours=input.baseTextContours;
  if(!Array.isArray(contours)||!contours.length)invalid('文字缺少可用字形轮廓，请检查字体是否支持这些字');
  let count=0;const pts:Array<{x:number;y:number}>=[];
  for(const contour of contours!){if(!contour||!Array.isArray(contour.outer)||!Array.isArray(contour.holes))invalid('文字轮廓无效');for(const ring of [contour.outer,...contour.holes]){if(!Array.isArray(ring)||ring.length<3)invalid('文字轮廓无效');for(const p of ring){if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1000||Math.abs(p.y)>1000)invalid('文字轮廓坐标无效');pts.push(p);if(++count>MAX_POINTS)invalid('文字轮廓过于复杂，请缩短文字');}}}
  const minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x)),minY=Math.min(...pts.map(p=>p.y)),maxY=Math.max(...pts.map(p=>p.y));
  const sourceMinX=Math.min(...inner.map(p=>p.X))/SCALE,sourceMaxX=Math.max(...inner.map(p=>p.X))/SCALE,sourceMinY=Math.min(...inner.map(p=>p.Y))/SCALE;
  const dx=(sourceMinX+sourceMaxX-minX-maxX)/2,dy=sourceMinY-SAFE_MM-2/SCALE-maxY;
  const placed=contours!.map(c=>({outer:c.outer.map(p=>({x:p.x+dx,y:p.y+dy})),holes:c.holes.map(r=>r.map(p=>({x:p.x+dx,y:p.y+dy})))}));
  const orient=(ring:Array<{x:number;y:number}>,outer:boolean)=>{const path=ring.map(p=>({X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)}));return (signedArea(path)>0)===outer?path:path.reverse();};
  const regions=placed.map(c=>({outer:orient(c.outer,true),holes:c.holes.map(r=>orient(r,false))}));
  const safeOffset=new ClipperLib.ClipperOffset(2,0.005*SCALE);for(const r of regions){const outer=ClipperLib.Clipper.Orientation(r.outer)?r.outer:r.outer.slice().reverse();safeOffset.AddPath(outer,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);}
  const safe:IntPoint[][]=[];safeOffset.Execute(safe,SAFE_MM*SCALE);const safeRegions=safe.map(outer=>({outer,holes:[]}));
  let effectiveFrameWidthMm=Math.max(requestedFrameWidthMm,maxY-minY+SAFE_MM*2+2/SCALE);let expanded:IntPoint[][]=[];
  for(;;){if(effectiveFrameWidthMm>20+1e-8)invalid('底座外沿最多 20 mm，不能容纳文字；请缩短文字、减小字号或增大模型');const offset=new ClipperLib.ClipperOffset(2,0.01*SCALE);offset.AddPath(ClipperLib.Clipper.CleanPolygon(inner.map(p=>({X:Math.round(p.X),Y:Math.round(p.Y)})),4),ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);expanded=[];offset.Execute(expanded,effectiveFrameWidthMm*SCALE);const supported=precisePartition(expanded.map(outer=>({outer,holes:[]})),[{outer:inner,holes:[]}],'difference');if(regionsAreaMm2(precisePartition(safeRegions,supported,'difference'))<1e-7)break;if(effectiveFrameWidthMm>=20)invalid('底座外沿最多 20 mm，不能容纳文字；请缩短文字、减小字号或增大模型');effectiveFrameWidthMm=Math.min(20,effectiveFrameWidthMm+0.25);}
  const areaMm2=regionsAreaMm2(regions);if(!(areaMm2>0))invalid('文字没有可打印的字形面积');const all=expanded.flat();
  return{regions,effectiveFrameWidthMm,report:{...empty,contours:regions.map(r=>({outer:r.outer.map(p=>({x:p.X/SCALE,y:p.Y/SCALE})),holes:r.holes.map(h=>h.map(p=>({x:p.X/SCALE,y:p.Y/SCALE})))})),effectiveFrameWidthMm,areaMm2,volumeMm3:areaMm2*TEXT_RELIEF_MM,finalSizeMm:{width:(Math.max(...all.map(p=>p.X))-Math.min(...all.map(p=>p.X)))/SCALE,height:(Math.max(...all.map(p=>p.Y))-Math.min(...all.map(p=>p.Y)))/SCALE}}};
}
