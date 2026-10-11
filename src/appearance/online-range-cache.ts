import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const RANGE_BLOCK_SIZE=64*1024;
const MAX_MEMORY=64*1024*1024,MAX_HEADER=4096,MAX_TOTAL=2*1024*1024*1024;
export interface RangeBlock {start:number;total:number;bytes:Uint8Array}
interface Header {schema:1;url:string;start:number;total:number;sha256:string}
const sha=(value:Uint8Array|string):string=>createHash('sha256').update(value).digest('hex');
const integrity=(header:Omit<Header,'sha256'>,bytes:Uint8Array):string=>createHash('sha256')
  .update(JSON.stringify({schema:header.schema,url:header.url,start:header.start,total:header.total})).update(bytes).digest('hex');
const filename=(url:string,start:number):string=>`${sha(url)}-${start}.block`;

/** A trusted root is supplied by the application; links below it are never cache entries. */
export async function validateCacheDirectory(root:string):Promise<void> {
  const parent=await lstat(root);
  if(!parent.isDirectory()||parent.isSymbolicLink()||resolve(await realpath(root))!==resolve(root))throw new Error('unsafe cache directory');
}
async function safeDirectory(root:string,create:boolean):Promise<string> {
  const directory=join(resolve(root),'sentinel-ranges');
  if(create)await mkdir(root,{recursive:true});
  await validateCacheDirectory(root);
  if(create)await mkdir(directory,{recursive:true});
  const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||resolve(await realpath(directory))!==directory)throw new Error('unsafe range cache');
  return directory;
}
async function readBlock(root:string,url:string,start:number):Promise<RangeBlock|undefined> {
  try {
    const directory=await safeDirectory(root,false),path=join(directory,filename(url,start)),before=await lstat(path);
    if(!before.isFile()||before.isSymbolicLink()||before.size<5||before.size>4+MAX_HEADER+RANGE_BLOCK_SIZE)return;
    const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const opened=await handle.stat();
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)return;
      const payload=new Uint8Array(opened.size);let offset=0;
      while(offset<payload.length) {
        const {bytesRead}=await handle.read(payload,offset,payload.length-offset,offset);if(!bytesRead)return;offset+=bytesRead;
      }
      const after=await handle.stat(),pathAfter=await lstat(path);
      if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||pathAfter.isSymbolicLink()||pathAfter.ino!==opened.ino)return;
      const length=new DataView(payload.buffer).getUint32(0,true);
      if(length<1||length>MAX_HEADER||4+length>=payload.length)return;
      const header=JSON.parse(new TextDecoder().decode(payload.subarray(4,4+length))) as Header,bytes=payload.slice(4+length);
      if(header.schema!==1||header.url!==url||header.start!==start||!Number.isSafeInteger(header.total)
        ||header.total<=start||header.total>MAX_TOTAL||bytes.length!==Math.min(RANGE_BLOCK_SIZE,header.total-start)
        ||typeof header.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(header.sha256)||integrity(header,bytes)!==header.sha256)return;
      return {start,total:header.total,bytes};
    } finally {await handle.close();}
  } catch {return;}
}
async function writeBlock(root:string,url:string,block:RangeBlock,signal:AbortSignal):Promise<void> {
  let temporary:string|undefined;
  try {
    signal.throwIfAborted();const directory=await safeDirectory(root,true);
    const identity={schema:1 as const,url,start:block.start,total:block.total},header:Header={...identity,sha256:integrity(identity,block.bytes)};
    const json=new TextEncoder().encode(JSON.stringify(header)),payload=new Uint8Array(4+json.length+block.bytes.length);
    new DataView(payload.buffer).setUint32(0,json.length,true);payload.set(json,4);payload.set(block.bytes,4+json.length);
    temporary=join(directory,`${filename(url,block.start)}.${randomUUID()}.tmp`);
    await writeFile(temporary,payload,{flag:'wx'});signal.throwIfAborted();
    await safeDirectory(root,false);await rename(temporary,join(directory,filename(url,block.start)));
  } catch {
    // Range caching is optional. A verified response still participates in final RGB validation.
  } finally {if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
}
interface Claim {start:number;resolve:(value:RangeBlock|undefined)=>void;reject:(error:unknown)=>void}
export interface AcquiredBlock {block:RangeBlock|undefined;cached:boolean}

/** Task-local memory and in-flight ownership, shared by every client in one download budget. */
export class RangeBlockCache {
  private readonly memory=new Map<string,RangeBlock>();
  private readonly pending=new Map<string,Promise<RangeBlock|undefined>>();
  private readonly totals=new Map<string,number>();
  private memoryBytes=0;
  total(url:string):number|undefined {return this.totals.get(url);}
  private remember(url:string,block:RangeBlock):void {
    const known=this.totals.get(url);if(known!==undefined&&known!==block.total)throw new Error('inconsistent source length');
    this.totals.set(url,block.total);const key=`${url}:${block.start}`,previous=this.memory.get(key);
    if(previous)this.memoryBytes-=previous.bytes.length;
    this.memory.delete(key);this.memory.set(key,block);this.memoryBytes+=block.bytes.length;
    while(this.memoryBytes>MAX_MEMORY) {
      const oldest=this.memory.entries().next().value!;this.memory.delete(oldest[0]);this.memoryBytes-=oldest[1].bytes.length;
    }
  }
  async acquire(url:string,starts:number[],root:string|undefined,signal:AbortSignal,
    download:(start:number,end:number)=>Promise<RangeBlock>):Promise<AcquiredBlock[]> {
    const claims:Claim[]=[],results:Promise<AcquiredBlock>[]=[],diskHits=new Set<number>();
    // Claim before any filesystem await: simultaneous TIFF reads cannot reserve the same block twice.
    for(const start of starts) {
      const key=`${url}:${start}`,cached=this.memory.get(key),pending=this.pending.get(key);
      if(cached) {this.memory.delete(key);this.memory.set(key,cached);results.push(Promise.resolve({block:cached,cached:true}));continue;}
      if(pending) {results.push(pending.then(block=>({block,cached:true})));continue;}
      let settle!:Claim;
      const promise=new Promise<RangeBlock|undefined>((resolve,reject)=>{settle={start,resolve,reject};});
      this.pending.set(key,promise);claims.push(settle);
      // A disk hit is marked separately after ownership resolves.
      results.push(promise.then(block=>({block,cached:diskHits.has(start)})));
    }
    const completion=Promise.all(results);
    if(claims.length) {
      const run=async()=>{
        try {
          const loaded=await Promise.all(claims.map(async claim=>root?readBlock(root,url,claim.start):undefined));
          const missing:Claim[]=[];
          for(let index=0;index<claims.length;index++) {
            const claim=claims[index],block=loaded[index];
            if(block&&(this.total(url)===undefined||this.total(url)===block.total)) {
              this.remember(url,block);diskHits.add(claim.start);claim.resolve(block);
            } else missing.push(claim);
          }
          for(let index=0;index<missing.length;) {
            signal.throwIfAborted();const first=missing[index],known=this.total(url);
            if(known!==undefined&&first.start>=known){first.resolve(undefined);index++;continue;}
            let next=index+1;
            while(next<missing.length&&missing[next].start===missing[next-1].start+RANGE_BLOCK_SIZE
              &&missing[next].start-first.start<4*1024*1024)next++;
            const end=Math.min(missing[next-1].start+RANGE_BLOCK_SIZE-1,(known??MAX_TOTAL)-1);
            const response=await download(first.start,end);
            for(let part=index;part<next;part++) {
              const claim=missing[part];
              if(claim.start>=response.total){claim.resolve(undefined);continue;}
              const offset=claim.start-response.start,block:RangeBlock={start:claim.start,total:response.total,
                bytes:response.bytes.slice(offset,Math.min(offset+RANGE_BLOCK_SIZE,response.bytes.length))};
              this.remember(url,block);if(root)await writeBlock(root,url,block,signal);claim.resolve(block);
            }
            index=next;
          }
        } catch(error) {for(const claim of claims)claim.reject(error);}
        finally {for(const claim of claims)this.pending.delete(`${url}:${claim.start}`);}
      };
      // Every rejection has a consumer before processing can start.
      void run();
    }
    return completion;
  }
}
