import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {parse as parseOpenType} from 'three/examples/jsm/libs/opentype.module.js';
import ClipperLib from 'clipper-lib';

const FONT_FILES=Object.freeze([
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/NotoSansSC-Regular.ttf',
  'C:/Windows/Fonts/NotoSansSC-Regular.otf',
]);
const MAX_FONT_BYTES=32*1024*1024,MAX_VERTICES=20000,MAX_RINGS=512;
const FLATNESS_MM=.00499,INTEGER_SCALE=100000; // Leaves room for integer rounding within the 0.005 mm bound.
const loadedFonts=new Map();
const fail=(code,message,cause)=>{throw Object.assign(new Error(message,{cause}),{code});};

async function loadFont(file) {
  const original=await lstat(file);
  if(!original.isFile()||original.isSymbolicLink()||original.size<1||original.size>MAX_FONT_BYTES)
    fail('CONFIG_BASE_TEXT_FONT','本机中文字体文件无效或超过 32 MB');
  const key=[original.size,original.mtimeMs,original.ino].join(':');
  const prior=loadedFonts.get(file);if(prior?.key===key)return prior.value;
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  let bytes;
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.size!==original.size||before.ino!==original.ino)
      fail('CONFIG_BASE_TEXT_FONT','读取中文字体时文件已改变，请重试');
    bytes=new Uint8Array(before.size);let offset=0;
    while(offset<bytes.length) {
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if(!bytesRead)fail('CONFIG_BASE_TEXT_FONT','中文字体文件不完整');
      offset+=bytesRead;
    }
    const after=await handle.stat(),pathAfter=await lstat(file);
    if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||pathAfter.isSymbolicLink()||pathAfter.ino!==before.ino)
      fail('CONFIG_BASE_TEXT_FONT','读取中文字体时文件已改变，请重试');
  }finally{await handle.close();}
  let font;try{font=parseOpenType(bytes.buffer);}catch(error){fail('CONFIG_BASE_TEXT_FONT','本机中文字体格式无法读取',error);}
  if(!Number.isFinite(font.unitsPerEm)||font.unitsPerEm<=0)
    fail('CONFIG_BASE_TEXT_FONT','本机中文字体缺少有效的字形单位');
  const names=font.names.fontFamily??{},family=names.zh??names.en??Object.values(names)[0]??'Local Chinese font';
  const value={font,fontIdentity:{family,fileName:basename(file),sha256:createHash('sha256').update(bytes).digest('hex')}};
  loadedFonts.set(file,{key,value});return value;
}

const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const same=(a,b)=>Math.abs(a.x-b.x)<1e-10&&Math.abs(a.y-b.y)<1e-10;
function distanceToSegment(point,a,b) {
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
  const t=length===0?0:Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length));
  return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
}
function flatten(commands,counters) {
  const rings=[];let ring=[],current,start;
  const point=(x,y)=>{
    if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>10000||Math.abs(y)>10000)
      fail('CONFIG_BASE_TEXT_COMPLEXITY','文字轮廓坐标超出可打印范围，请缩短文字或减小字号');
    return{x,y:-y};
  };
  const add=value=>{
    if(ring.length&&same(ring.at(-1),value))return;
    if(++counters.vertices>MAX_VERTICES)fail('CONFIG_BASE_TEXT_COMPLEXITY','文字轮廓超过 20,000 个节点，请缩短文字或减小字号');
    ring.push(value);current=value;
  };
  const close=()=>{
    if(ring.length>1&&same(ring[0],ring.at(-1)))ring.pop();
    if(ring.length>=3) {
      if(++counters.rings>MAX_RINGS)fail('CONFIG_BASE_TEXT_COMPLEXITY','文字轮廓超过 512 个环，请缩短文字');
      rings.push(ring);
    }
    ring=[];current=start=undefined;
  };
  const quadratic=(a,b,c,depth=0)=>{
    if(distanceToSegment(b,a,c)<=FLATNESS_MM){add(c);return;}
    if(depth>=20)fail('CONFIG_BASE_TEXT_COMPLEXITY','文字曲线无法在精度限制内展平');
    const ab=midpoint(a,b),bc=midpoint(b,c),m=midpoint(ab,bc);
    quadratic(a,ab,m,depth+1);quadratic(m,bc,c,depth+1);
  };
  const cubic=(a,b,c,d,depth=0)=>{
    if(Math.max(distanceToSegment(b,a,d),distanceToSegment(c,a,d))<=FLATNESS_MM){add(d);return;}
    if(depth>=20)fail('CONFIG_BASE_TEXT_COMPLEXITY','文字曲线无法在精度限制内展平');
    const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d),abc=midpoint(ab,bc),bcd=midpoint(bc,cd),m=midpoint(abc,bcd);
    cubic(a,ab,abc,m,depth+1);cubic(m,bcd,cd,d,depth+1);
  };
  for(const command of commands) {
    if(command.type==='M'){if(ring.length)close();start=point(command.x,command.y);add(start);}
    else if(command.type==='Z'){if(start)add(start);close();}
    else if(!current)fail('CONFIG_BASE_TEXT_FONT','本机字体包含无效的文字轮廓');
    else if(command.type==='L')add(point(command.x,command.y));
    else if(command.type==='Q')quadratic(current,point(command.x1,command.y1),point(command.x,command.y));
    else if(command.type==='C')cubic(current,point(command.x1,command.y1),point(command.x2,command.y2),point(command.x,command.y));
    else fail('CONFIG_BASE_TEXT_FONT','本机字体包含不支持的文字曲线');
  }
  if(ring.length)close();return rings;
}
function signedArea(ring) {
  let area=0;for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];area+=a.x*b.y-b.x*a.y;}return area/2;
}
function unionRings(rings) {
  if(!rings.length)return[];
  const paths=rings.map(ring=>ring.map(({x,y})=>({X:Math.round(x*INTEGER_SCALE),Y:Math.round(y*INTEGER_SCALE)})));
  const clipper=new ClipperLib.Clipper(ClipperLib.Clipper.ioStrictlySimple),tree=new ClipperLib.PolyTree();
  clipper.AddPaths(paths,ClipperLib.PolyType.ptSubject,true);
  if(!clipper.Execute(ClipperLib.ClipType.ctUnion,tree,ClipperLib.PolyFillType.pftNonZero,ClipperLib.PolyFillType.pftNonZero))
    fail('CONFIG_BASE_TEXT_COMPLEXITY','文字轮廓无法组成有效的可打印区域');
  let vertices=0,ringCount=0;
  const convert=(path,positive)=>{
    const ring=path.map(({X,Y})=>({x:X/INTEGER_SCALE,y:Y/INTEGER_SCALE}));
    vertices+=ring.length;ringCount++;
    if(vertices>MAX_VERTICES||ringCount>MAX_RINGS)fail('CONFIG_BASE_TEXT_COMPLEXITY','文字区域超过 20,000 个节点或 512 个环，请缩短文字');
    if((signedArea(ring)>0)!==positive)ring.reverse();return ring;
  };
  const contours=[];
  const visit=node=>{
    if(node.Contour().length&&!node.IsHole())
      contours.push({outer:convert(node.Contour(),true),holes:node.Childs().filter(child=>child.IsHole()).map(child=>convert(child.Contour(),false))});
    for(const child of node.Childs())visit(child);
  };
  visit(tree);return contours;
}

/** Local font outlines in millimetres; placement/support belong to the core mesher. */
export async function prepareBaseText(text,sizeMm=3) {
  if(typeof text!=='string'||/[\x00-\x1f\x7f\u2028\u2029]/u.test(text))
    fail('CONFIG_BASE_TEXT_INVALID','底座文字须为单行有效文字');
  const characters=Array.from(text);
  if(characters.length>32)fail('CONFIG_BASE_TEXT_INVALID','底座文字最多 32 个字符');
  if(typeof sizeMm!=='number'||!Number.isFinite(sizeMm)||sizeMm<1.5||sizeMm>10)
    fail('CONFIG_BASE_TEXT_INVALID','文字字号须在 1.5–10 mm 之间');
  if(!characters.length)return{contours:[]};
  let selected,missingCharacter,fontError;
  for(const file of FONT_FILES) {
    let candidate;try{candidate=await loadFont(file);}catch(error){fontError=error;continue;}
    const absent=characters.find(character=>candidate.font.charToGlyph(character).index===0);
    if(absent!==undefined){missingCharacter=absent;continue;}
    selected=candidate;break;
  }
  if(!selected) {
    if(missingCharacter!==undefined)fail('CONFIG_BASE_TEXT_GLYPH','本机中文字体缺少字形 '+missingCharacter+'，请更换文字');
    fail('CONFIG_BASE_TEXT_FONT','没有可读取的本机中文字体；请使用已安装的黑体或 Noto Sans SC',fontError);
  }
  const counters={vertices:0,rings:0},rings=[];let x=0,previous;
  for(const character of characters) {
    const glyph=selected.font.charToGlyph(character);
    if(previous)x+=selected.font.getKerningValue(previous,glyph)/selected.font.unitsPerEm*sizeMm;
    rings.push(...flatten(glyph.getPath(x,0,sizeMm,{hinting:false},selected.font).commands,counters));
    x+=(glyph.advanceWidth??selected.font.unitsPerEm)/selected.font.unitsPerEm*sizeMm;previous=glyph;
  }
  return{contours:unionRings(rings),fontIdentity:{...selected.fontIdentity}};
}


