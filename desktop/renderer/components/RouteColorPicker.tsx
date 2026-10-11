import { useEffect, useId, useRef, useState } from 'react';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, type Hsv, type Rgb } from '../route-color';

export default function RouteColorPicker({ value, onChange, disabled }: { value:string; onChange(value:string):void; disabled:boolean }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value)));
  const [draft, setDraft] = useState(() => Object.fromEntries(Object.entries(hexToRgb(value)).map(([key,n])=>[key,String(n)])) as Record<keyof Rgb,string>);
  const activePointer = useRef<number | null>(null);
  const id = useId(), rgb = hexToRgb(value);
  useEffect(() => {
    const next = rgbToHsv(hexToRgb(value));
    setHsv(previous => ({ ...next, h:next.s && next.v ? next.h : previous.h, s:next.v ? next.s : previous.s }));
    setDraft({ r:String(hexToRgb(value).r), g:String(hexToRgb(value).g), b:String(hexToRgb(value).b) });
  }, [value]);
  const change = (next:Hsv) => { setHsv(next); onChange(rgbToHex(hsvToRgb(next))); };
  const move = (element:HTMLDivElement, clientX:number, clientY:number) => {
    const box=element.getBoundingClientRect(), x=(clientX-box.left-box.width/2)/(box.width/2), y=(clientY-box.top-box.height/2)/(box.height/2);
    change({ ...hsv, h:Math.hypot(x,y)<.01 ? hsv.h : (Math.atan2(-y,x)*180/Math.PI+360)%360, s:Math.min(1,Math.hypot(x,y)) });
  };
  const invalid = (key:keyof Rgb) => draft[key] === '' || !Number.isInteger(Number(draft[key])) || Number(draft[key])<0 || Number(draft[key])>255;
  const hasInvalid = (['r','g','b'] as const).some(invalid);
  const angle=hsv.h*Math.PI/180;
  return <fieldset className="route-color-picker" disabled={disabled}>
    <legend>路线颜色</legend>
    <div className="color-picker-heading"><span className="color-swatch" style={{ background:value }} aria-hidden="true" /><output aria-label="当前路线颜色">{value.toUpperCase()}</output></div>
    <div className="color-wheel" role="slider" tabIndex={disabled ? -1 : 0} aria-label="路线色盘；左右键调整色相，上下键调整饱和度" aria-disabled={disabled}
      aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} aria-valuetext={`色相 ${Math.round(hsv.h)} 度，饱和度 ${Math.round(hsv.s*100)}%`}
      onPointerDown={event=>{if(disabled || event.button!==0)return;event.preventDefault();event.currentTarget.focus();activePointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);move(event.currentTarget,event.clientX,event.clientY);}}
      onPointerMove={event=>{if(!disabled && activePointer.current===event.pointerId)move(event.currentTarget,event.clientX,event.clientY);}}
      onPointerUp={event=>{if(activePointer.current===event.pointerId){activePointer.current=null;event.currentTarget.releasePointerCapture(event.pointerId);}}}
      onLostPointerCapture={()=>{activePointer.current=null;}}
      onKeyDown={event=>{if(disabled || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();
        const step=event.shiftKey?10:1;change({ ...hsv, h:(hsv.h+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0)+360)%360,
          s:event.key==='Home'?0:event.key==='End'?1:Math.max(0,Math.min(1,hsv.s+(event.key==='ArrowUp'?step/100:event.key==='ArrowDown'?-step/100:0))) });}}
      style={{ backgroundImage:`linear-gradient(rgba(0,0,0,${1-hsv.v}),rgba(0,0,0,${1-hsv.v})), radial-gradient(circle, #fff 0%, transparent 70.7%), conic-gradient(from 90deg, #f00, #f0f, #00f, #0ff, #0f0, #ff0, #f00)` }}>
      <span className="color-wheel-handle" style={{ left:`${50+Math.cos(angle)*hsv.s*50}%`, top:`${50-Math.sin(angle)*hsv.s*50}%`, background:value }} />
    </div>
    <div className="color-brightness"><label htmlFor={`${id}-brightness`}>明度 <output>{Math.round(hsv.v*100)}%</output></label>
      <input id={`${id}-brightness`} type="range" min={0} max={100} value={Math.round(hsv.v*100)} aria-label="路线颜色明度" onChange={event=>change({ ...hsv, v:Number(event.currentTarget.value)/100 })}
        style={{ background:`linear-gradient(to right, #000, ${rgbToHex(hsvToRgb({...hsv,v:1}))})` }} /></div>
    <div className="rgb-fields">{(['r','g','b'] as const).map(key=><div key={key} className="rgb-field"><label htmlFor={`${id}-${key}`}>{key.toUpperCase()}</label>
      <input id={`${id}-${key}`} type="number" min={0} max={255} step={1} value={draft[key]} aria-label={`路线颜色 ${key.toUpperCase()}`} aria-invalid={invalid(key)} aria-describedby={`${id}-rgb-hint`}
        onChange={event=>{const text=event.currentTarget.value;setDraft(previous=>({...previous,[key]:text}));const n=Number(text);if(text!==''&&Number.isInteger(n)&&n>=0&&n<=255)onChange(rgbToHex({...rgb,[key]:n}));}}
        onBlur={()=>{if(invalid(key))setDraft(previous=>({...previous,[key]:String(rgb[key])}));}} />
      <output>{(rgb[key]/255*100).toFixed(1)}%</output></div>)}</div>
    <p id={`${id}-rgb-hint`} className={`field-hint${hasInvalid?' color-input-error':''}`}>{hasInvalid?'RGB 请输入 0–255 的整数。':'RGB 0–255 · 下方为各通道强度百分比'}</p>
  </fieldset>;
}
