import type { AppearanceMesh, AppearanceOptions, AppearanceSelection, ColorImage, GrassContinuityMask, ModelAppearance } from './types.js';
import { AppearanceError, createAppearance, validateAppearanceOptions, validateColorImageMetadata, validateModelAppearance } from './palette.js';
import { createGrassContinuityMask, createGrassPixelClassifier, createModelColorSampler, isProtectedContinuityPixel,
  isValidColorPixel, validateAppearanceMeshSelection, validateGrassContinuity } from './grass-continuity.js';

export function buildModelAppearance(mesh: AppearanceMesh, selection: AppearanceSelection,
  options: Partial<AppearanceOptions>, image?: ColorImage, grassSensitivity = 50, grassContinuity = 0,
  sharedGrassMask?: GrassContinuityMask): ModelAppearance {
  const validated=validateAppearanceOptions(options);
  const isGrass=createGrassPixelClassifier(grassSensitivity);
  validateGrassContinuity(grassContinuity);
  validateAppearanceMeshSelection(mesh,selection);
  const count=mesh.indices.length/3;
  if (image) {
    validateColorImageMetadata(image.metadata);
    if (typeof image.sample !== 'function') throw new AppearanceError('APPEARANCE_IMAGE_COVERAGE','地表影像没有有效像元采样器');
  }
  const sample=image ? createModelColorSampler(selection,image) : undefined;
  const grassMask=image && grassContinuity>0 ? sharedGrassMask ??
    (!mesh.faceKinds || mesh.faceKinds.includes('terrain') ? createGrassContinuityMask(mesh,selection,image,grassSensitivity,grassContinuity) : undefined) : undefined;
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
    const pixel=sample!(x,y);
    if (!isValidColorPixel(pixel))
      throw new AppearanceError('APPEARANCE_IMAGE_COVERAGE','地表影像未覆盖山体采样位置，或该位置没有有效像元');
    // Conservative RGB appearance heuristic; gray, shadow, soil and buildings are
    // grouped with the rock representative color. This is not land-cover mapping.
    const green=isGrass(pixel);
    faceClasses.push(green || (!isProtectedContinuityPixel(pixel) && grassMask?.shouldFill(x,y)) ? 'grass' : 'rock');
  }
  return createAppearance(faceClasses,validated,image?'rgb-greenness':'uniform',image?.metadata);
}
export function recolorModelAppearance(appearance: ModelAppearance, options: Partial<AppearanceOptions>): ModelAppearance {
  validateModelAppearance(appearance,appearance?.faceClasses?.length);
  const validated=validateAppearanceOptions({...appearance.options,...options});
  return createAppearance(appearance.faceClasses,validated,appearance.classification,appearance.source);
}
