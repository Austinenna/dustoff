import { readFileSync, existsSync } from 'node:fs';
import { localPath } from './policy.mjs';
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
export function acceptScan(scan) {
  if (!scan.ok || !scan.logged_in || scan.scan_error || !Array.isArray(scan.items)) throw new Error('扫描未完整成功，保留原基线与待办');
  for (const it of scan.items) if (!/^\d+$/.test(String(it.aweme_id))) throw new Error('扫描包含无效作品 ID');
  const d = database(), old = baseline();
  if (!old && scan.items.length < POLICY.scan && scan.truncated !== false) throw new Error('首次扫描不足基线窗口且未确认到列表末尾，请重试');
  if (!old && scan.items.length < 100 && scan.truncated !== false) throw new Error('首次基线需要 100 条或已确认的完整列表');
  if (old && !old.anchors.length && scan.truncated !== false) throw new Error('原基线为空，需确认当前完整列表后才可推进');
  const cut = old ? boundaryIndex(scan.items, old.anchors) : 0;
  if (old && cut < 0) throw new Error('没有确认到旧边界，保留进度；请检查收藏列表后重试');
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
  if (!row || row.status === 'extracted' || row.skip_reason === 'baseline') throw new Error('已完成或基线条目不能作为失败待办重试');
  if (row.skip_reason === 'too_long' || row.skip_reason === 'gallery') throw new Error('本轮不支持恢复主动跳过的内容');
  let status = 'pending';
  if (row.transcribed_at && row.text_path && existsSync(localPath(row.text_path)) && readFileSync(localPath(row.text_path),'utf8').length === row.text_chars) status = 'transcribed';
  else if (row.media_path && !row.media_deleted && existsSync(localPath(row.media_path))) status = 'downloaded';
  d.prepare("UPDATE items SET status=?,attempts=0,last_error=NULL WHERE platform='douyin' AND id=?").run(status,id);
  return status;
}
