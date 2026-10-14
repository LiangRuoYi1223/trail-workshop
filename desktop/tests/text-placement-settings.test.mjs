import assert from 'node:assert/strict';
import test from 'node:test';
import {validateOptions} from '../main/files.mjs';
import {geometryOptions} from '../renderer/route-color.ts';

test('old projects retain front placement and circle angles wrap 360 to zero',()=>{
  assert.equal(validateOptions().baseTextAngleDeg,180);
  assert.equal(validateOptions().baseTextEdgeIndex,0);
  for(const angle of [0,90,180,270,359.5,360])assert.equal(validateOptions({shape:'circle',baseTextAngleDeg:angle}).baseTextAngleDeg,angle===360?0:angle);
});
test('text placement rejects invalid angles and nonexistent polygon edges',()=>{
  for(const angle of [-1,360.1,NaN,Infinity,'90',null,undefined])assert.throws(()=>validateOptions({baseTextAngleDeg:angle}),{code:'CONFIG_INVALID'});
  for(const edge of [-1,8,1.2,NaN,'2',null,undefined])assert.throws(()=>validateOptions({baseTextEdgeIndex:edge}),{code:'CONFIG_INVALID'});
  for(let sides=3;sides<=8;sides++){
    for(let edge=0;edge<sides;edge++)assert.equal(validateOptions({shape:'polygon',polygonSides:sides,baseTextEdgeIndex:edge}).baseTextEdgeIndex,edge);
    assert.throws(()=>validateOptions({shape:'polygon',polygonSides:sides,baseTextEdgeIndex:sides}),{code:'CONFIG_INVALID'});
  }
});
test('text positions participate in geometry while custom colors do not',()=>{
  const options={baseText:'格聂',baseTextAngleDeg:180,baseTextEdgeIndex:0,textColor:'#cc4422'};
  assert.notDeepEqual(geometryOptions({...options,baseTextAngleDeg:90}),geometryOptions(options));
  assert.notDeepEqual(geometryOptions({...options,baseTextEdgeIndex:2}),geometryOptions(options));
  assert.deepEqual(geometryOptions({...options,textColor:'#112233'}),geometryOptions(options));
});
