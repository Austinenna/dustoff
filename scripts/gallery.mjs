// 图集只保存图片：逐张校验和续传，整组完成后发布本地清单。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SAVED_MEDIA, localPath, under, atomicWrite, writeMedia, storage, requestSignal, deadlineMs, PauseError } from './policy.mjs';
import { isExpired } from './lib.mjs';

export const IMAGE_TYPES = { jpg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', avif:'image/avif' };
const imageName = /^\d{3,4}\.(jpg|png|webp|gif|avif)$/;
function inspect(file) {
  if (!statSync(file).isFile() || statSync(file).size === 0) throw new Error('图片文件为空');
  const mime = spawnSync('file', ['-b','--mime-type',file], {encoding:'utf8',timeout:deadlineMs(15000)});
  const ext = Object.keys(IMAGE_TYPES).find(key => IMAGE_TYPES[key] === mime.stdout?.trim());
  if (mime.status !== 0 || !ext) throw new Error('下载内容不是支持的图片格式');
  const probe = spawnSync('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file], {encoding:'utf8',timeout:deadlineMs(15000)});
  const stream = probe.status === 0 ? JSON.parse(probe.stdout).streams?.[0] : null;
  if (!(stream?.width > 0 && stream?.height > 0)) throw new Error('图片无法解码');
  return {ext,width:stream.width,height:stream.height,bytes:statSync(file).size};
}

/** 只读已完成图集；文件名和解析后的路径都必须留在清单目录内。 */
export function readGallery(path, id) {
  path = localPath(path);
  if (!existsSync(path) || statSync(path).size > 1024**2) throw new Error('图集清单不存在或过大');
  const data = JSON.parse(readFileSync(path,'utf8'));
  if (data.version !== 1 || data.id !== String(id) || !Array.isArray(data.images) || !data.images.length || data.images.length > 1000) throw new Error('图集清单无效');
  const root = dirname(path);
  const images = data.images.map((image,index) => {
    if (!imageName.test(image.file) || image.index !== index || !Number.isSafeInteger(image.bytes) || image.bytes <= 0) throw new Error('图片记录无效');
    const file = localPath(join(root,image.file));
    if (!under(file,root) || !existsSync(file) || !statSync(file).isFile() || statSync(file).size !== image.bytes) throw new Error('图集图片缺失或已修改');
    return {...image,path:file};
  });
  return {images,path};
}

export async function downloadGallery(item) {
  const id = String(item.aweme_id);
  if (!/^\d+$/.test(id)) throw new Error('作品 ID 不合法');
  if (!Array.isArray(item.images) || !item.images.length || item.images.length > 1000) throw new Error('缺少图集图片信息，需要刷新');
  const dir = localPath(join(SAVED_MEDIA,id,'images')), manifest = join(dir,'gallery.json');
  const images = [];
  for (const [index,image] of item.images.entries()) {
    deadlineMs();
    const urls = Array.isArray(image.urls) ? image.urls : [];
    const key = createHash('sha256').update(JSON.stringify([image.uri || urls,image.width,image.height])).digest('hex');
    const stem = String(index+1).padStart(3,'0'), receipt = join(dir,stem+'.json'), part = join(dir,stem+'.part');
    let cached;
    try {
      cached = JSON.parse(readFileSync(receipt,'utf8'));
      if (cached.key !== key || !imageName.test(cached.file)) throw new Error('图片来源改变');
      const file = localPath(join(dir,cached.file));
      if (!under(file,dir)) throw new Error('图片位置无效');
      const checked = inspect(file);
      if (checked.bytes !== cached.bytes) throw new Error('图片大小改变');
      images.push({index,file:cached.file,...checked});continue;
    } catch { /* 只重下缺失或无效的图片，保留其他已完成图片。 */ }
    let last, downloaded = false;
    for (const url of urls.filter(url => typeof url === 'string' && /^https?:\/\//.test(url) && !isExpired([url]))) {
      try {
        storage(0,{retain:true});
        const response = await fetch(url,{signal:requestSignal(),headers:{Referer:'https://www.douyin.com/','User-Agent':'Mozilla/5.0'}});
        if (!response.ok) { await response.body?.cancel();throw new Error(`图片下载 HTTP ${response.status}`); }
        try { const size = Number(response.headers.get('content-length'));if (size > 0) storage(size,{retain:true}); }
        catch(e) { await response.body?.cancel();throw e; }
        await writeMedia(response.body,part);
        const checked = inspect(part), file = stem+'.'+checked.ext;
        renameSync(part,localPath(join(dir,file)));
        const entry = {index,file,...checked};
        atomicWrite(receipt,JSON.stringify({...entry,key}));
        images.push(entry);downloaded = true;break;
      } catch(e) {
        rmSync(part,{force:true});
        if (e instanceof PauseError) throw e;
        last = e;
      }
    }
    if (!downloaded) throw new Error(`第 ${index+1}/${item.images.length} 张图片未完成：${last?.message || '地址缺失或过期，需要刷新'}`);
  }
  atomicWrite(manifest,JSON.stringify({version:1,id,title:item.desc||'',author:item.author||'',source:`https://www.douyin.com/note/${id}`,images},null,2));
  readGallery(manifest,id);
  return {aweme_id:id,status:'done',path:manifest,bytes:images.reduce((n,image)=>n+image.bytes,0),image_count:images.length,has_audio:false,quality:'original'};
}
