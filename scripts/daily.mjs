import { readFileSync, existsSync } from 'node:fs';
import { localPath, under, SAVED_MEDIA } from './policy.mjs';
import { PURPOSES } from './routing.mjs';
import { db, importScan } from './ledger.mjs';
import { boundaryIndex } from './incremental.mjs';
import { POLICY, mediaDecision } from './policy.mjs';
function database() {
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_queue (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, enqueued INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_usage (day TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(day,id));`);
  return d;
}
export function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function baseline() {
  const r = database().prepare("SELECT value FROM daily_state WHERE name='baseline'").get();
  return r ? JSON.parse(r.value) : null;
}
export class ScanError extends Error {}
export function acceptScan(scan) {
  if (!scan?.ok || !scan.logged_in || scan.scan_error || !Array.isArray(scan.items)) {
    const detail = scan?.scan_error ? `：${String(scan.scan_error).replace(/https?:\/\/\S+/g,'[地址已隐藏]').slice(0,240)}` : '';
    throw new ScanError(`扫描未完整成功，保留原基线与待办${detail}`);
  }
  for (const it of scan.items) if (!/^\d+$/.test(String(it?.aweme_id))) throw new ScanError('扫描包含无效作品 ID');
  const d = database(), old = baseline();
  if (!old && scan.items.length < POLICY.scan && scan.truncated !== false) throw new ScanError('首次扫描不足基线窗口且未确认到列表末尾，请重试');
  if (!old && scan.items.length < 100 && scan.truncated !== false) throw new ScanError('首次基线需要 100 条或已确认的完整列表');
  if (old && !old.anchors.length && scan.truncated !== false) throw new ScanError('原基线为空，需确认当前完整列表后才可推进');
  const cut = old ? boundaryIndex(scan.items, old.anchors) : 0;
  if (old && cut < 0) throw new ScanError('没有确认到旧边界，保留进度；请检查收藏列表后重试');
  const head = old ? scan.items : scan.items.slice(0, 100);
  const novel = old ? head.slice(0, cut) : [];
  let added = 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    // importScan 使用 SAVEPOINT，可以和边界、队列一起提交。
    const known = new Set(d.prepare("SELECT id FROM items WHERE platform='douyin'").all().map(r => r.id));
    importScan(head);
    const put = d.prepare('INSERT OR IGNORE INTO daily_queue(id,metadata,enqueued) VALUES(?,?,?)');
    const skip = d.prepare("UPDATE items SET status='skipped',skip_reason=? WHERE platform='douyin' AND id=? AND status='pending'");
    for (const it of novel) {
      if (known.has(it.aweme_id)) continue;
      const reason = mediaDecision(it);
      if (reason && reason !== 'unknown_duration') { skip.run(reason, it.aweme_id); continue; }
      added += put.run(it.aweme_id, JSON.stringify({ ...it, fetched_at: scan.fetched_at }), Date.now()).changes;
    }
    if (!old) for (const it of head) { if (!known.has(it.aweme_id)) skip.run('baseline', it.aweme_id); }
    // 刷新已排队条目的地址，但不把已知的历史收藏变成待办。
    const refresh = d.prepare('UPDATE daily_queue SET metadata=? WHERE id=?');
    for (const it of head) refresh.run(JSON.stringify({ ...it, fetched_at: scan.fetched_at }), it.aweme_id);
    const anchors = [...new Set([...head.map(i => i.aweme_id), ...(old?.anchors || [])])].slice(0, 100);
    const state = { created_at: old?.created_at || Date.now(), scanned_at: Date.now(), anchors };
    d.prepare("INSERT INTO daily_state VALUES('baseline',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
    d.exec('COMMIT');
    return { initialized: !old, added, scanned: head.length };
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}
export function pendingQueue() {
  return database().prepare(`SELECT i.*, q.metadata FROM daily_queue q JOIN items i ON i.id=q.id AND i.platform='douyin'
    WHERE i.status IN ('pending','downloaded','transcribed') AND i.attempts < 3
    ORDER BY q.enqueued ASC, q.rowid DESC`).all();
}
export function inScope(id) { return !!database().prepare('SELECT 1 FROM daily_queue WHERE id=?').get(id); }
export function reserveDaily(id, day = localDay()) {
  const d = database();
  d.exec('BEGIN IMMEDIATE');
  try {
    const used = d.prepare('SELECT COUNT(*) n FROM daily_usage WHERE day=?').get(day).n;
    const already = d.prepare('SELECT 1 FROM daily_usage WHERE day=? AND id=?').get(day,id);
    if (!already && used >= POLICY.daily) { d.exec('COMMIT'); return false; }
    d.prepare('INSERT OR IGNORE INTO daily_usage VALUES(?,?)').run(day,id);
    d.exec('COMMIT'); return true;
  } catch(e) { d.exec('ROLLBACK'); throw e; }
}
export function usage(day = localDay()) { return database().prepare('SELECT COUNT(*) n FROM daily_usage WHERE day=?').get(day).n; }

export function retryItem(id) {
  const d = database();
  if (!inScope(id)) throw new Error('条目不在本次启用范围内');
  const row = d.prepare("SELECT * FROM items WHERE platform='douyin' AND id=?").get(id);
  if (!row || ['extracted','saved','review'].includes(row.status) || row.skip_reason === 'baseline') throw new Error('已完成或基线条目不能作为失败待办重试');
  if (row.skip_reason === 'too_long' || row.skip_reason === 'gallery') throw new Error('本轮不支持恢复主动跳过的内容');
  if (row.media_type === 'gallery') {
    d.prepare("UPDATE items SET status='pending',attempts=0,last_error=NULL WHERE platform='douyin' AND id=?").run(id);
    return 'pending';
  }
  let status = 'pending';
  const profile = PURPOSES[row.processing_mode || 'note'];
  if (!profile) throw new Error('旧用途需要先按新规则重新判断');
  const mediaReady = row.media_path && !row.media_deleted && existsSync(localPath(row.media_path))
    && (profile.quality !== 'high' || row.media_quality === 'high')
    && (!profile.retain || under(localPath(row.media_path), SAVED_MEDIA));
  // 改用途后可能仍有旧转写稿；保留视频的路径必须先取得符合新规格的素材。
  if (profile.transcribe && (!profile.retain || mediaReady) && row.transcribed_at && row.text_path && existsSync(localPath(row.text_path)) && readFileSync(localPath(row.text_path),'utf8').length === row.text_chars) status = 'transcribed';
  else if (mediaReady) status = 'downloaded';
  d.prepare("UPDATE items SET status=?,attempts=0,last_error=NULL WHERE platform='douyin' AND id=?").run(status,id);
  return status;
}

/** 手动用途覆盖保留已有成果，重新排队；不处理历史基线、图集或超长条目。 */
export function setPurpose(id, purpose) {
  if (!['note','video','review'].includes(purpose)) throw new Error('用途无效');
  const d = database(), row = d.prepare("SELECT * FROM items WHERE platform='douyin' AND id=?").get(id);
  if (!row || row.media_type === 'gallery' || !inScope(id) || ['baseline','gallery','too_long'].includes(row.skip_reason) || row.status === 'removed') throw new Error('这条作品不在可修改用途的处理范围内');
  const now = Math.floor(Date.now()/1000);
  d.prepare(`UPDATE items SET processing_mode=?,routing_reason='用户手动选择',routing_source='manual',routing_model=NULL,routed_at=?,
    status=?,skip_reason=NULL,needs_ocr=?,delete_after_note=CASE WHEN ?='note' THEN delete_after_note ELSE 0 END,
    attempts=0,last_error=NULL,updated_at=? WHERE platform='douyin' AND id=?`)
    .run(purpose,now,purpose==='review'?'review':'pending',0,purpose,now,id);
  if (purpose !== 'review') retryItem(id);
  return purpose;
}

/** 调用方持有流水线锁。只恢复未完成的旧混合用途；已有成果、文件、基线与额度保留。 */
export function migratePurposes() {
  const d=database();
  d.exec('BEGIN IMMEDIATE');
  try {
    const requeued=d.prepare(`UPDATE items SET processing_mode=NULL,status='pending',attempts=0,last_error=NULL,
      routing_reason=NULL,routing_source=NULL,routing_model=NULL,routed_at=NULL,needs_ocr=0
      WHERE platform='douyin' AND processing_mode IN ('visual','both') AND status IN ('pending','downloaded','transcribed','failed','review')
        AND COALESCE(skip_reason,'') NOT IN ('baseline','too_long','video_deleted') AND id IN (SELECT id FROM daily_queue)`).run().changes;
    const renamed=d.prepare(`UPDATE items SET processing_mode=CASE WHEN media_type='gallery' THEN 'gallery'
      WHEN processing_mode='speech' OR note_path IS NOT NULL OR text_path IS NOT NULL OR status='extracted' THEN 'note' ELSE 'video' END
      WHERE platform='douyin' AND ((media_type='gallery' AND COALESCE(processing_mode,'')!='gallery') OR processing_mode IN ('speech','visual','both')
        OR (processing_mode IS NULL AND (status='extracted' OR note_path IS NOT NULL OR text_path IS NOT NULL)))
        AND NOT (processing_mode IS NULL AND status='pending')`).run().changes;
    d.prepare("UPDATE items SET skip_reason='insufficient_text' WHERE skip_reason='need_ocr'").run();
    d.exec('COMMIT');return {requeued,renamed};
  } catch(e) {d.exec('ROLLBACK');throw e;}
}

/** 恢复过去仅因不支持图集而跳过的新收藏；历史基线不变。调用方持有流水线锁。 */
export function queueSkippedGalleries() {
  const d = database();
  const rows = d.prepare("SELECT * FROM items WHERE platform='douyin' AND media_type='gallery' AND status='skipped' AND skip_reason='gallery'").all();
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      d.prepare('INSERT OR IGNORE INTO daily_queue(id,metadata,enqueued) VALUES(?,?,?)').run(row.id, JSON.stringify({aweme_id:row.id,is_gallery:true,desc:row.title,author:row.author}), row.first_seen*1000);
      d.prepare("UPDATE items SET status='pending',skip_reason=NULL,attempts=0,last_error=NULL WHERE platform='douyin' AND id=?").run(row.id);
    }
    d.exec('COMMIT');return rows.length;
  } catch(e) { d.exec('ROLLBACK');throw e; }
}
