import ClipperLib from 'clipper-lib';
import {TerrainError} from '../errors.js';
import {precisePartition} from '../route/precise-partition.js';
import {SCALE,regionsAreaMm2,signedArea,type IntPoint,type PolygonRegion} from '../route/corridor.js';
import type {BaseTextContour,BaseTextFontIdentity} from '../types.js';
import type {BaseShape} from '../vendor/trailprint/types.js';
export const TEXT_RELIEF_MM=0.6;
const SAFE_MM=0.5,MAX_POINTS=20000;
export interface BaseTextLayoutInput {
  baseText?:string;baseTextSizeMm?:number;baseTextContours?:BaseTextContour[];baseTextFontIdentity?:BaseTextFontIdentity;
  baseTextAngleDeg?:number;baseTextEdgeIndex?:number;
  shape?:BaseShape;widthMm?:number;heightMm?:number;polygonSides?:number;cornerRadiusMm?:number;
}
export function validateBaseTextParameters(input:BaseTextLayoutInput) {
  const text=input.baseText??'',sizeMm=input.baseTextSizeMm??3;
  if(typeof text!=='string'||Array.from(text).length>32||/[\r\n\u0000-\u001f]/u.test(text))throw new TerrainError('CONFIG_INVALID','底座文字须为单行，最多 32 个 Unicode 字符');
  if(!Number.isFinite(sizeMm)||sizeMm<1.5||sizeMm>10)throw new TerrainError('CONFIG_INVALID','底座字号须在 1.5–10 mm 之间');
  const angle=input.baseTextAngleDeg??180,baseTextEdgeIndex=input.baseTextEdgeIndex??0;
  if(!Number.isFinite(angle)||angle<0||angle>360)throw new TerrainError('CONFIG_INVALID','圆形文字位置须在 0–360° 之间');
  if(!Number.isInteger(baseTextEdgeIndex)||baseTextEdgeIndex<0||baseTextEdgeIndex>7)throw new TerrainError('CONFIG_INVALID','多边形文字边编号须为 0–7 的整数');
  if(input.shape==='polygon') {
    const sides=input.polygonSides??6;
    if(!Number.isInteger(sides)||sides<3||sides>8)throw new TerrainError('CONFIG_INVALID','多边形边数须为 3–8 的整数');
    if(baseTextEdgeIndex>=sides)throw new TerrainError('CONFIG_INVALID','文字所选边编号必须小于多边形边数');
  }
  if(text.trim()&&(!Array.isArray(input.baseTextContours)||!input.baseTextContours.length))throw new TerrainError('CONFIG_INVALID','文字缺少可用字形轮廓，请检查字体是否支持这些字');
  return{text,sizeMm,baseTextAngleDeg:angle===360?0:angle,baseTextEdgeIndex};
}
/** Places one straight glyph line outside the actual footprint; all coordinates are model millimetres. */
export function prepareTextLayout(input:BaseTextLayoutInput,inner:IntPoint[],requestedFrameWidthMm:number){
  const {text,sizeMm,baseTextAngleDeg,baseTextEdgeIndex}=validateBaseTextParameters(input);
  const invalid=(message:string):never=>{throw new TerrainError('CONFIG_INVALID',message);};
  const asMm=(path:IntPoint[])=>path.map(p=>({x:p.X/SCALE,y:p.Y/SCALE}));
  const expand=(width:number):IntPoint[][]=>{
    if(width===0)return[inner];
    const offset=new ClipperLib.ClipperOffset(2,0.01*SCALE);
    offset.AddPath(ClipperLib.Clipper.CleanPolygon(inner.map(p=>({X:Math.round(p.X),Y:Math.round(p.Y)})),4),ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
    const paths:IntPoint[][]=[];offset.Execute(paths,width*SCALE);return paths;
  };
  const finalSize=(paths:IntPoint[][])=>{const all=paths.flat();return{width:(Math.max(...all.map(p=>p.X))-Math.min(...all.map(p=>p.X)))/SCALE,height:(Math.max(...all.map(p=>p.Y))-Math.min(...all.map(p=>p.Y)))/SCALE};};
  const shape=input.shape??'rectangle',sides=input.polygonSides??6;
  const rotationDeg=shape==='circle'?(180-baseTextAngleDeg+360)%360:shape==='polygon'?baseTextEdgeIndex*360/sides:0;
  const snap=(value:number)=>Math.abs(value)<1e-12?0:value;
  const rad=rotationDeg*Math.PI/180,t={x:snap(Math.cos(rad)),y:snap(Math.sin(rad))},n={x:t.y,y:-t.x};
  const support=Math.max(...inner.map(p=>(p.X*n.x+p.Y*n.y)/SCALE));
  const tangentCenter=shape==='rectangle'?(Math.min(...inner.map(p=>p.X))+Math.max(...inner.map(p=>p.X)))/SCALE/2:0;
  const edgeCentersMm=shape==='polygon'?Array.from({length:sides},(_,edge)=>{
    const a=edge*Math.PI*2/sides,outward={x:snap(Math.sin(a)),y:snap(-Math.cos(a))};
    const distance=input.widthMm===undefined?Math.max(...inner.map(p=>(p.X*outward.x+p.Y*outward.y)/SCALE)):input.widthMm/2*Math.cos(Math.PI/sides);
    return{x:outward.x*distance,y:outward.y*distance};
  }):[];
  const empty={text,sizeMm,reliefHeightMm:TEXT_RELIEF_MM,contours:[] as BaseTextContour[],requestedFrameWidthMm,effectiveFrameWidthMm:requestedFrameWidthMm,safetyMarginMm:SAFE_MM,areaMm2:0,volumeMm3:0,finalSizeMm:{width:0,height:0},anchorMm:{x:0,y:0},rotationDeg,baseTextAngleDeg,baseTextEdgeIndex,edgeCentersMm};
  if(!text.trim()){
    const expanded=expand(requestedFrameWidthMm);
    return{regions:[] as PolygonRegion[],effectiveFrameWidthMm:requestedFrameWidthMm,outlineMm:asMm(expanded[0]??inner),report:{...empty,finalSizeMm:finalSize(expanded)}};
  }
  const contours=input.baseTextContours;
  if(!Array.isArray(contours)||!contours.length)invalid('文字缺少可用字形轮廓，请检查字体是否支持这些字');
  let count=0;const pts:Array<{x:number;y:number}>=[];
  for(const contour of contours!){if(!contour||!Array.isArray(contour.outer)||!Array.isArray(contour.holes))invalid('文字轮廓无效');for(const ring of [contour.outer,...contour.holes]){if(!Array.isArray(ring)||ring.length<3)invalid('文字轮廓无效');for(const p of ring){if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1000||Math.abs(p.y)>1000)invalid('文字轮廓坐标无效');pts.push(p);if(++count>MAX_POINTS)invalid('文字轮廓过于复杂，请缩短文字');}}}
  const minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x)),minY=Math.min(...pts.map(p=>p.y)),maxY=Math.max(...pts.map(p=>p.y));
  const centerX=(minX+maxX)/2,centerY=(minY+maxY)/2,outwardDistance=support+SAFE_MM+2/SCALE+(maxY-minY)/2;
  const anchorMm={x:t.x*tangentCenter+n.x*outwardDistance,y:t.y*tangentCenter+n.y*outwardDistance};
  const transform=(p:{x:number;y:number})=>({x:anchorMm.x+t.x*(p.x-centerX)-n.x*(p.y-centerY),y:anchorMm.y+t.y*(p.x-centerX)-n.y*(p.y-centerY)});
  const placed=contours!.map(c=>({outer:c.outer.map(transform),holes:c.holes.map(r=>r.map(transform))}));
  const orient=(ring:Array<{x:number;y:number}>,outer:boolean)=>{const path=ring.map(p=>({X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)}));return (signedArea(path)>0)===outer?path:path.reverse();};
  const regions=placed.map(c=>({outer:orient(c.outer,true),holes:c.holes.map(r=>orient(r,false))}));
  const safeOffset=new ClipperLib.ClipperOffset(2,0.005*SCALE);for(const r of regions){const outer=ClipperLib.Clipper.Orientation(r.outer)?r.outer:r.outer.slice().reverse();safeOffset.AddPath(outer,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);}
  const safe:IntPoint[][]=[];safeOffset.Execute(safe,SAFE_MM*SCALE);const safeRegions=safe.map(outer=>({outer,holes:[]}));
  let effectiveFrameWidthMm=Math.max(requestedFrameWidthMm,maxY-minY+SAFE_MM*2+2/SCALE);let expanded:IntPoint[][]=[];
  for(;;){if(effectiveFrameWidthMm>20+1e-8)invalid('底座外沿最多 20 mm，不能容纳文字；请缩短文字、减小字号或增大模型');expanded=expand(effectiveFrameWidthMm);const supported=precisePartition(expanded.map(outer=>({outer,holes:[]})),[{outer:inner,holes:[]}],'difference');if(regionsAreaMm2(precisePartition(safeRegions,supported,'difference'))<1e-7)break;if(effectiveFrameWidthMm>=20)invalid('底座外沿最多 20 mm，不能容纳文字；请缩短文字、减小字号或增大模型');effectiveFrameWidthMm=Math.min(20,effectiveFrameWidthMm+0.25);}
  const areaMm2=regionsAreaMm2(regions);if(!(areaMm2>0))invalid('文字没有可打印的字形面积');
  return{regions,effectiveFrameWidthMm,outlineMm:asMm(expanded[0]??inner),report:{...empty,anchorMm,contours:regions.map(r=>({outer:asMm(r.outer),holes:r.holes.map(asMm)})),effectiveFrameWidthMm,areaMm2,volumeMm3:areaMm2*TEXT_RELIEF_MM,finalSizeMm:finalSize(expanded)}};
}
