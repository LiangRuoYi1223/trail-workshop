import {prepareBaseText} from './base-text-font.mjs';
import {publicError} from './files.mjs';

/** Read local glyphs and reuse printable placement before any DEM/imagery fetch. */
export async function createBaseTextPreview(core,frame,outlineMm,options){
  if(!options.textEnabled||!options.baseText.trim())return undefined;
  try{
    const prepared=await prepareBaseText(options.baseText,options.baseTextSizeMm);
    const layout=core.prepareTextLayout({...options,baseTextContours:prepared.contours,baseTextFontIdentity:prepared.fontIdentity},outlineMm.map(p=>({X:p.x*100000,Y:p.y*100000})),options.frameWidthMm);
    const geo=p=>frame.mmToGeo(p.x,p.y);
    const report=layout.report,contoursMm=report.contours;
    const edgeCentersMm=report.edgeCentersMm;
    return{contoursMm,contoursGeo:contoursMm.map(c=>({outer:c.outer.map(geo),holes:c.holes.map(r=>r.map(geo))})),
      outlineMm:layout.outlineMm,outlineGeo:layout.outlineMm.map(geo),anchorMm:report.anchorMm,anchorGeo:geo(report.anchorMm),
      rotationDeg:report.rotationDeg,effectiveFrameWidthMm:layout.effectiveFrameWidthMm,
      edgeCentersMm,edgeCentersGeo:edgeCentersMm.map(geo)};
  }catch(error){return{error:publicError(error,'文字预览暂时不可用，请检查文字与字号').message};}
}
