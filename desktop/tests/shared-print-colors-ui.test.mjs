import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const options={maxColors:6,grassEnabled:true,rockEnabled:true,routeEnabled:true,textEnabled:true,snowEnabled:true,grassColor:'#227733',rockColor:'#999999',routeColor:'#dd2233',baseColorSource:'custom',baseColor:'#abcdef',textColorSource:'custom',textColor:'#010203',baseText:'格聂'};
async function component(){
 const directory=await mkdtemp(resolve('desktop/tests/.shared-colors-')); const outfile=join(directory,'component.mjs');
 try{await build({entryPoints:['desktop/renderer/components/SharedPrintColors.tsx'],outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react/jsx-runtime'],logLevel:'silent'});return(await import(pathToFileURL(outfile))).default;}catch(error){if(error.errors?.some(item=>item.text.includes('Could not resolve')))return null;throw error;}finally{await rm(directory,{recursive:true,force:true});}
}
const SharedPrintColors=await component();
const render=patch=>{assert.equal(typeof SharedPrintColors,'function','shared print colors panel is missing');return renderToStaticMarkup(React.createElement(SharedPrintColors,{options:{...options,...patch},onChange:()=>{},disabled:false}));};
test('six roles share exactly one wheel, brightness control and RGB input set',()=>{
 const html=render({});
 assert.equal((html.match(/class="color-wheel"/g)??[]).length,1);
 assert.equal((html.match(/type="range"/g)??[]).length,1);
 assert.equal((html.match(/type="number"/g)??[]).length,3);
 assert.equal((html.match(/type="checkbox"/g)??[]).length,6);
 assert.doesNotMatch(html,/type="color"|<select/);
 for(const name of ['草地','山石','白雪','路线','底座','文字'])assert.ok(html.includes(name));
 assert.match(html,/aria-label="编辑路线颜色"/);assert.match(html,/复用已选颜色/);
});
test('base stays selected, white snow has no edit button and last terrain cannot be deselected',()=>{
 const html=render({rockEnabled:false});
 assert.match(html,/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*checked=""[^>]*\/>底座/);
 assert.match(html,/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*checked=""[^>]*\/>草地/);
 assert.doesNotMatch(html,/aria-label="编辑白雪颜色"/);
 assert.match(html,/固定白色/);
 assert.match(html,/<button[^>]*aria-label="编辑山石颜色"[^>]*disabled=""/);
});
