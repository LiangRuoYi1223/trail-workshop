import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {parse as parseOpenType} from 'three/examples/jsm/libs/opentype.module.js';
import {prepareBaseText} from '../main/base-text-font.mjs';

const area=ring=>ring.reduce((value,p,i)=>{const q=ring[(i+1)%ring.length];return value+p.x*q.y-q.x*p.y;},0)/2;
const extent=value=>{
  const points=value.contours.flatMap(c=>c.outer);
  return{width:Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)),
    height:Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))};
};
test('local whitelisted font prepares actual Chinese holes and rejects missing glyphs',async()=>{
  const value=await prepareBaseText('日回08',3);
  assert.match(value.fontIdentity.sha256,/^[a-f0-9]{64}$/);
  assert.ok(value.contours.length>=4);
  assert.ok(value.contours.some(c=>c.holes.length));
  assert.deepEqual((await prepareBaseText('',3)).contours,[]);
  await assert.rejects(()=>prepareBaseText('\u{10ffff}',3),{code:'CONFIG_BASE_TEXT_GLYPH'});
  await assert.rejects(()=>prepareBaseText('a'.repeat(33),3),/32/);
  await assert.rejects(()=>prepareBaseText('a',1),/1.5/);
});
test('nested islands, disconnected strokes and orientation survive the nonzero union',async()=>{
  const round=await prepareBaseText('回',3),digits=await prepareBaseText('08',3),strokes=await prepareBaseText('川',3);
  assert.equal(round.contours.length,2,'回 retains both its outer and inner strokes as material regions');
  assert.equal(round.contours.reduce((n,c)=>n+c.holes.length,0),2);
  assert.equal(digits.contours.length,2);assert.equal(digits.contours.reduce((n,c)=>n+c.holes.length,0),3);
  assert.ok(strokes.contours.length>=3,'Disconnected Chinese strokes are separate outer contours');
  for(const value of [round,digits,strokes])for(const contour of value.contours) {
    assert.ok(area(contour.outer)>0);
    for(const hole of contour.holes)assert.ok(area(hole)<0);
    for(const ring of [contour.outer,...contour.holes]) {
      assert.ok(ring.length>=3&&ring.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
      assert.notDeepEqual(ring[0],ring.at(-1),'Closed cyclic rings have no repeated endpoint');
    }
  }
});
test('size endpoints are millimetre scaled and font identity is reproducible without leaking font paths',async()=>{
  const small=await prepareBaseText('格聂',1.5),large=await prepareBaseText('格聂',10);
  const a=extent(small),b=extent(large);
  assert.ok(Math.abs(a.width*10/1.5-b.width)<.0002);
  assert.ok(Math.abs(a.height*10/1.5-b.height)<.0002);
  assert.deepEqual(small.fontIdentity,large.fontIdentity);
  assert.equal(small.fontIdentity.fileName,'simhei.ttf');
  assert.ok(!Object.values(small.fontIdentity).some(value=>/[A-Za-z]:[\\/]/.test(value)));
  assert.deepEqual(await prepareBaseText('格聂',1.5),small);
});
test('single-line and Unicode limits fail before font lookup; 32 Chinese characters remain supported',async()=>{
  for(const value of ['a\nb','a\rb','a\tb','a\u2028b'])await assert.rejects(()=>prepareBaseText(value,3),{code:'CONFIG_BASE_TEXT_INVALID'});
  for(const size of [NaN,Infinity,0,1.49,10.01,'3'])await assert.rejects(()=>prepareBaseText('日',size),{code:'CONFIG_BASE_TEXT_INVALID'});
  await assert.rejects(()=>prepareBaseText('日'.repeat(33),3),/32/);
  assert.equal((await prepareBaseText('日'.repeat(32),3)).contours.length,32);
  assert.equal((await prepareBaseText(' ',3)).contours.length,0);
  assert.deepEqual(await prepareBaseText('',3),{contours:[]});
});
test('flattened curved outlines stay within 0.005 mm of actual local font curves',async()=>{
  const bytes=await readFile('C:/Windows/Fonts/simhei.ttf'),font=parseOpenType(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const value=await prepareBaseText('0',10),rings=value.contours.flatMap(c=>[c.outer,...c.holes]);
  const distance=(p,a,b)=>{
    const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l===0?0:Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l));
    return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
  };
  const nearest=p=>Math.min(...rings.flatMap(r=>r.map((a,i)=>distance(p,a,r[(i+1)%r.length]))));
  let previous,start;
  for(const command of font.charToGlyph('0').getPath(0,0,10).commands) {
    if(command.type==='M'){previous=start={x:command.x,y:-command.y};continue;}
    if(command.type==='Z'){previous=start;continue;}
    const end={x:command.x,y:-command.y};
    if(command.type==='Q')for(let step=0;step<=64;step++) {
      const t=step/64,u=1-t,p={x:u*u*previous.x+2*u*t*command.x1+t*t*end.x,
        y:u*u*previous.y-2*u*t*command.y1+t*t*end.y};
      assert.ok(nearest(p)<=.005,'Actual quadratic curve stays within declared flattening tolerance');
    }
    previous=end;
  }
});

