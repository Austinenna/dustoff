// 收件箱预下载：模型拿不准或 B站默认待确认的视频，先按“保存视频”的规格下载到暂存目录，
// 让用户在收件箱里看完再决定。选“保存视频”时移进收藏目录；选“知识笔记”时原地转写，
// 整理完由清理规则删除；放弃、删除记录或无法复用时删掉暂存文件。调用方须持有流水线锁。
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { REVIEW_MEDIA, SAVED_MEDIA, PREVIEW_MAX_SECONDS, POLICY, localPath, under } from './policy.mjs';
import { db, clearMedia } from './ledger.mjs';

export const isPreview = row => !!row?.media_path && !row.media_deleted && under(localPath(row.media_path), REVIEW_MEDIA);

/** 是否需要预下载：待确认、有视频、时长已知且不超过预下载和平台上限、还没有媒体文件。 */
export function previewEligible(row) {
  if (!row || row.status !== 'review' || ['gallery', 'post'].includes(row.media_type) || row.media_path) return false;
  const seconds = Number(row.duration_s);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PREVIEW_MAX_SECONDS) return false;
  return seconds <= (POLICY[row.platform]?.seconds ?? POLICY.seconds);
}

// 暂存目录固定为 REVIEW_MEDIA/<作品ID>；不是这个位置的路径一律不动。
function previewDir(row) {
  const dir = dirname(localPath(row.media_path));
  if (dirname(dir) !== REVIEW_MEDIA || basename(dir) !== row.id) throw new Error('预下载文件位置异常，已停止处理');
  return dir;
}

export function dropPreview(row) {
  if (!isPreview(row)) return false;
  rmSync(previewDir(row), { recursive: true, force: true });
  clearMedia(row.id);
  return true;
}

/**
 * 用户选定用途时处理预下载文件。返回 'saved'（已移进收藏目录）、'kept'（留在原地供转写）、
 * 'dropped'（已删除，按原流程重新获取）或 null（没有预下载）。
 * reusable=false：B站笔记优先用字幕、或选了与预下载不同的画质，不复用这份文件。
 */
export function adoptPreview(row, purpose, { reusable = true } = {}) {
  if (!isPreview(row)) return null;
  if (!reusable || !['video', 'note'].includes(purpose)) { dropPreview(row); return 'dropped'; }
  if (purpose === 'note') return 'kept';
  const from = previewDir(row), to = localPath(join(SAVED_MEDIA, row.id));
  // 收藏目录里已有同名目录时不覆盖，删掉暂存文件，由原流程复用或重新下载。
  if (existsSync(to)) { dropPreview(row); return 'dropped'; }
  mkdirSync(SAVED_MEDIA, { recursive: true });
  renameSync(from, to);
  db().prepare('UPDATE items SET media_path=?,updated_at=? WHERE platform=? AND id=?')
    .run(join(to, basename(row.media_path)), Math.floor(Date.now() / 1000), row.platform, row.id);
  return 'saved';
}
