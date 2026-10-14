export interface Rgb { r: number; g: number; b: number }
export interface Hsv { h: number; s: number; v: number }
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function hexToRgb(hex: string): Rgb {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error('请选择有效的路线颜色。');
  return { r:parseInt(hex.slice(1,3),16), g:parseInt(hex.slice(3,5),16), b:parseInt(hex.slice(5,7),16) };
}
export function rgbToHex(rgb: Rgb): string {
  const channels = [rgb.r, rgb.g, rgb.b];
  if (channels.some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw new Error('RGB 须为 0–255 的数值。');
  return '#' + channels.map(value => Math.round(value).toString(16).padStart(2,'0')).join('');
}
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min;
  let h = !delta ? 0 : max === r ? (g-b)/delta : max === g ? 2+(b-r)/delta : 4+(r-g)/delta;
  h = (h*60+360)%360;
  return { h, s:max ? delta/max : 0, v:max };
}
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  h = ((h%360)+360)%360/60; s = clamp(s); v = clamp(v);
  const c = v*s, x = c*(1-Math.abs(h%2-1)), m = v-c;
  const channels = h<1 ? [c,x,0] : h<2 ? [x,c,0] : h<3 ? [0,c,x] : h<4 ? [0,x,c] : h<5 ? [x,0,c] : [c,0,x];
  return { r:Math.round((channels[0]+m)*255), g:Math.round((channels[1]+m)*255), b:Math.round((channels[2]+m)*255) };
}
export function wheelColor(x: number, y: number, value: number): string {
  return rgbToHex(hsvToRgb({ h:(Math.atan2(-y,x)*180/Math.PI+360)%360, s:Math.min(1,Math.hypot(x,y)), v:value }));
}
export type PrintRole = 'grass'|'rock'|'snow'|'route'|'base'|'text';
export interface PrintColors {
  maxColors:1|2|3|4|5|6; grassColor:string; rockColor:string; routeColor:string;
  grassEnabled?:boolean; rockEnabled?:boolean;
  baseColorSource?:'grass'|'rock'|'custom'; baseColor?:string;
  textColorSource?:'route'|'custom'; textColor?:string;
}
export interface PrintRoleOptions extends PrintColors { routeEnabled?:boolean; textEnabled?:boolean; snowEnabled?:boolean; baseText?:string }
export function geometryOptions<T extends Partial<PrintColors>>(options:T):Omit<T,keyof PrintColors> {
  const {routeColor,grassColor,rockColor,maxColors,grassEnabled,rockEnabled,baseColorSource,baseColor,textColorSource,textColor,...geometry}=options;
  return geometry;
}
export function appearanceOptions(options:PrintColors):PrintColors {
  const {maxColors,grassColor,rockColor,routeColor,grassEnabled,rockEnabled,baseColorSource,baseColor,textColorSource,textColor}=options;
  return {maxColors,grassColor,rockColor,routeColor,...(grassEnabled===undefined?{}:{grassEnabled}),...(rockEnabled===undefined?{}:{rockEnabled}),baseColorSource,baseColor,textColorSource,textColor};
}
export function appearanceColor(faceClass:string, options:PrintColors):string {
  const singleGrass=options.rockEnabled===false || (options.grassEnabled===undefined && options.rockEnabled===undefined && options.maxColors===2);
  const terrain=(role:'grass'|'rock')=>options.grassEnabled===false?options.rockColor:singleGrass?options.grassColor:role==='grass'?options.grassColor:options.rockColor;
  if(faceClass==='snow')return '#ffffff';
  if(faceClass==='text')return options.textColorSource==='custom' ? options.textColor??options.routeColor : options.routeColor;
  if(faceClass==='base')return options.baseColorSource==='custom' ? options.baseColor??terrain('rock') : terrain(options.baseColorSource==='grass'?'grass':'rock');
  return faceClass==='route' ? options.routeColor : terrain(faceClass==='grass'?'grass':'rock');
}
export function printPaletteCount(classes:readonly string[],options:PrintColors):number {
  return new Set(classes.map(role=>appearanceColor(role,options).toLowerCase())).size;
}
export function printRoleEnabled(options:PrintRoleOptions,role:PrintRole):boolean {
  if(role==='base')return true;
  if(role==='snow')return options.snowEnabled??false;
  if(role==='text')return options.textEnabled??!!options.baseText;
  return options[(role+'Enabled') as 'grassEnabled'|'rockEnabled'|'routeEnabled']??true;
}
export function togglePrintRole<T extends PrintRoleOptions>(options:T,role:PrintRole,enabled:boolean):T {
  if(role==='base' || (!enabled && role==='grass' && !printRoleEnabled(options,'rock')) || (!enabled && role==='rock' && !printRoleEnabled(options,'grass')))return options;
  return {...options,[role+'Enabled']:enabled};
}
export function editablePrintColor(options:PrintColors,role:PrintRole):string {
  return role==='grass'?options.grassColor:role==='rock'?options.rockColor:appearanceColor(role,options);
}
export function editPrintColor<T extends PrintColors>(options:T,role:PrintRole,value:string):T {
  if(role==='snow')return options;
  hexToRgb(value);
  return {...options,[role+'Color']:value,...(role==='base'?{baseColorSource:'custom'}:role==='text'?{textColorSource:'custom'}:{})};
}
export function reusePrintColor<T extends PrintColors>(options:T,target:PrintRole,source:PrintRole):T {
  if(target==='snow' || target===source)return options;
  if(target==='base' && (source==='grass'||source==='rock'))return {...options,baseColorSource:source};
  if(target==='text' && source==='route')return {...options,textColorSource:'route'};
  return editPrintColor(options,target,appearanceColor(source,options));
}
export function plannedPrintPaletteCount(options:PrintRoleOptions):number {
  const roles:PrintRole[]=['grass','rock','snow','route','base','text'];
  return printPaletteCount(roles.filter(role=>printRoleEnabled(options,role)&&(role!=='text'||!!options.baseText?.trim())),options);
}

export function previewPrintClasses(preview:{appearance?:{faceClasses:readonly PrintRole[]};mesh:{faceClasses?:readonly PrintRole[];faceKinds?:readonly string[];materialParts?:readonly {id:string;indices:readonly number[];faceClasses?:readonly PrintRole[]}[]}}):PrintRole[] {
  const classes=new Set<PrintRole>();
  const outerClasses=preview.appearance?.faceClasses??preview.mesh.faceClasses??[];
  for(const role of outerClasses)classes.add(role);
  if(!classes.size)for(const kind of preview.mesh.faceKinds??[])classes.add(kind==='terrain'?'grass':kind.startsWith('route')?'route':kind.startsWith('snow')?'snow':kind.startsWith('text')?'text':kind.startsWith('base')?'base':'rock');
  for(const part of preview.mesh.materialParts??[]) {
    if(!part.indices.length)continue;
    if(part.faceClasses?.length)for(const role of part.faceClasses)classes.add(role);
    else if(part.id==='terrain')classes.add('rock');
    else if(['snow','route','base','text'].includes(part.id))classes.add(part.id as PrintRole);
  }
  return Array.from(classes);
}
