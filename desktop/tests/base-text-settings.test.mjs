import assert from 'node:assert/strict';
import test from 'node:test';
import {validateOptions} from '../main/files.mjs';
import {appearanceColor,geometryOptions,printPaletteCount} from '../renderer/route-color.ts';

test('base/text defaults migrate old projects and six-color snow remains valid',()=>{
  const old=validateOptions({maxColors:2});
  assert.equal(old.baseText,'');assert.equal(old.baseTextSizeMm,3);
  assert.equal(old.baseColorSource,'rock');assert.equal(old.textColorSource,'route');
  assert.equal(old.maxColors,6);assert.equal(old.grassEnabled,true);assert.equal(old.rockEnabled,false);
  for(const maxColors of [4,5,6])assert.equal(validateOptions({snowEnabled:true,maxColors}).maxColors,6);
});
test('text and color options reject missing bounds and unsupported characters without coercion',()=>{
  for(const patch of [{baseText:'日'.repeat(33)},{baseText:'一\n二'},{baseTextSizeMm:1.49},{baseTextSizeMm:10.01},{baseTextSizeMm:'3'},
    {baseColorSource:'snow'},{baseColor:'#fff'},{textColorSource:'grass'},{maxColors:7}])
    assert.throws(()=>validateOptions(patch),{code:'CONFIG_INVALID'});
  assert.equal(validateOptions({baseText:'格聂牧场 · 2026',baseTextSizeMm:1.5}).baseText,'格聂牧场 · 2026');
  assert.equal(validateOptions({baseTextSizeMm:10}).baseTextSizeMm,10);
});
test('linked material colors follow changes and custom colors count only distinct RGB',()=>{
  const options={maxColors:6,grassColor:'#112233',rockColor:'#445566',routeColor:'#778899',
    baseColorSource:'rock',baseColor:'#010203',textColorSource:'route',textColor:'#040506'};
  assert.equal(appearanceColor('base',options),'#445566');assert.equal(appearanceColor('text',options),'#778899');
  assert.equal(appearanceColor('base',{...options,baseColorSource:'grass'}),'#112233');
  assert.equal(appearanceColor('base',{...options,baseColorSource:'custom'}),'#010203');
  assert.equal(printPaletteCount(['grass','rock','snow','route','base','text'],options),4);
  assert.equal(printPaletteCount(['grass','rock','snow','route','base','text'],{...options,baseColorSource:'custom',textColorSource:'custom'}),6);
});
test('color-only edits preserve geometry while label and font-size edits invalidate it',()=>{
  const a={baseText:'回到山里',baseTextSizeMm:3,frameWidthMm:3,baseColorSource:'rock',baseColor:'#112233',textColorSource:'route',textColor:'#445566'};
  assert.deepEqual(geometryOptions(a),{baseText:'回到山里',baseTextSizeMm:3,frameWidthMm:3});
  assert.deepEqual(geometryOptions({...a,baseColorSource:'custom',baseColor:'#123456',textColorSource:'custom'}),geometryOptions(a));
  assert.notDeepEqual(geometryOptions({...a,baseText:'格聂'}),geometryOptions(a));
});
