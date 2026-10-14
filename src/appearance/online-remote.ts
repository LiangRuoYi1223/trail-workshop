import { BaseClient, BaseResponse } from 'geotiff';
import { RANGE_BLOCK_SIZE, RangeBlockCache, type RangeBlock } from './online-range-cache.js';

const MAX_RANGE=4*1024*1024,MAX_DOWNLOAD=512*1024*1024,MAX_RAW_CACHE=64*1024*1024,MAX_TOTAL=2*1024*1024*1024;
const ASSET_HOSTS=new Set(['e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com','sentinel-cogs.s3.us-west-2.amazonaws.com']);
const TRANSIENT_CODES=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
export class SentinelImageError extends Error {
  constructor(public readonly code:string,message:string,cause?:unknown,public readonly status?:number) {
    super(message,{cause});this.name='SentinelImageError';
  }
}
export function imageFail(code:string,message:string):never {throw new SentinelImageError(code,message);}
export function safeSentinelAsset(value:unknown):string {
  if(typeof value!=='string'||value.length>2048) imageFail('IMAGE_SOURCE_UNSAFE','卫星影像地址不属于允许的公共数据源');
  let url:URL;try {url=new URL(value);} catch {return imageFail('IMAGE_SOURCE_UNSAFE','卫星影像地址无效');}
  if(url.protocol!=='https:'||!ASSET_HOSTS.has(url.hostname)||url.username||url.password||url.port||url.search||url.hash
    ||!url.pathname.endsWith('.tif')||/[%\\]/u.test(url.pathname))
    imageFail('IMAGE_SOURCE_UNSAFE','卫星影像地址不属于允许的公共 HTTPS 数据源');
  return url.href;
}
function transient(error:unknown,seen=new Set<unknown>()):boolean {
  if(!error||typeof error!=='object'||seen.has(error))return false;seen.add(error);
  if(error instanceof SentinelImageError)return error.status!==undefined&&(error.status===408||error.status===429||error.status>=500&&error.status<=599);
  const value=error as {name?:unknown;code?:unknown;cause?:unknown};
  if(value.name==='AbortError'||value.name==='TimeoutError')return false;
  return error instanceof TypeError||typeof value.code==='string'&&TRANSIENT_CODES.has(value.code)||transient(value.cause,seen);
}
export interface DownloadReservation {consume(bytes:number):void;release():void}
/** Delivered bytes spend the task allowance; reservations protect only bytes still in flight. */
export class DownloadBudget {
  reserved=0;
  downloadedBytes=0;
  cacheBytes=0;
  requestCount=0;
  catalogRequestCount=0;
  rangeRequestCount=0;
  private retries=0;
  get retryCount():number {return this.retries;}
  readonly blocks=new RangeBlockCache();
  constructor(public readonly onProgress?:()=>void,public readonly downloadBudgetBytes=MAX_DOWNLOAD) {
    if(downloadBudgetBytes!==MAX_DOWNLOAD)imageFail('IMAGE_REQUEST_INVALID','卫星影像累计下载额度统一为 512 MB');
  }
  failure?:SentinelImageError;
  reserve(bytes:number):DownloadReservation {
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_RANGE)this.fail('IMAGE_REQUEST_LIMIT','卫星影像单次读取超出 4 MB 限制');
    if(this.downloadedBytes+this.reserved+bytes>this.downloadBudgetBytes)this.fail('IMAGE_DOWNLOAD_LIMIT','卫星影像下载额度耗尽（512 MB），请缩小取景范围');
    this.reserved+=bytes;let remaining=bytes,released=false;
    return {
      consume:(count:number)=>{
        if(released||!Number.isSafeInteger(count)||count<0)imageFail('IMAGE_REQUEST_INVALID','卫星影像下载字节记账无效');
        const held=Math.min(remaining,count);remaining-=held;this.reserved-=held;this.downloadedBytes+=count;this.onProgress?.();
        if(count>held)this.fail('IMAGE_RESPONSE_LIMIT','卫星影像响应超出单次读取限制');
      },
      release:()=>{if(released)return;released=true;this.reserved-=remaining;remaining=0;}
    };
  }
  async retry<T>(operation:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T> {
    while(true) {
      signal.throwIfAborted();
      try {return await operation(signal);} catch(error) {
        signal.throwIfAborted();
        if(!transient(error)||this.retries>=2) {
          if(transient(error))this.failure=new SentinelImageError('IMAGE_NETWORK_FAILED',`两次重试后网络仍无法读取夏季影像：${error instanceof Error?error.message:String(error)}`,error,error instanceof SentinelImageError?error.status:undefined);
          else if(error instanceof SentinelImageError)this.failure=error;
          throw error;
        }
        this.retries++;this.onProgress?.();
      }
    }
  }
  fail(code:string,message:string):never {this.failure=new SentinelImageError(code,message);throw this.failure;}
}
export async function readBoundedBody(response:Response,limit:number,signal:AbortSignal,onChunk?:(bytes:number)=>void):Promise<Uint8Array> {
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/u.test(length)||Number(length)>limit)) {
    await response.body?.cancel().catch(()=>{});imageFail('IMAGE_RESPONSE_LIMIT','卫星影像响应超出单次读取限制');
  }
  if(!response.body)imageFail('IMAGE_NETWORK_FAILED','卫星影像响应为空');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0;
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    while(true) {
      signal.throwIfAborted();const {done,value}=await reader.read();
      // Account bytes before a racing cancellation or an oversized-body validation rejects them.
      if(value){onChunk?.(value.length);total+=value.length;}
      signal.throwIfAborted();if(done)break;
      if(total>limit)imageFail('IMAGE_RESPONSE_LIMIT','卫星影像响应超出单次读取限制');
      parts.push(value);
    }
  } catch(error) {await reader.cancel().catch(()=>{});throw error;} finally {
    signal.removeEventListener('abort',abort);reader.releaseLock();
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return bytes;
}
class RangeResponse extends BaseResponse {
  constructor(private readonly response:Response,private readonly bytes:Uint8Array){super();}
  get status():number {return this.response.status;}
  getHeader(name:string):string|undefined {return this.response.headers.get(name)??undefined;}
  async getData():Promise<ArrayBuffer> {return this.bytes.buffer as ArrayBuffer;}
}
export class SentinelRangeClient extends BaseClient {
  constructor(url:string,private readonly transport:typeof globalThis.fetch,private readonly signal:AbortSignal,
    private readonly budget:DownloadBudget,private readonly cacheDir?:string){super(safeSentinelAsset(url));}
  async prefetch(ranges:Array<{offset:number;length:number}>,extraSignal?:AbortSignal):Promise<void> {
    const signal=extraSignal?AbortSignal.any([this.signal,extraSignal]):this.signal;signal.throwIfAborted();
    const starts=new Set<number>(),known=this.budget.blocks.total(this.url);
    for(const range of ranges) {
      const end=range.offset+range.length-1;
      if(!Number.isSafeInteger(range.offset)||range.offset<0||!Number.isSafeInteger(range.length)||range.length<1||!Number.isSafeInteger(end))
        this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像读取范围无效');
      if(range.length>MAX_RANGE)this.budget.fail('IMAGE_REQUEST_LIMIT','卫星影像单次读取超出 4 MB 限制');
      if(range.offset>=(known??MAX_TOTAL))this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像读取范围超出文件末尾');
      for(let offset=Math.floor(range.offset/RANGE_BLOCK_SIZE)*RANGE_BLOCK_SIZE;offset<=Math.min(end,(known??MAX_TOTAL)-1);offset+=RANGE_BLOCK_SIZE) {
        starts.add(offset);
        if(starts.size*RANGE_BLOCK_SIZE>MAX_RAW_CACHE)this.budget.fail('IMAGE_REQUEST_LIMIT','卫星影像预取块组超出 64 MB 内存缓存限制');
      }
    }
    await this.budget.blocks.acquire(this.url,[...starts].sort((a,b)=>a-b),this.cacheDir,signal,
      (from,to)=>this.download(from,to,new Headers(),signal));signal.throwIfAborted();
    this.budget.onProgress?.();
  }
  async request(options:RequestInit={}):Promise<BaseResponse> {
    const signal=options.signal?AbortSignal.any([this.signal,options.signal]):this.signal;signal.throwIfAborted();
    const headers=new Headers(options.headers),match=/^bytes=(\d+)-(\d+)$/u.exec(headers.get('range')??'');
    if(!match)this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像必须按有限范围读取');
    const start=Number(match[1]),wantedEnd=Number(match[2]),length=wantedEnd-start+1;
    if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(wantedEnd)||length<1)this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像读取范围无效');
    if(length>MAX_RANGE)this.budget.fail('IMAGE_REQUEST_LIMIT','卫星影像单次读取超出 4 MB 限制');
    const total=this.budget.blocks.total(this.url),end=Math.min(wantedEnd,(total??MAX_TOTAL)-1);
    if(start>end)this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像读取范围超出文件末尾');
    const starts:number[]=[];
    for(let offset=Math.floor(start/RANGE_BLOCK_SIZE)*RANGE_BLOCK_SIZE;offset<=end;offset+=RANGE_BLOCK_SIZE)starts.push(offset);
    const blocks=await this.budget.blocks.acquire(this.url,starts,this.cacheDir,signal,(from,to)=>this.download(from,to,headers,signal));
    signal.throwIfAborted();const fileSize=this.budget.blocks.total(this.url);
    if(fileSize===undefined||start>=fileSize)this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像读取范围超出文件末尾');
    const actualEnd=Math.min(wantedEnd,fileSize-1),bytes=new Uint8Array(actualEnd-start+1);let copied=0;
    for(const value of blocks) {
      const block=value.block;if(!block)continue;
      const from=Math.max(start,block.start),to=Math.min(actualEnd+1,block.start+block.bytes.length);if(to<=from)continue;
      bytes.set(block.bytes.subarray(from-block.start,to-block.start),from-start);copied+=to-from;
      if(value.cached)this.budget.cacheBytes+=to-from;
    }
    if(copied!==bytes.length)this.budget.fail('IMAGE_RANGE_UNSUPPORTED','卫星影像缓存未完整覆盖读取范围');
    this.budget.onProgress?.();
    return new RangeResponse(new Response(null,{status:206,headers:{'content-range':`bytes ${start}-${actualEnd}/${fileSize}`,
      'content-length':String(bytes.length)}}),bytes);
  }
  private async download(start:number,wantedEnd:number,originalHeaders:Headers,signal:AbortSignal):Promise<RangeBlock> {
    return this.budget.retry(async()=>{
      signal.throwIfAborted();const reservation=this.budget.reserve(wantedEnd-start+1);
      try {
        const headers=new Headers(originalHeaders);headers.set('range',`bytes=${start}-${wantedEnd}`);
        this.budget.requestCount++;this.budget.rangeRequestCount++;
        const response=await this.transport(this.url,{method:'GET',headers,signal,redirect:'error'});
        if(!response.ok) {
          await response.body?.cancel().catch(()=>{});
          throw new SentinelImageError('IMAGE_NETWORK_FAILED',`公共影像服务返回 HTTP ${response.status}`,undefined,response.status);
        }
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range')??'');
        if(response.status!==206||!range) {
          await response.body?.cancel().catch(()=>{});this.budget.fail('IMAGE_RANGE_UNSUPPORTED','公共影像服务未提供有效的范围响应，请重试或本地导入');
        }
        const actualStart=Number(range[1]),end=Number(range[2]),total=Number(range[3]);
        if(!Number.isSafeInteger(total)||total<1||total>MAX_TOTAL||!Number.isSafeInteger(end)||actualStart!==start
          ||end!==Math.min(wantedEnd,total-1)||end<start) {
          await response.body?.cancel().catch(()=>{});this.budget.fail('IMAGE_RANGE_UNSUPPORTED','公共影像服务返回了不匹配的读取范围');
        }
        const bytes=await readBoundedBody(response,end-start+1,signal,reservation.consume);
        if(bytes.length!==end-start+1)this.budget.fail('IMAGE_RANGE_UNSUPPORTED','公共影像服务返回了不完整的读取范围');
        return {start,total,bytes};
      } finally {reservation.release();}
    },signal);
  }
}
