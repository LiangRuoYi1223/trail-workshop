import { createHash } from 'node:crypto';
import type { AppearanceOptions, ColorImageMetadata, FaceClass, ModelAppearance, PaletteEntry } from './types.js';

export class AppearanceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AppearanceError'; }
}
const classes = new Set<FaceClass>(['grass','rock','snow','route','base','text']);
const defaults: AppearanceOptions = {maxColors:3,grassColor:'#799278',rockColor:'#a9aa92',routeColor:'#c84832',baseColorSource:'rock',baseColor:'#a9aa92',textColorSource:'route',textColor:'#c84832'};
const hex = /^#[0-9a-f]{6}$/i;
const sha256 = /^[0-9a-f]{64}$/;
function invalid(message: string): never { throw new AppearanceError('APPEARANCE_INVALID',message); }

export function validateAppearanceOptions(options?: Partial<AppearanceOptions>): AppearanceOptions {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
    throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','配色设置必须为有效对象');
  const out = {...defaults,...options};
  if (out.maxColors !== 1 && out.maxColors !== 2 && out.maxColors !== 3 && out.maxColors !== 4 && out.maxColors !== 5 && out.maxColors !== 6)
    throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','打印颜色上限须为 1–6');
  for (const key of ['grassEnabled','rockEnabled'] as const) {
    if(out[key]!==undefined&&typeof out[key]!=='boolean')throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','地表颜色开关须为布尔值');
  }
  if(out.grassEnabled===false&&out.rockEnabled===false)throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','草地与山石须至少选择一项');
  for (const key of ['grassColor','rockColor','routeColor','baseColor','textColor'] as const) {
    if (typeof out[key] !== 'string' || !hex.test(out[key]))
      throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','代表颜色须为有效的六位 RGB 颜色');
    out[key] = out[key].toLowerCase();
  }
  if(!['grass','rock','custom'].includes(out.baseColorSource??''))throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','底座颜色来源无效');
  if(!['route','custom'].includes(out.textColorSource??''))throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','文字颜色来源无效');
  return {maxColors:out.maxColors,...(out.grassEnabled!==undefined?{grassEnabled:out.grassEnabled}:{}),...(out.rockEnabled!==undefined?{rockEnabled:out.rockEnabled}:{}),grassColor:out.grassColor,rockColor:out.rockColor,routeColor:out.routeColor,baseColorSource:out.baseColorSource,baseColor:out.baseColor,textColorSource:out.textColorSource,textColor:out.textColor};
}

export function classColor(kind: FaceClass, options: AppearanceOptions): string {
  if(kind==='base')return options.baseColorSource==='custom'?(options.baseColor??defaults.baseColor!):classColor(options.baseColorSource==='grass'?'grass':'rock',options);
  if(kind==='text')return options.textColorSource==='custom'?(options.textColor??defaults.textColor!):options.routeColor;
  if(kind==='snow')return '#ffffff';
  if(kind==='route')return options.routeColor;
  if(options.grassEnabled===false)return options.rockColor;
  if(options.rockEnabled===false)return options.grassColor;
  const legacySingleColor=options.grassEnabled===undefined&&options.rockEnabled===undefined&&options.maxColors===2;
  return kind==='grass'||legacySingleColor?options.grassColor:options.rockColor;
}

/** This canonical order is shared by preview persistence and exporters. */
function canonicalSource(source: ColorImageMetadata): ColorImageMetadata {
  return {sha256:source.sha256,byteLength:source.byteLength,width:source.width,height:source.height,
    bounds:{west:source.bounds.west,south:source.bounds.south,east:source.bounds.east,north:source.bounds.north},
    crs:source.crs,pixelIsArea:source.pixelIsArea,...(source.nodata === undefined ? {} : {nodata:source.nodata})};
}
export function modelAppearanceHash(appearance: Omit<ModelAppearance,'hash'>): string {
  const {options} = appearance;
  const value = {schemaVersion:appearance.schemaVersion,faceClasses:appearance.faceClasses,faceMaterials:appearance.faceMaterials,
    palette:appearance.palette.map(entry => ({id:entry.id,name:entry.name,color:entry.color})),
    options:{maxColors:options.maxColors,...(options.grassEnabled!==undefined?{grassEnabled:options.grassEnabled}:{}),...(options.rockEnabled!==undefined?{rockEnabled:options.rockEnabled}:{}),grassColor:options.grassColor,rockColor:options.rockColor,routeColor:options.routeColor,
      ...(options.baseColorSource!==undefined?{baseColorSource:options.baseColorSource}:{}),...(options.baseColor!==undefined?{baseColor:options.baseColor}:{}),
      ...(options.textColorSource!==undefined?{textColorSource:options.textColorSource}:{}),...(options.textColor!==undefined?{textColor:options.textColor}:{})},
    ...(appearance.source ? {source:canonicalSource(appearance.source)} : {}),classification:appearance.classification};
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validateColorImageMetadata(source: ColorImageMetadata): void {
  if (!source || typeof source !== 'object' || !sha256.test(source.sha256)
    || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > 64*1024*1024
    || !Number.isSafeInteger(source.width) || source.width < 1 || !Number.isSafeInteger(source.height) || source.height < 1
    || source.width*source.height > 16777216 || !['EPSG:4326','EPSG:3857'].includes(source.crs)
    || typeof source.pixelIsArea !== 'boolean') invalid('地表影像来源外观元数据无效');
  const b = source.bounds;
  if (!b || ![b.west,b.south,b.east,b.north].every(Number.isFinite)
    || b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90 || b.east < b.west || b.north < b.south
    || (source.nodata !== undefined && !Number.isFinite(source.nodata))) invalid('地表影像来源外观范围无效');
}

export function createAppearance(faceClasses: FaceClass[], options: AppearanceOptions,
  classification: ModelAppearance['classification'], source?: ColorImageMetadata): ModelAppearance {
  const palette: PaletteEntry[] = [], materialByColor = new Map<string,number>();
  const names: Record<FaceClass,string> = {grass:'草地',rock:'山石',snow:'白雪',route:'路线',base:'底座',text:'文字'};
  const faceMaterials = faceClasses.map(kind => {
    const color = classColor(kind,options);
    let index = materialByColor.get(color);
    if (index === undefined) {index=palette.length;materialByColor.set(color,index);palette.push({id:kind,name:names[kind],color});}
    return index;
  });
  if(palette.length>options.maxColors)throw new AppearanceError('APPEARANCE_OPTIONS_INVALID','实际颜色超出所选预算，请提高颜色预算或使用颜色联动');
  const value: Omit<ModelAppearance,'hash'> = {schemaVersion:1,faceClasses:[...faceClasses],faceMaterials,palette,options:{...options},
    ...(source ? {source:canonicalSource(source)} : {}),classification};
  return {...value,hash:modelAppearanceHash(value)};
}

export function validateModelAppearance(appearance: ModelAppearance, triangleCount: number): void {
  if (!appearance || typeof appearance !== 'object' || appearance.schemaVersion !== 1) invalid('外观版本或对象无效');
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 1 || !Array.isArray(appearance.faceClasses)
    || !Array.isArray(appearance.faceMaterials) || appearance.faceClasses.length !== triangleCount
    || appearance.faceMaterials.length !== triangleCount) invalid('外观面数与网格面数不匹配');
  const options = validateAppearanceOptions(appearance.options);
  if (!appearance.options || (['maxColors','grassColor','rockColor','routeColor'] as const).some(key=>appearance.options[key]!==options[key]) || Object.keys(appearance.options).some(key => options[key as keyof AppearanceOptions] !== appearance.options[key as keyof AppearanceOptions]))
    invalid('外观配色设置未归一化');
  if (!Array.isArray(appearance.palette) || appearance.palette.length < 1 || appearance.palette.length > options.maxColors)
    invalid('外观调色板超出颜色预算');
  const colors = new Set<string>(), ids = new Set<FaceClass>();
  for (const entry of appearance.palette) {
    if (!entry || !classes.has(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.color !== 'string' || !hex.test(entry.color) || entry.color !== entry.color.toLowerCase()
      || colors.has(entry.color) || entry.color !== classColor(entry.id,options)) invalid('外观调色板材质无效或颜色重复');
    colors.add(entry.color);ids.add(entry.id);
  }
  const used = new Set<number>();
  for (let i=0;i<triangleCount;i++) {
    const kind = appearance.faceClasses[i], material = appearance.faceMaterials[i];
    if (!classes.has(kind)) invalid('外观面分类无效');
    if (!Number.isSafeInteger(material) || material < 0 || material >= appearance.palette.length
      || appearance.palette[material].color !== classColor(kind,options)) invalid('外观面材质与分类配色不匹配');
    used.add(material);
  }
  if (used.size !== appearance.palette.length) invalid('外观调色板含未使用材质');
  if (appearance.classification === 'rgb-greenness') {
    if (!appearance.source) invalid('真实影像外观分类缺少来源');
    validateColorImageMetadata(appearance.source);
  } else if (appearance.classification !== 'uniform' || appearance.source !== undefined) invalid('外观分类与来源不一致');
  if (typeof appearance.hash !== 'string' || !sha256.test(appearance.hash) || appearance.hash !== modelAppearanceHash(appearance))
    invalid('外观哈希与当前配色内容不匹配');
}
