// 用户主动把已保存的视频转为笔记；调用方须持有流水线锁。
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {extname} from 'node:path';
import {expand} from './config.mjs';
import {db,cleanable} from './ledger.mjs';
import {inScope,setPurpose} from './daily.mjs';
import {localPath,under,SAVED_MEDIA,mediaDecision} from './policy.mjs';
import {deleteLocalVideo} from './delete-video.mjs';

export function queueVideoToNote(id) {
  if(!/^\d{1,30}$/.test(String(id)))throw new Error('作品 ID 无效');
  const d=db(),row=d.prepare("SELECT * FROM items WHERE platform='douyin' AND id=?").get(String(id));
  if(!row||row.media_type==='gallery'||row.media_deleted||!row.media_path||!inScope(String(id))
    ||['baseline','gallery','too_long'].includes(row.skip_reason)||row.status==='removed')throw new Error('这条作品不支持从本地视频转为笔记');
  // 重复点击只返回原有请求，不重置已经完成的阶段或失败计数。
  if(row.delete_after_note&&row.processing_mode==='note')return {queued:true,alreadyQueued:true};
  if(row.processing_mode!=='video'&&!(row.processing_mode==null&&row.status==='saved'))throw new Error('只能将已保存的视频转为笔记');
  if(mediaDecision(row))throw new Error('视频时长未知或超过当前转写上限');
  const file=expand(row.media_path),resolved=localPath(file);
  if(!under(resolved,SAVED_MEDIA)||!existsSync(file)||!lstatSync(file).isFile()
    ||!['.mp4','.mov','.webm','.m4v'].includes(extname(resolved)))throw new Error('本地原视频不存在或不在视频收藏目录，未加入待办');
  if(row.has_audio===0)throw new Error('本地视频没有音轨，无法转为笔记');
  d.exec('BEGIN IMMEDIATE');
  try {
    setPurpose(String(id),'note');
    d.prepare("UPDATE items SET delete_after_note=1 WHERE platform='douyin' AND id=?").run(String(id));
    d.exec('COMMIT');
  } catch(e) {d.exec('ROLLBACK');throw e;}
  return {queued:true,alreadyQueued:false};
}

// 普通收藏视频继续保留。仅清理用户点过转换且笔记、原稿均可靠落盘的文件。
export async function cleanConvertedVideos({trashFile,log=()=>{}}={}) {
  const result={n:0,held:0,failures:[]};
  for(const row of cleanable('douyin')) {
    if(!row.delete_after_note||!inScope(row.id))continue;
    try {
      const media=localPath(row.media_path),text=localPath(row.text_path||''),note=localPath(row.note_path||'');
      if(!under(media,SAVED_MEDIA)||!existsSync(text)||!existsSync(note)) {result.held++;continue;}
      const transcript=readFileSync(text,'utf8');
      if(!transcript.trim()||transcript.length!==row.text_chars||!readFileSync(note,'utf8').trim()) {result.held++;continue;}
      await deleteLocalVideo({id:row.id,trashFile,afterNote:true});
      result.n++;log(`笔记已保存，原视频已移入废纸篓 ${row.id}`);
    } catch(e) {
      result.failures.push({id:row.id,error:`笔记已保存，原视频清理未完成：${e.message}`});
      log(`原视频清理未完成 ${row.id}：${e.message}`);
    }
  }
  return result;
}
