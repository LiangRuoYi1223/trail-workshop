import {useId,useRef,useState} from 'react';
import {QUICK_START_STEPS,USAGE_GUIDE_SECTIONS} from '../usage-guide-content';

export default function UsageGuideButton(){
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const content=useRef<HTMLDivElement>(null),navigation=useRef<HTMLElement>(null);
  const [open,setOpen]=useState(false),[active,setActive]=useState('usage-start');
  const titleId=useId(),descriptionId=useId();
  const entries=[{id:'usage-start',title:'第一次使用'},...USAGE_GUIDE_SECTIONS.map(section=>({id:'usage-'+section.id,title:section.title}))];
  function show(){
    if(!dialog.current||dialog.current.open)return;
    dialog.current.showModal();setOpen(true);setActive('usage-start');
    if(content.current)content.current.scrollTop=0;
    if(navigation.current)navigation.current.scrollTop=0;
  }
  function navigate(id:string){
    const section=dialog.current?.querySelector<HTMLElement>('#'+CSS.escape(id));
    section?.scrollIntoView({block:'start',behavior:'auto'});
    section?.querySelector<HTMLElement>('h3')?.focus({preventScroll:true});setActive(id);
  }
  function updateActive(){
    if(!content.current)return;
    const top=content.current.getBoundingClientRect().top+30;
    const sections=Array.from(content.current.querySelectorAll<HTMLElement>('.usage-guide-section'));
    setActive(sections.filter(section=>section.getBoundingClientRect().top<=top).at(-1)?.id??'usage-start');
  }
  return <>
    <button id="usage-guide" type="button" className="usage-guide-button" ref={trigger} aria-haspopup="dialog"
      aria-controls="usage-guide-dialog" aria-expanded={open} onClick={show}>使用说明</button>
    <dialog id="usage-guide-dialog" className="usage-guide-dialog" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onClose={()=>{setOpen(false);trigger.current?.focus({preventScroll:true});}}
      onKeyDown={event=>{
        if(event.key!=='Tab')return;
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first=controls[0],last=controls.at(-1),focused=document.activeElement;
        if(!controls.includes(focused as HTMLButtonElement)||event.shiftKey&&focused===first||!event.shiftKey&&focused===last){
          event.preventDefault();(event.shiftKey?last:first)?.focus();
        }
      }}
      onClick={event=>{
        if(event.target!==event.currentTarget)return;
        const bounds=event.currentTarget.getBoundingClientRect();
        if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)event.currentTarget.close();
      }}>
      <header className="usage-guide-heading"><div><h2 id={titleId}>使用说明</h2><p id={descriptionId}>从导入路线到保存模型，按板块查看用途和操作。</p></div>
        <button id="usage-guide-close" type="button" autoFocus onClick={()=>dialog.current?.close()}>关闭说明</button>
      </header>
      <div className="usage-guide-body">
        <nav ref={navigation} className="usage-guide-nav" aria-label="使用说明目录"><p>目录</p>{entries.map(entry=><button type="button" key={entry.id}
          aria-controls={entry.id} aria-current={active===entry.id?'location':undefined} onClick={()=>navigate(entry.id)}>{entry.title}</button>)}</nav>
        <div ref={content} className="usage-guide-content" onScroll={updateActive}>
          <section id="usage-start" className="usage-guide-section"><h3 tabIndex={-1}>第一次使用</h3><p className="usage-guide-purpose">先完成一次完整流程，再根据预览微调尺寸、配色与文字。</p>
            <ol>{QUICK_START_STEPS.map(step=><li key={step}>{step}</li>)}</ol>
            <p className="usage-guide-note">几何、取景、文字位置或识别设置改变后，重新生成才能保存；改色可直接更新预览和下一次彩色导出。</p>
          </section>
          {USAGE_GUIDE_SECTIONS.map(section=><section key={section.id} id={'usage-'+section.id} className="usage-guide-section">
            <h3 tabIndex={-1}>{section.title}</h3><p className="usage-guide-purpose">{section.purpose}</p>
            <ol>{section.steps.map(step=><li key={step}>{step}</li>)}</ol>
            {section.notes?.map(note=><p key={note} className="usage-guide-note">{note}</p>)}
          </section>)}
        </div>
      </div>
    </dialog>
  </>;
}
