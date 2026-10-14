import test from 'node:test';
import assert from 'node:assert/strict';
const colors = await import('../renderer/route-color.ts');
const options={maxColors:6,grassColor:'#227733',rockColor:'#999999',routeColor:'#dd2233',baseColorSource:'rock',baseColor:'#010203',textColorSource:'route',textColor:'#040506',grassEnabled:true,rockEnabled:true,routeEnabled:true,textEnabled:true,snowEnabled:true,baseText:'格聂'};

test('terrain selection is appearance-only but route and text selection invalidate geometry',()=>{
 const geometry=colors.geometryOptions(options);
 assert.deepEqual(colors.geometryOptions({...options,grassEnabled:false}),geometry);
 assert.deepEqual(colors.geometryOptions({...options,rockEnabled:false}),geometry);
 assert.notDeepEqual(colors.geometryOptions({...options,routeEnabled:false}),geometry);
 assert.notDeepEqual(colors.geometryOptions({...options,textEnabled:false}),geometry);
 assert.equal(colors.appearanceOptions(options).grassEnabled,true);
});
test('single terrain role recolors every terrain class and linked base with its remaining color',()=>{
 const grass={...options,rockEnabled:false};
 assert.equal(colors.appearanceColor('rock',grass),options.grassColor);
 assert.equal(colors.appearanceColor('base',grass),options.grassColor);
 const rock={...options,grassEnabled:false,baseColorSource:'grass'};
 assert.equal(colors.appearanceColor('grass',rock),options.rockColor);
 assert.equal(colors.appearanceColor('base',rock),options.rockColor);
 assert.equal(colors.appearanceColor('rock',{...options,maxColors:2}),options.rockColor);
});
test('role toggles preserve chosen colors and cannot turn off the last terrain or base',()=>{
 assert.equal(typeof colors.togglePrintRole,'function');
 const disabled=colors.togglePrintRole(options,'rock',false);
 assert.equal(disabled.rockEnabled,false);assert.equal(disabled.rockColor,options.rockColor);
 assert.deepEqual(colors.togglePrintRole(disabled,'grass',false),disabled);
 assert.deepEqual(colors.togglePrintRole(options,'base',false),options);
 assert.equal(colors.togglePrintRole(disabled,'rock',true).rockColor,options.rockColor);
});
test('existing-color reuse keeps base and text links and manual changes become custom',()=>{
 assert.equal(typeof colors.reusePrintColor,'function');assert.equal(typeof colors.editPrintColor,'function');
 const linked=colors.reusePrintColor(options,'base','grass');
 assert.equal(linked.baseColorSource,'grass');
 assert.equal(colors.appearanceColor('base',{...linked,grassColor:'#123456'}),'#123456');
 assert.equal(colors.reusePrintColor(options,'text','route').textColorSource,'route');
 const manual=colors.editPrintColor(linked,'base','#abcdef');
 assert.equal(manual.baseColorSource,'custom');assert.equal(manual.baseColor,'#abcdef');
 assert.deepEqual(colors.editPrintColor(options,'snow','#123456'),options);
});
test('planned palette uses selected roles while actual palette retains old geometry until regeneration',()=>{
 assert.equal(typeof colors.plannedPrintPaletteCount,'function');
 const disabled={...options,routeEnabled:false,textEnabled:false,snowEnabled:false,rockEnabled:false};
 assert.equal(colors.plannedPrintPaletteCount(disabled),1);
 assert.equal(colors.printPaletteCount(['grass','rock','snow','route','base','text'],disabled),3);
 assert.equal(colors.printPaletteCount(['rock','base'],disabled),1);
 assert.equal(colors.plannedPrintPaletteCount({...options,baseText:''}),4);
});

test('actual model roles include nonempty hidden materials and ignore empty deleted parts',()=>{
 assert.equal(typeof colors.previewPrintClasses,'function');
 const preview={mesh:{positions:[],indices:[],faceClasses:['grass','rock'],materialParts:[{id:'base',indices:[0,1,2]},{id:'route',indices:[0,1,2]},{id:'text',indices:[]}]}};
 assert.deepEqual(new Set(colors.previewPrintClasses(preview)),new Set(['grass','rock','base','route']));
 const current={...options,routeEnabled:false,textEnabled:false,baseColorSource:'custom',baseColor:'#010203'};
 assert.equal(colors.printPaletteCount(colors.previewPrintClasses(preview),current),4);
});

test('large model roles scan 300000 faces per solid without overflowing argument limits',()=>{
 const outer=Array.from({length:300000},(_,index)=>index%2?'grass':'rock');
 const hidden=Array.from({length:300000},()=> 'snow');
 const preview={appearance:{faceClasses:outer},mesh:{materialParts:[{id:'terrain',indices:[0,1,2],faceClasses:hidden},{id:'base',indices:[0,1,2]},{id:'route',indices:[0,1,2]},{id:'text',indices:[],faceClasses:Array(300000).fill('text')}]}};
 assert.deepEqual(colors.previewPrintClasses(preview),['rock','grass','snow','base','route']);
 const staleOptions={...options,routeEnabled:false,textEnabled:false,snowEnabled:false};
 assert.equal(colors.printPaletteCount(colors.previewPrintClasses(preview),staleOptions),4);
 assert.deepEqual(colors.previewPrintClasses({mesh:{faceClasses:outer,materialParts:[{id:'terrain',indices:[0,1,2],faceClasses:hidden}]}}),['rock','grass','snow']);
 assert.deepEqual(colors.previewPrintClasses({mesh:{faceKinds:Array(300000).fill('terrain'),materialParts:[{id:'base',indices:[0,1,2]}]}}),['grass','base']);
});
