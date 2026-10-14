import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DownloadBudget, readBoundedBody, SentinelImageError, SentinelRangeClient } from '../src/appearance/online-remote.js';

const url='https://sentinel-cogs.s3.us-west-2.amazonaws.com/test/TCI.tif';
const block=64*1024,downloadLimit=512*1024*1024;
interface Reservation {consume(bytes:number):void;release():void}
function reservation(budget:DownloadBudget,bytes:number):Reservation {
  const value=Reflect.apply(budget.reserve,budget,[bytes]) as Reservation|undefined;
  assert.ok(value,'reservations must account delivered chunks and release unused bytes');return value;
}
function prefetch(c:SentinelRangeClient,ranges:Array<{offset:number;length:number}>,signal?:AbortSignal):Promise<void> {
  const method=Reflect.get(c,'prefetch');assert.equal(typeof method,'function','useful TIFF ranges need a deduplicating prefetch');
  return Reflect.apply(method,c,[ranges,signal]) as Promise<void>;
}
function retry<T>(budget:DownloadBudget,operation:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  const method=Reflect.get(budget,'retry');assert.equal(typeof method,'function','catalogs and ranges need a shared retry owner');
  return Reflect.apply(method,budget,[operation,signal]) as Promise<T>;
}
function spend(budget:DownloadBudget,bytes:number):void {
  while(bytes) {const chunk=Math.min(bytes,4*1024*1024),value=reservation(budget,chunk);value.consume(chunk);value.release();bytes-=chunk;}
}
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

test('adjacent TIFF metadata reads reuse one validated block and release their network reservation',async()=>{
  const source=server(),budget=new DownloadBudget(),c=client(source.fetch,budget);
  assert.deepEqual((await read(c,0,15)).bytes,source.bytes.slice(0,16));
  assert.deepEqual((await read(c,150,153)).bytes,source.bytes.slice(150,154));
  assert.deepEqual((await read(c,180,183)).bytes,source.bytes.slice(180,184));
  assert.equal(source.ranges.length,1);assert.equal(budget.reserved,0);assert.equal(budget.downloadedBytes,block);
});

test('simultaneous overlapping readers sharing the acquisition budget download each byte block once',async()=>{
  const source=server(),budget=new DownloadBudget(),a=client(source.fetch,budget),b=client(source.fetch,budget);
  const result=await Promise.all([read(a,0,15),read(b,8,27),read(a,100,103)]);
  assert.deepEqual(result.map(value=>[...value.bytes]),[[...source.bytes.slice(0,16)],[...source.bytes.slice(8,28)],[...source.bytes.slice(100,104)]]);
  assert.equal(source.ranges.length,1);assert.equal(budget.downloadedBytes,block);assert.equal(budget.reserved,0);
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

test('useful TIFF prefetch deduplicates sorts and merges raw blocks before exact raster reads',async()=>{
  const source=server(),budget=new DownloadBudget(),c=client(source.fetch,budget);
  await prefetch(c,[{offset:2*block+19,length:10},{offset:12,length:block},{offset:2*block+4,length:17}]);
  assert.deepEqual(source.ranges,[[0,3*block-1]]);
  assert.deepEqual((await read(c,2*block+19,2*block+28)).bytes,source.bytes.slice(2*block+19,2*block+29));
  assert.equal(source.ranges.length,1);assert.equal(budget.downloadedBytes,3*block);assert.equal(budget.reserved,0);
});

test('prefetch splits adjacent useful blocks into requests no larger than four MiB',async()=>{
  const source=server(),c=client(source.fetch);
  await prefetch(c,[{offset:4*1024*1024,length:block},{offset:0,length:4*1024*1024}]);
  assert.deepEqual(source.ranges,[[0,4*1024*1024-1],[4*1024*1024,4*1024*1024+block-1]]);
});

test('a truncated final block is reused with an accurate synthetic Content-Range',async()=>{
  const source=server(block+17),budget=new DownloadBudget(),c=client(source.fetch,budget);
  const tail=await read(c,block+10,block+99);
  assert.deepEqual(tail.bytes,source.bytes.slice(block+10));assert.equal(tail.range,`bytes ${block+10}-${block+16}/${block+17}`);
  assert.deepEqual((await read(c,block+11,block+12)).bytes,source.bytes.slice(block+11,block+13));
  assert.equal(source.ranges.length,1);assert.equal(budget.downloadedBytes,17);assert.equal(budget.reserved,0);
});

test('a new acquisition reuses persistent verified source bytes without spending network budget',async()=>{
  await directory(async path=>{
    const source=server();await read(client(source.fetch,new DownloadBudget(),path),8,27);
    const budget=new DownloadBudget(),second=client(source.fetch,budget,path);
    assert.deepEqual((await read(second,100,119)).bytes,source.bytes.slice(100,120));
    assert.equal(source.ranges.length,1);assert.equal(budget.reserved,0);assert.equal(budget.downloadedBytes,0);
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

test('incomplete range bodies count received bytes and never become reusable blocks',async()=>{
  await directory(async path=>{
    const source=server(),budget=new DownloadBudget();let invalid=true;
    const fetch:typeof globalThis.fetch=async(input,options)=>{
      if(!invalid)return source.fetch(input,options);
      return new Response(new Uint8Array(4),{status:206,headers:{'content-range':`bytes 0-${block-1}/${source.bytes.length}`}});
    };
    await assert.rejects(read(client(fetch,budget,path),0,3),{code:'IMAGE_RANGE_UNSUPPORTED'});
    assert.equal(budget.downloadedBytes,4);assert.equal(budget.reserved,0);
    invalid=false;assert.deepEqual((await read(client(fetch,new DownloadBudget(),path),0,3)).bytes,source.bytes.slice(0,4));
    assert.equal(source.ranges.length,1);
  });
});

test('partial streamed failures are counted again when the same range succeeds on retry',async()=>{
  const source=server(),budget=new DownloadBudget(),requests:string[]=[];let attempts=0;
  const fetch:typeof globalThis.fetch=async(input,options)=>{
    requests.push(new Headers(options?.headers).get('range')!);
    if(++attempts>1)return source.fetch(input,options);
    let delivered=false;
    return new Response(new ReadableStream<Uint8Array>({pull(stream){
      if(!delivered){delivered=true;stream.enqueue(new Uint8Array(32));}
      else stream.error(Object.assign(new TypeError('net::ERR_CONNECTION_RESET'),{code:'ECONNRESET'}));
    }}),{status:206,headers:{'content-range':`bytes 0-${block-1}/${source.bytes.length}`}});
  };
  assert.deepEqual((await read(client(fetch,budget),0,3)).bytes,source.bytes.slice(0,4));
  assert.deepEqual(requests,[`bytes=0-${block-1}`,`bytes=0-${block-1}`]);
  assert.equal(budget.downloadedBytes,block+32);assert.equal(budget.reserved,0);
  assert.equal(Reflect.get(budget,'retryCount'),1);assert.equal(budget.requestCount,2);assert.equal(Reflect.get(budget,'rangeRequestCount'),2);
});

test('catalog and range attempts share two retry credits across the whole acquisition',async()=>{
  const budget=new DownloadBudget(),signal=new AbortController().signal;let catalogAttempts=0,rangeAttempts=0;
  assert.equal(await retry(budget,async()=>{if(++catalogAttempts===1)throw new TypeError('catalog connection reset');return 'catalog';},signal),'catalog');
  const fetch:typeof globalThis.fetch=async()=>{rangeAttempts++;throw new TypeError('range connection reset');};
  await assert.rejects(read(client(fetch,budget,undefined,signal),0,3),{name:'TypeError',message:'range connection reset'});
  assert.equal(catalogAttempts,2);assert.equal(rangeAttempts,2);assert.equal(Reflect.get(budget,'retryCount'),2);assert.equal(budget.reserved,0);
});

test('two retries are the task total even when multiple range reads fail concurrently',async()=>{
  const budget=new DownloadBudget();let attempts=0;
  const fetch:typeof globalThis.fetch=async()=>{attempts++;throw Object.assign(new Error('temporarily disconnected'),{code:'ECONNRESET'});};
  const outcomes=await Promise.allSettled([read(client(fetch,budget),0,3),read(client(fetch,budget),block,block+3)]);
  assert.equal(outcomes.filter(value=>value.status==='rejected').length,2);assert.equal(attempts,4);
  assert.equal(Reflect.get(budget,'retryCount'),2);assert.equal(budget.reserved,0);
});

for(const status of [408,429,503])test(`HTTP ${status} retries the same bounded range and releases both reservations`,async()=>{
  const source=server(),budget=new DownloadBudget();let attempts=0;
  const fetch:typeof globalThis.fetch=async(input,options)=>++attempts===1?new Response(null,{status}):source.fetch(input,options);
  assert.deepEqual((await read(client(fetch,budget),0,3)).bytes,source.bytes.slice(0,4));
  assert.equal(attempts,2);assert.equal(budget.reserved,0);assert.equal(Reflect.get(budget,'retryCount'),1);
});

test('permanent HTTP failures preserve their status and do not consume retry credits',async()=>{
  const budget=new DownloadBudget();let attempts=0;
  const fetch:typeof globalThis.fetch=async()=>{attempts++;return new Response(null,{status:403});};
  await assert.rejects(read(client(fetch,budget),0,3),(error:unknown)=>Boolean(error instanceof SentinelImageError&&Reflect.get(error,'status')===403&&error.message.includes('403')));
  assert.equal(attempts,1);assert.equal(Reflect.get(budget,'retryCount'),0);assert.equal(budget.reserved,0);
});

test('a malformed 206 Content-Range is permanent and never retried',async()=>{
  const budget=new DownloadBudget();let attempts=0;
  const fetch:typeof globalThis.fetch=async()=>{attempts++;return new Response(new Uint8Array(4),{status:206,headers:{'content-range':'bytes 4-7/100'}});};
  await assert.rejects(read(client(fetch,budget),0,3),{code:'IMAGE_RANGE_UNSUPPORTED'});
  assert.equal(attempts,1);assert.equal(Reflect.get(budget,'retryCount'),0);assert.equal(budget.reserved,0);
});

test('verified blocks survive cancellation while a later aborted block is never persisted',async()=>{
  await directory(async path=>{
    const source=server(),controller=new AbortController(),budget=new DownloadBudget();let calls=0;
    const fetch:typeof globalThis.fetch=async(input,options)=>{
      if(++calls===2){controller.abort();throw controller.signal.reason;}
      return source.fetch(input,options);
    };
    const c=client(fetch,budget,path,controller.signal);await read(c,0,3);
    await assert.rejects(read(c,block,block+3),{name:'AbortError'});
    assert.equal(budget.reserved,0);assert.equal(Reflect.get(budget,'retryCount'),0);
    const second=client(source.fetch,new DownloadBudget(),path);await read(second,0,3);await read(second,block,block+3);
    assert.equal(source.ranges.length,2);
  });
});

test('verified persistent blocks survive retry exhaustion without reusing the partial failed block',async()=>{
  await directory(async path=>{
    const source=server(),budget=new DownloadBudget();let fail=false;
    const fetch:typeof globalThis.fetch=async(input,options)=>{
      if(!fail)return source.fetch(input,options);
      let delivered=false;
      return new Response(new ReadableStream<Uint8Array>({pull(stream){
        if(!delivered){delivered=true;stream.enqueue(new Uint8Array(19));}else stream.error(new TypeError('body failure'));
      }}),{status:206,headers:{'content-range':`bytes ${block}-${2*block-1}/${source.bytes.length}`}});
    };
    const c=client(fetch,budget,path);await read(c,0,3);fail=true;
    await assert.rejects(read(c,block,block+3),{name:'TypeError'});
    assert.equal(budget.downloadedBytes,block+57);assert.equal(budget.reserved,0);assert.equal((await readdir(join(path,'sentinel-ranges'))).length,1);
    const second=client(source.fetch,new DownloadBudget(),path);await read(second,0,3);await read(second,block,block+3);
    assert.equal(source.ranges.length,2);
  });
});

test('cancelling a stalled body counts delivered bytes and discards its incomplete block',async()=>{
  const controller=new AbortController(),budget=new DownloadBudget();let cancelled=false;
  const fetch:typeof globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({
    start(stream){stream.enqueue(new Uint8Array(32));setImmediate(()=>controller.abort());},
    cancel(){cancelled=true;}
  }),{status:206,headers:{'content-range':`bytes 0-${block-1}/${8*block}`}});
  const outcome=read(client(fetch,budget,undefined,controller.signal),0,3).then(()=>false,()=>true);
  const stopped=await Promise.race([outcome,new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(stopped,true,'a cancelled streaming response must not leave acquisition hanging');assert.equal(cancelled,true);
  assert.equal(budget.downloadedBytes,32);assert.equal(budget.reserved,0);assert.equal(Reflect.get(budget,'retryCount'),0);
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

test('parallel reads reserve remaining download capacity before either response arrives',async()=>{
  const source=server(),budget=new DownloadBudget();spend(budget,downloadLimit-block);
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const fetch:typeof globalThis.fetch=async(input,options)=>{started();await pending;return source.fetch(input,options);};
  const first=read(client(fetch,budget),0,3);await ready;
  assert.equal(budget.reserved,block);
  await assert.rejects(read(client(fetch,budget),block,block+3),{code:'IMAGE_DOWNLOAD_LIMIT'});
  release();await first;
  assert.equal(source.ranges.length,1);assert.equal(budget.downloadedBytes,downloadLimit);assert.equal(budget.reserved,0);
});

test('unused reservations are released and consumed bytes alone spend the uniform 512 MiB allowance',()=>{
  const budget=new DownloadBudget(),pending=reservation(budget,4*1024*1024);pending.consume(17);
  assert.equal(budget.downloadedBytes,17);assert.equal(budget.reserved,4*1024*1024-17);
  pending.release();pending.release();assert.equal(budget.reserved,0);
  spend(budget,downloadLimit-17);assert.equal(budget.downloadedBytes,downloadLimit);
  assert.throws(()=>budget.reserve(1),{code:'IMAGE_DOWNLOAD_LIMIT'});
});

test('single requests cannot reserve more than four MiB even with remaining task allowance',()=>{
  assert.throws(()=>new DownloadBudget().reserve(4*1024*1024+1),{code:'IMAGE_REQUEST_LIMIT'});
});

for(const limit of [0,64*1024*1024,128*1024*1024,512*1024*1024+1,Infinity])
  test(`unsupported acquisition budget ${limit} cannot change the uniform task cap`,()=>{
    assert.throws(()=>Reflect.construct(DownloadBudget,[undefined,limit]),{code:'IMAGE_REQUEST_INVALID'});
  });


test('an oversized streamed body counts delivered bytes then reports a response limit without retry',async()=>{
  const budget=new DownloadBudget(),held=reservation(budget,2),signal=new AbortController().signal;
  const response=new Response(new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new Uint8Array(3));stream.close();}}));
  try {await assert.rejects(readBoundedBody(response,2,signal,held.consume),{code:'IMAGE_RESPONSE_LIMIT'});}
  finally {held.release();}
  assert.equal(budget.downloadedBytes,3);assert.equal(budget.reserved,0);assert.equal(budget.retryCount,0);
});

test('an oversized declared response is rejected before reading its body',async()=>{
  const budget=new DownloadBudget(),held=reservation(budget,2),signal=new AbortController().signal;let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'content-length':'3'}});
  try {await assert.rejects(readBoundedBody(response,2,signal,held.consume),{code:'IMAGE_RESPONSE_LIMIT'});}
  finally {held.release();}
  assert.equal(cancelled,true);assert.equal(budget.downloadedBytes,0);assert.equal(budget.reserved,0);
});

test('prefetch rejects an offset beyond the maximum source length before any request',async()=>{
  const source=server(),budget=new DownloadBudget(),c=client(source.fetch,budget);
  await assert.rejects(prefetch(c,[{offset:2*1024*1024*1024,length:1}]),{code:'IMAGE_RANGE_UNSUPPORTED'});
  assert.equal(source.ranges.length,0);assert.equal(budget.downloadedBytes,0);assert.equal(budget.reserved,0);
});
