// 仅通过账本中的作品 ID 读取媒体；预览缓存可重建，原文件始终只读。
import { createHash } from 'node:crypto';
import { createReadStream, statSync, lstatSync, statfsSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './console-store.mjs';
import { localPath } from './policy.mjs';

const MiB=1024**2,CAP=512*MiB,RESERVE=256*MiB;
const execute=promisify(execFile);
const cacheName=/^\d+-[a-f0-9]{24}-(poster\.jpg|playback\.mp4)$/;

export function byteRange(header,size) {
  if(header===undefined)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2])||size===0)throw new HttpError(416,'视频范围无效');
  let start,end;
  if(!match[1]){const count=Number(match[2]);if(!Number.isSafeInteger(count)||count<=0)throw new HttpError(416,'视频范围无效');start=Math.max(0,size-count);end=size-1;}
  else {start=Number(match[1]);end=match[2]?Number(match[2]):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new HttpError(416,'视频范围无效');
  return {start,end:Math.min(end,size-1)};
}

export async function streamMedia(req,res,file,headers) {
  const size=statSync(file).size;
  const type=({'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif'})[extname(file)]||'application/octet-stream';
  let range;
  try{range=byteRange(req.headers.range,size);}catch(e){res.writeHead(416,{...headers,'Accept-Ranges':'bytes','Content-Range':`bytes */${size}`,'Content-Length':0});res.end();return;}
  const start=range?.start||0,end=range?.end??size-1;
  const stream=req.method==='HEAD'||size===0?null:createReadStream(file,{start,end});
  // 在发送响应头前捕获文件被外部移动/清理的情况。
  if(stream)await new Promise((resolve,reject)=>{stream.once('open',resolve);stream.once('error',reject);});
  res.writeHead(range?206:200,{...headers,'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':size===0?0:end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  if(!stream){res.end();return;}
  try{await pipeline(stream,res);}catch(e){if(!res.destroyed)res.destroy(e);}
}

export function createMediaService({store,home,run=execute}) {
  const cache=localPath(join(home,'console','media-preview')),posters=new Map(),jobs=new Map();
  let converting=false;
  function spec(id,kind) {
    const source=store.fileFor(id,'video'),st=statSync(source);
    const key=createHash('sha256').update(`${source}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0,24);
    return {source,key,file:localPath(join(cache,`${id}-${key}-${kind==='poster'?'poster.jpg':'playback.mp4'}`))};
  }
  function reserve(bytes) {
    mkdirSync(cache,{recursive:true,mode:0o700});
    // 只回收此功能生成的缓存，绝不遍历或删除收藏目录。
    const files=readdirSync(cache).filter(n=>cacheName.test(n)).map(n=>{const path=join(cache,n),st=lstatSync(path);return {path,size:st.size,mtimeMs:st.mtimeMs,regular:st.isFile()};}).filter(f=>f.regular).sort((a,b)=>a.mtimeMs-b.mtimeMs);
    let used=files.reduce((n,f)=>n+f.size,0);
    for(const f of files){if(used+bytes<=CAP)break;rmSync(f.path);used-=f.size;}
    const fs=statfsSync(cache);
    if(Number(fs.bavail)*Number(fs.bsize)-bytes<store.policy().free)throw new HttpError(409,'可用空间不足，暂不能生成视频预览；可用外部播放器打开原文件');
  }
  async function generate(s,kind) {
    reserve(kind==='poster'?MiB:RESERVE);
    const part=s.file+'.part';
    try {
      const common=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-protocol_whitelist','file,pipe','-i',s.source,'-map','0:v:0','-map_metadata','-1'];
      const args=kind==='poster'
        ? [...common,'-frames:v','1','-vf','scale=480:480:force_original_aspect_ratio=decrease','-q:v','4','-threads','1','-f','image2',part]
        : [...common,'-map','0:a:0?','-vf','scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1','-c:v','libx264','-preset','fast','-crf','23','-maxrate','3000k','-bufsize','6000k','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','128k','-movflags','+faststart','-f','mp4',part];
      await run('ffmpeg',args,{timeout:kind==='poster'?30000:480000,maxBuffer:128*1024});
      if(!existsSync(part)||!statSync(part).size||statSync(part).size>(kind==='poster'?MiB:RESERVE))throw new Error('invalid output');
      if(spec(s.id,kind).key!==s.key)throw new Error('source changed');
      renameSync(part,s.file);return s.file;
    } catch(e){rmSync(part,{force:true});throw new HttpError(e.code==='ENOENT'?503:400,e.code==='ENOENT'?'生成预览需要本机 ffmpeg，请安装后重试':'未能生成视频预览，可用外部播放器打开原文件');}
  }
  async function poster(id) {
    const s={...spec(id,'poster'),id};if(existsSync(s.file))return s.file;
    if(!posters.has(s.file)){
      // 每次只解码一个封面，避免列表同时启动大量进程。
      const previous=Array.from(posters.values()).at(-1)||Promise.resolve();
      const task=previous.catch(()=>{}).then(()=>generate(s,'poster')).finally(()=>posters.delete(s.file));
      posters.set(s.file,task);
    }
    return posters.get(s.file);
  }
  function status(id) {
    const s=spec(id,'playback');if(existsSync(s.file))return {state:'ready'};
    return jobs.get(s.file)||{state:'idle'};
  }
  function prepare(id) {
    const s={...spec(id,'playback'),id};const current=status(id);
    if(['ready','processing'].includes(current.state))return current;
    if(converting)throw new HttpError(409,'另一个视频正在准备播放，请稍后重试');
    // 空间错误同步返回；转码在后台完成，页面可随时关闭。
    reserve(RESERVE);converting=true;jobs.set(s.file,{state:'processing'});
    void generate(s,'playback').then(()=>jobs.delete(s.file),e=>jobs.set(s.file,{state:'failed',error:e.message})).finally(()=>{converting=false;});
    return {state:'processing'};
  }
  function video(id,compatible=false) {
    if(!compatible)return store.fileFor(id,'video');
    const s=spec(id,'playback');if(!existsSync(s.file))throw new HttpError(404,'播放副本尚未准备好');return s.file;
  }
  return {poster,prepare,status,video};
}
