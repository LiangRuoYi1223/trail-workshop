import {useState} from 'react';
import RouteColorPicker from './RouteColorPicker';
import {editablePrintColor,editPrintColor,printRoleEnabled,reusePrintColor,togglePrintRole,plannedPrintPaletteCount,type PrintRole} from '../route-color';
import type {ModelOptions} from '../types';
const roles:PrintRole[]=['grass','rock','snow','route','base','text'];
const names:Record<PrintRole,string>={grass:'草地',rock:'山石',snow:'白雪',route:'路线',base:'底座',text:'文字'};
export default function SharedPrintColors({options,onChange,disabled,count,stale=false}:{options:ModelOptions;onChange(options:ModelOptions):void;disabled:boolean;count?:number;stale?:boolean}) {
 const [selected,setSelected]=useState<PrintRole>('route');
 const active=selected!=='snow'&&printRoleEnabled(options,selected)?selected:options.grassEnabled?'grass':'rock';
 const value=editablePrintColor(options,active);
 const baseSource=options.baseColorSource==='grass'?options.grassEnabled?'草地':'山体':options.rockEnabled?'山石':'山体';
 const linked=active==='base'&&options.baseColorSource!=='custom'?'随'+baseSource+'配色变化':active==='text'&&options.textColorSource!=='custom'?'随路线变化':'';
 return <div className="shared-print-colors">
  <div className="shared-color-summary"><strong>共用颜色盘</strong><span>{count===undefined?'预计':stale?'此前模型':'模型实际'} {count??plannedPrintPaletteCount(options)} 色</span></div>
  <p className="field-hint shared-color-intro">勾选要打印的部分，点色块调色。同色合并计数。</p>
  <div className="print-role-list">{roles.map(role=>{
   const enabled=printRoleEnabled(options,role);
   const compulsory=role==='base'||role==='grass'&&!options.rockEnabled||role==='rock'&&!options.grassEnabled;
   const color=editablePrintColor(options,role);
   return <div key={role} className={'print-role-row'+(!enabled?' role-off':'')+(active===role?' role-editing':'')}>
    <label className="checkbox-field" htmlFor={role+'-enabled'}><input id={role+'-enabled'} type="checkbox" checked={enabled} disabled={disabled||compulsory} onChange={event=>onChange(togglePrintRole(options,role,event.currentTarget.checked))} />{names[role]}</label>
    {role==='snow'?<span className="fixed-print-color"><i style={{background:'#ffffff'}} aria-hidden="true" />固定白色</span>:<button type="button" className="print-role-color" aria-label={'编辑'+names[role]+'颜色'} aria-pressed={active===role} disabled={disabled||!enabled} onClick={()=>setSelected(role)} title={color.toUpperCase()}><i style={{background:color}} aria-hidden="true" /><span>{role==='base'&&options.baseColorSource!=='custom'?'同'+baseSource:role==='text'&&options.textColorSource!=='custom'?'同路线':color.toUpperCase()}</span></button>}
   </div>;
  })}</div>
  <p className="field-hint role-selection-hint">草地、山石至少选一项；只选一项时统一山体配色。底座始终打印。</p>
  <RouteColorPicker key={active} label={names[active]+'颜色'} value={value} onChange={color=>onChange(editPrintColor(options,active,color))} disabled={disabled} />
  {linked&&<p className="shared-color-link">{names[active]}{linked}；调色后改为自定义。</p>}
  <div className="reuse-print-colors"><span>复用已选颜色</span><div>{roles.filter(role=>role!==active&&printRoleEnabled(options,role)).map(role=><button key={role} type="button" disabled={disabled} aria-label={names[active]+'复用'+names[role]+'颜色'} title={names[role]+' '+editablePrintColor(options,role).toUpperCase()} onClick={()=>onChange(reusePrintColor(options,active,role))}><i style={{background:editablePrintColor(options,role)}} aria-hidden="true" />{names[role]}</button>)}</div></div>
  {(!options.routeEnabled||!options.textEnabled)&&<p className="field-hint optional-role-hint">{!options.routeEnabled?'路线未选：不生成凸起路线，地图仍保留取景路线。':''}{!options.routeEnabled&&!options.textEnabled?' ':''}{!options.textEnabled?'文字未选：不生成凸字，保留输入。':''}</p>}
 </div>;
}
