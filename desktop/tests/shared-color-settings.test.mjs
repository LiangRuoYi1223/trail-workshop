import assert from 'node:assert/strict';
import test from 'node:test';
import {validateOptions} from '../main/files.mjs';
import {timingFeatures} from '../main/timing.mjs';

test('shared color role defaults are explicit with a compulsory base and automatic six-role capacity',()=>{
 const o=validateOptions();
 assert.equal(o.grassEnabled,true);assert.equal(o.rockEnabled,true);assert.equal(o.routeEnabled,true);assert.equal(o.textEnabled,false);assert.equal(o.maxColors,6);
 assert.equal(o.baseColorSource,'rock');
});
test('old two-color projects migrate to single grass and existing labels stay enabled',()=>{
 const old=validateOptions({maxColors:2,baseText:'格聂牧场'});
 assert.equal(old.grassEnabled,true);assert.equal(old.rockEnabled,false);assert.equal(old.routeEnabled,true);assert.equal(old.textEnabled,true);assert.equal(old.maxColors,6);
 const disabled=validateOptions({maxColors:2,grassEnabled:false,rockEnabled:true,routeEnabled:false,textEnabled:false,baseText:'格聂'});
 assert.equal(disabled.grassEnabled,false);assert.equal(disabled.rockEnabled,true);assert.equal(disabled.baseText,'格聂');assert.equal(disabled.textEnabled,false);
});
test('terrain must keep one role and optional switches are strictly booleans',()=>{
 for(const patch of [{grassEnabled:false,rockEnabled:false},{grassEnabled:'false'},{rockEnabled:0},{routeEnabled:null},{textEnabled:'true'},{baseEnabled:false},{snowColor:'#123456'}])
  assert.throws(()=>validateOptions(patch),{code:'CONFIG_INVALID'});
 for(const patch of [{grassEnabled:false,rockEnabled:true},{grassEnabled:true,rockEnabled:false}])assert.equal(validateOptions(patch).maxColors,6);
});
test('fixed white snow may share colors without a four-color budget restriction',()=>{
 const o=validateOptions({maxColors:1,snowEnabled:true,grassEnabled:false,rockEnabled:true,routeEnabled:false,textEnabled:false,rockColor:'#ffffff',baseColorSource:'rock'});
 assert.equal(o.maxColors,6);assert.equal(o.snowEnabled,true);assert.equal(o.routeEnabled,false);
 assert.throws(()=>validateOptions({maxColors:7}),{code:'CONFIG_INVALID'});
});
test('timing cohorts change for actual route and text geometry, not terrain color selection',()=>{
 const input={route:{pointCount:2586,segmentCount:1},options:{routeEnabled:true,textEnabled:true,baseText:'格聂',grassEnabled:true,rockEnabled:true},demMode:'local',imageMode:'none'};
 const before=timingFeatures(input);
 assert.notDeepEqual(timingFeatures({...input,options:{...input.options,routeEnabled:false}}),before);
 const off=timingFeatures({...input,options:{...input.options,textEnabled:false}});
 assert.notDeepEqual(off,before);assert.equal(off.baseText,'');
 assert.deepEqual(timingFeatures({...input,options:{...input.options,grassEnabled:false}}),before);
});
