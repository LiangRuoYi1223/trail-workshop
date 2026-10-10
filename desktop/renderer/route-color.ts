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
export function geometryOptions<T extends { routeColor?: string }>(options: T): Omit<T,'routeColor'> {
  const { routeColor, ...geometry } = options;
  return geometry;
}
