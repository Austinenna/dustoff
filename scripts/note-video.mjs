// 给已有笔记的条目下载视频后的运行收尾；调用方须持有流水线锁。
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, restoreNote } from './ledger.mjs';
import { MEDIA, SAVED_MEDIA, localPath, under } from './policy.mjs';
import { validItemId } from './platforms.mjs';

const REASONS = { unavailable:'作品已失效', too_long:'超过时长上限', unknown_duration:'拿不到可靠时长', no_url:'没有下载地址' };
const withNote = "processing_mode='video' AND note_path IS NOT NULL AND note_path!=''";

export function settleNoteVideos({ log = () => {} } = {}) {
  const result = { restored:0, removed:0 };
  // 下载不成的回到知识笔记，用户可以在详情看到原因后再试。
  for (const row of db().prepare(`SELECT id,platform,skip_reason FROM items WHERE ${withNote} AND status='skipped' AND COALESCE(skip_reason,'')!='user_deleted'`).all()) {
    const reason = REASONS[row.skip_reason] || row.skip_reason || '原因未知';
    restoreNote(row.id, `高清视频未下载：${reason}`, row.platform);
    result.restored++; log(`高清视频未下载 ${row.id}：${reason}，笔记不受影响`);
  }
  // 高清视频到位后，转写用的低清素材不再有用；账本已不指向它，要在这里清掉。
  for (const row of db().prepare(`SELECT id,media_path FROM items WHERE ${withNote} AND status='saved' AND media_path IS NOT NULL AND COALESCE(media_deleted,0)=0`).all()) {
    const old = localPath(join(MEDIA, row.id));
    if (!validItemId(row.id) || !existsSync(old) || !under(localPath(row.media_path), SAVED_MEDIA) || !existsSync(localPath(row.media_path))) continue;
    rmSync(old, { recursive:true, force:true });
    result.removed++; log(`已清理低清素材 ${row.id}`);
  }
  return result;
}
