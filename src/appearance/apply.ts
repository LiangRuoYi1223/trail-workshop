import type { AppearanceMesh, AppearanceOptions, AppearanceSelection, ColorImage, ModelAppearance } from './types.js';
import { AppearanceError, createAppearance, validateAppearanceOptions, validateColorImageMetadata, validateModelAppearance } from './palette.js';
const R=6378137, RAD=Math.PI/180;

export function buildModelAppearance(mesh: AppearanceMesh, selection: AppearanceSelection,
  options: Partial<AppearanceOptions>, image?: ColorImage): ModelAppearance {
  const validated=validateAppearanceOptions(options);
  if (!mesh || !mesh.positions || !mesh.indices || mesh.positions.length < 9 || mesh.positions.length%3 !== 0
    || mesh.indices.length < 3 || mesh.indices.length%3 !== 0)
    throw new AppearanceError('APPEARANCE_MESH_INVALID','外观网格坐标或三角面无效');
  const count=mesh.indices.length/3;
  if (mesh.faceKinds !== undefined && mesh.faceKinds.length !== count)
    throw new AppearanceError('APPEARANCE_MESH_INVALID','外观网格面标签数量无效');
  for (const value of Array.from(mesh.positions)) if(!Number.isFinite(value))
    throw new AppearanceError('APPEARANCE_MESH_INVALID','外观网格含无效坐标');
  for (const index of Array.from(mesh.indices)) if(!Number.isSafeInteger(index) || index<0 || index>=mesh.positions.length/3)
    throw new AppearanceError('APPEARANCE_MESH_INVALID','外观网格含无效三角面索引');
  const center=selection?.center;
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon) || Math.abs(center.lat)>80 || Math.abs(center.lon)>180
    || !Number.isFinite(selection.bearingDeg) || !Number.isFinite(selection.mmPerMeter) || selection.mmPerMeter<=0)
    throw new AppearanceError('APPEARANCE_SELECTION_INVALID','外观取景的坐标、角度或比例无效');
  if (image) {
    validateColorImageMetadata(image.metadata);
    if (typeof image.sample !== 'function') throw new AppearanceError('APPEARANCE_IMAGE_COVERAGE','地表影像没有有效像元采样器');
  }
  const angle=selection.bearingDeg*RAD,c=Math.cos(angle),s=Math.sin(angle),cosLat=Math.cos(center.lat*RAD);
  const originX=R*center.lon*RAD,originY=R*Math.log(Math.tan(Math.PI/4+center.lat*RAD/2));
  const faceClasses: ModelAppearance['faceClasses']=[];
  for (let face=0;face<count;face++) {
    const kind=mesh.faceKinds?.[face] ?? 'terrain';
    if (kind==='route' || kind==='route-wall') {faceClasses.push('route');continue;}
    if (kind==='snow' || kind==='snow-wall') {faceClasses.push('snow');continue;}
    if (kind==='frame' || kind==='wall' || kind==='bottom') {faceClasses.push('rock');continue;}
    if (kind!=='terrain') throw new AppearanceError('APPEARANCE_MESH_INVALID','外观网格含无法识别的面标签');
    if (!image) {faceClasses.push('grass');continue;}
    let x=0,y=0;
    for(let corner=0;corner<3;corner++) {const offset=mesh.indices[face*3+corner]*3;x+=mesh.positions[offset]/3;y+=mesh.positions[offset+1]/3;}
    const gx=x/selection.mmPerMeter,gy=y/selection.mmPerMeter;
    const mx=originX+(c*gx+s*gy)/cosLat,my=originY+(-s*gx+c*gy)/cosLat;
    const lat=(2*Math.atan(Math.exp(my/R))-Math.PI/2)/RAD,lon=mx/R/RAD;
    const pixel=image.sample(lat,lon);
    if (!pixel || ![pixel.r,pixel.g,pixel.b].every(value=>Number.isInteger(value)&&value>=0&&value<=255))
      throw new AppearanceError('APPEARANCE_IMAGE_COVERAGE','地表影像未覆盖山体采样位置，或该位置没有有效像元');
    // Conservative RGB appearance heuristic; gray, shadow, soil and buildings are
    // grouped with the rock representative color. This is not land-cover mapping.
    const green=pixel.g>=40 && pixel.g-pixel.r>=15 && pixel.g-pixel.b>=10
      && pixel.g>=pixel.r*1.15 && pixel.g>=pixel.b*1.10;
    faceClasses.push(green?'grass':'rock');
  }
  return createAppearance(faceClasses,validated,image?'rgb-greenness':'uniform',image?.metadata);
}
export function recolorModelAppearance(appearance: ModelAppearance, options: Partial<AppearanceOptions>): ModelAppearance {
  validateModelAppearance(appearance,appearance?.faceClasses?.length);
  const validated=validateAppearanceOptions({...appearance.options,...options});
  return createAppearance(appearance.faceClasses,validated,appearance.classification,appearance.source);
}
