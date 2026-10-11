import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DownloadBudget, SentinelRangeClient } from '../src/appearance/online-remote.js';

const url='https://sentinel-cogs.s3.us-west-2.amazonaws.com/test/TCI.tif';
const block=64*1024;
function server(size=8*1024*1024) {
  const bytes=Uint8Array.from({length:size},(_,index)=>index%251),ranges:Array<[number,number]>=[];
  const fetch:typeof globalThis.fetch=async(input,options)=>{
    assert.equal(String(input),url);assert.equal(options?.redirect,'error');
    const range=/^bytes=(\d+)-(\d+)$/u.exec(new Headers(options?.headers).get('range')??'');assert.ok(range);
    const start=Number(range[1]),wantedEnd=Number(range[2]);assert.ok(wantedEnd-start+1<=4*1024*1024);
    assert.ok(start<size);const end=Math.min(wantedEnd,size-1);ranges.push([start,end]);
    return new Response(bytes.slice(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${size}`,'content-length':String(end-start+1)}});
  };
  return {bytes,ranges,fetch};
}
function client(fetch:typeof globalThis.fetch,budget=new DownloadBudget(),cacheDir?:string,signal=new AbortController().signal) {
  return new SentinelRangeClient(url,fetch,signal,budget,cacheDir);
}
async function read(c:SentinelRangeClient,start:number,end:number) {
  const response=await c.request({headers:{range:`bytes=${start}-${end}`}});
  return {bytes:new Uint8Array(await response.getData()),range:response.getHeader('content-range')};
}
async function directory(run:(path:string)=>Promise<void>) {
  const base=resolve('artifacts/auto-core-test-cache');await mkdir(base,{recursive:true});const path=await mkdtemp(join(base,'range-'));
  try {await run(path);} finally {await rm(path,{recursive:true,force:true});}
}

test('adjacent TIFF metadata reads reuse one validated block and preserve exact requested bytes',async()=>{
  const source=server(),budget=new DownloadBudget(),c=client(source.fetch,budget);
  assert.deepEqual((await read(c,0,15)).bytes,source.bytes.slice(0,16));
  assert.deepEqual((await read(c,150,153)).bytes,source.bytes.slice(150,154));
  assert.deepEqual((await read(c,180,183)).bytes,source.bytes.slice(180,184));
  assert.equal(source.ranges.length,1);assert.equal(budget.reserved,block);
});

test('simultaneous overlapping readers sharing the acquisition budget download each byte block once',async()=>{
  const source=server(),budget=new DownloadBudget(),a=client(source.fetch,budget),b=client(source.fetch,budget);
  const result=await Promise.all([read(a,0,15),read(b,8,27),read(a,100,103)]);
  assert.deepEqual(result.map(value=>[...value.bytes]),[[...source.bytes.slice(0,16)],[...source.bytes.slice(8,28)],[...source.bytes.slice(100,104)]]);
  assert.equal(source.ranges.length,1);
});

test('contiguous RGB ranges are merged and a partially overlapping crop downloads only missing blocks',async()=>{
  const source=server(),c=client(source.fetch);
  assert.deepEqual((await read(c,100,1024*1024+99)).bytes,source.bytes.slice(100,1024*1024+100));
  assert.equal(source.ranges.length,1);
  assert.deepEqual((await read(c,512*1024,1536*1024-1)).bytes,source.bytes.slice(512*1024,1536*1024));
  assert.equal(source.ranges.length,2);assert.equal(source.ranges[1][0],17*block);
});

test('an unaligned maximum RGB range uses at most two bounded HTTP reads',async()=>{
  const source=server(),c=client(source.fetch);
  assert.deepEqual((await read(c,13,4*1024*1024+12)).bytes,source.bytes.slice(13,4*1024*1024+13));
  assert.ok(source.ranges.length<=2);
});

test('a truncated final block is reused with an accurate synthetic Content-Range',async()=>{
  const source=server(block+17),c=client(source.fetch);
  const tail=await read(c,block+10,block+99);
  assert.deepEqual(tail.bytes,source.bytes.slice(block+10));assert.equal(tail.range,`bytes ${block+10}-${block+16}/${block+17}`);
  assert.deepEqual((await read(c,block+11,block+12)).bytes,source.bytes.slice(block+11,block+13));
  assert.equal(source.ranges.length,1);
});

test('a new acquisition reuses persistent verified source bytes without spending network budget',async()=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),8,27);
    const budget=new DownloadBudget(),second=client(source.fetch,budget,path);
    assert.deepEqual((await read(second,100,119)).bytes,source.bytes.slice(100,120));
    assert.equal(source.ranges.length,1);assert.equal(budget.reserved,0);
  });
});

test('corrupted persistent source bytes are refetched rather than used as image data',async()=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),8,27);
    const folder=join(path,'sentinel-ranges'),files=await readdir(folder);assert.equal(files.length,1);
    const file=join(folder,files[0]),bytes=await readFile(file);bytes[bytes.length-1]^=255;await writeFile(file,bytes);
    assert.deepEqual((await read(client(source.fetch,new DownloadBudget(),path),8,27)).bytes,source.bytes.slice(8,28));
    assert.equal(source.ranges.length,2);
  });
});

test('forged persistent file totals cannot alter verified source range metadata',async()=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),0,3);
    const folder=join(path,'sentinel-ranges'),file=join(folder,(await readdir(folder))[0]),payload=await readFile(file);
    const headerLength=payload.readUInt32LE(0),header=JSON.parse(payload.subarray(4,4+headerLength).toString('utf8'));
    header.total+=block;const json=Buffer.from(JSON.stringify(header)),forged=Buffer.alloc(4+json.length+payload.length-4-headerLength);
    forged.writeUInt32LE(json.length,0);json.copy(forged,4);payload.copy(forged,4+json.length,4+headerLength);await writeFile(file,forged);
    const response=await read(client(source.fetch,new DownloadBudget(),path),0,3);
    assert.equal(response.range,`bytes 0-3/${source.bytes.length}`);assert.equal(source.ranges.length,2);
  });
});

test('oversized persistent entries are ignored without admitting their payload into memory',async()=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),0,3);
    const folder=join(path,'sentinel-ranges'),file=join(folder,(await readdir(folder))[0]);await writeFile(file,new Uint8Array(2*block));
    assert.deepEqual((await read(client(source.fetch,new DownloadBudget(),path),0,3)).bytes,source.bytes.slice(0,4));
    assert.equal(source.ranges.length,2);
  });
});

test('mismatched or incomplete range bodies never create reusable blocks',async()=>{
  await directory(async path=>{
    const source=server();let invalid=true;
    const fetch:typeof globalThis.fetch=async(input,options)=>{
      if(!invalid)return source.fetch(input,options);
      return new Response(new Uint8Array(4),{status:206,headers:{'content-range':`bytes 0-${block-1}/${source.bytes.length}`}});
    };
    await assert.rejects(read(client(fetch,new DownloadBudget(),path),0,3),{code:'IMAGE_RANGE_UNSUPPORTED'});
    invalid=false;assert.deepEqual((await read(client(fetch,new DownloadBudget(),path),0,3)).bytes,source.bytes.slice(0,4));
    assert.equal(source.ranges.length,1);
  });
});

test('verified blocks survive cancellation while a later aborted block is never persisted',async()=>{
  await directory(async path=>{
    const source=server(),controller=new AbortController();let calls=0;
    const fetch:typeof globalThis.fetch=async(input,options)=>{
      if(++calls===2){controller.abort();throw controller.signal.reason;}
      return source.fetch(input,options);
    };
    const c=client(fetch,new DownloadBudget(),path,controller.signal);await read(c,0,3);
    await assert.rejects(read(c,block,block+3),{name:'AbortError'});
    const second=client(source.fetch,new DownloadBudget(),path);await read(second,0,3);await read(second,block,block+3);
    assert.equal(source.ranges.length,2);
  });
});

test('cancelling a stalled response body stops the range read and discards its incomplete block',async()=>{
  const controller=new AbortController();let cancelled=false;
  const fetch:typeof globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({
    start(stream){stream.enqueue(new Uint8Array(32));setImmediate(()=>controller.abort());},
    cancel(){cancelled=true;}
  }),{status:206,headers:{'content-range':`bytes 0-${block-1}/${8*block}`}});
  const outcome=read(client(fetch,new DownloadBudget(),undefined,controller.signal),0,3).then(()=>false,()=>true);
  const stopped=await Promise.race([outcome,new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(stopped,true,'a cancelled streaming response must not leave acquisition hanging');assert.equal(cancelled,true);
});

test('cache files cannot redirect reads through symbolic links',async t=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),0,3);
    const folder=join(path,'sentinel-ranges'),file=join(folder,(await readdir(folder))[0]),other=join(path,'outside.block');
    await writeFile(other,await readFile(file));await rm(file);
    try {await symlink(other,file,'file');} catch(error) {
      if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows session cannot create file symlinks');return;}throw error;
    }
    assert.deepEqual((await read(client(source.fetch,new DownloadBudget(),path),0,3)).bytes,source.bytes.slice(0,4));
    assert.equal(source.ranges.length,2);
  });
});

test('linked range-cache directories cannot redirect byte reads or cache writes',async t=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),0,3);
    const outside=join(path,'outside');await mkdir(outside);const linkedRoot=join(path,'linked-root');await mkdir(linkedRoot);
    const folder=join(path,'sentinel-ranges'),files=await readdir(folder);
    for(const file of files)await writeFile(join(outside,file),await readFile(join(folder,file)));
    try {await symlink(outside,join(linkedRoot,'sentinel-ranges'),'junction');} catch(error) {
      if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Session cannot create directory links');return;}throw error;
    }
    const before=await readFile(join(outside,files[0]));
    assert.deepEqual((await read(client(source.fetch,new DownloadBudget(),linkedRoot),0,3)).bytes,source.bytes.slice(0,4));
    assert.equal(source.ranges.length,2);assert.deepEqual(await readFile(join(outside,files[0])),before);
  });
});

test('shared reservations reject a parallel read before exceeding the 64 MB acquisition budget',async()=>{
  const source=server(),budget=new DownloadBudget();budget.reserved=64*1024*1024-block;
  const c=client(source.fetch,budget);const outcomes=await Promise.allSettled([read(c,0,3),read(c,block,block+3)]);
  assert.equal(outcomes.filter(value=>value.status==='rejected').length,1);
  assert.equal(source.ranges.length,1);assert.ok(budget.reserved<=64*1024*1024);
});
