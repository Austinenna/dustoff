#!/usr/bin/env node
// dustoff / ledger.mjs
// 账本：三段流程之间唯一的共享状态。
//
// 为什么需要它：
//   v0.1.0 的「状态」全靠文件系统——「media 目录里有没有这个文件夹」就是全部。
//   这够用到下载为止，但撑不到提取阶段，因为下面这些问题文件系统答不了：
//     · 哪些下好了但还没提取？
//     · 哪些提取失败了、失败几次了、还该不该重试？
//     · 哪些提取完了、mp4 可以删了？          ← 按状态删而不是按时间删
//     · 哪些是我主动跳过的（图集 / 超长）？
//     · 哪些已经从收藏夹里被移除了？
//
// 为什么是 SQLite 而不是 JSON：
//   五千条量级下 JSON 每次都要全量读写；而这里最频繁的操作是
//   「按状态查一批」，正是索引擅长的事。另外两个定时任务可能重叠，
//   SQLite 的事务比手工读写 JSON 安全。
//
// 零依赖：用 Node 22 内置的 node:sqlite。
//
// 命令行用法（也可作为模块 import）:
//   node ledger.mjs stats                    看总览
//   node ledger.mjs list <status> [n]        列出某状态的条目
//   node ledger.mjs show <id>                看单条全部字段
//   node ledger.mjs import <coll.json>       把扫描结果并入账本
//   node ledger.mjs sweep <result.json>      把下载结果并入账本
//   node ledger.mjs reconcile <coll.json>    对账：标记已从收藏夹移除的（仅限全量扫描）
//   node ledger.mjs requeue <id|status>      重新排队（清零重试计数）
//   node ledger.mjs requeue-silent           把无音轨的打回重下（ASR 需要音轨）

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

const DUST_HOME = (process.env.DUST_HOME || join(homedir(), '.dustoff'))
  .replace(/^~(?=$|\/)/, homedir());
const DB_PATH = process.env.DUST_DB || join(DUST_HOME, 'index.sqlite');

// ── 状态机 ────────────────────────────────────────────────────────
//
//   (新扫到) ──→ pending ──┬──→ downloaded ──┬──→ transcribed ──┬──→ extracted  笔记已生成
//                          │                 │    ↑第二段终点    └──→ failed     提炼重试超限
//                          │                 └──→ failed         转写重试超限
//                          ├──→ skipped      主动跳过，带 skip_reason
//                          └──→ failed       下载重试超限
//
// 分段边界：第二段（提取）到 transcribed 为止，出口就是那份 .txt。
// extracted（笔记已生成）属于第三段，等 AI 提炼那部分开工时才会有条目走到。
//
// 为什么 transcribed 和 extracted 要分开：
//   转写（ASR，机器干的）和提炼（LLM 写笔记，prompt 说了算）失败原因不同、
//   重跑代价也不同。合成一个状态的话，笔记模板一改就得连 ASR 一起重跑，
//   等于为改 prompt 重复付一次转写的钱。
//   mp4 在 transcribed 之后就可以删了（保留期见 cleanable），
//   因为第二段的产物 .txt 已经落盘，不再需要原视频。
//
//   任何状态 ──→ removed   对账时发现已不在收藏夹里
//
// skipped 是状态而非标记，这样将来想捞某条超长视频，
// 直接 requeue 改回 pending 即可，不用改表结构。
export const STATUS = {
  PENDING: 'pending',        // 已知，素材还没下
  DOWNLOADED: 'downloaded',  // 素材已落盘，等转写
  TRANSCRIBED: 'transcribed',// 文字已转出——第二段的终点。过保留期后 mp4 可删
  EXTRACTED: 'extracted',    // 笔记已生成（第三段的终点）
  SKIPPED: 'skipped',        // 主动跳过（图集 / 超长 / 无地址）
  FAILED: 'failed',          // 重试超限，放弃
  REMOVED: 'removed',        // 已从收藏夹移除
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  -- ── 身份 ──────────────────────────────────────────
  id            TEXT NOT NULL,      -- 平台内的唯一 id（抖音是 aweme_id）
  platform      TEXT NOT NULL,      -- douyin / bilibili / ...，为扩展其他平台预留

  -- ── 来源元数据（采集时写入，之后不再变）──────────────
  title         TEXT,               -- 作品标题
  author        TEXT,               -- 作者昵称
  created_at    INTEGER,            -- 发布时间 unix 秒。注意不是收藏时间
  duration_s    INTEGER,            -- 时长秒。图集为 NULL
  media_type    TEXT,               -- video / gallery

  -- ── 采集状态 ─────────────────────────────────────
  first_seen    INTEGER NOT NULL,   -- 首次扫到的时间 ≈ 收藏时间
  last_seen     INTEGER NOT NULL,   -- 最后一次在收藏夹里见到 → 据此发现取消收藏
  status        TEXT NOT NULL,      -- 见 STATUS
  skip_reason   TEXT,               -- gallery / too_long / no_url / need_ocr

  -- ── 素材 ────────────────────────────────────────
  media_path    TEXT,               -- 视频落盘位置
  media_bytes   INTEGER,            -- 体积
  gear          TEXT,               -- 下的哪一档码率
  media_deleted INTEGER DEFAULT 0,  -- mp4 是否已清理。1 表示提取完删掉了
  has_audio     INTEGER,            -- 文件有没有音轨。NULL=未检测 0=无 1=有
                                    -- 无音轨的没法做 ASR，需要重下（见 requeueSilent）

  -- ── 提取产物 ─────────────────────────────────────
  text_source   TEXT,               -- asr / asr+ocr / none，用于回溯质量问题
  text_chars    INTEGER,            -- 转出多少字。太少说明这条八成是纯画面，
                                    -- 将来 OCR 增强就靠这个筛
  text_path     TEXT,               -- 转写稿落在哪。刻意不放 media 目录下——
                                    -- mp4 会被清理，文字稿要活得比它久
  audio_seconds INTEGER,            -- 送进 ASR 的音频秒数，即计费单位
  keyframes     INTEGER,            -- 关键帧张数
  note_path     TEXT,               -- 笔记落在哪

  -- ── AI 判断结果 ──────────────────────────────────
  category      TEXT,               -- AI技术 / 游戏攻略 / 生活方式 / 其他
  decay         TEXT,               -- none / slow / fast / event  时效档位
  needs_ocr     INTEGER DEFAULT 0,  -- 1 = 关键信息在画面上，ASR 拿不到（阵容码/仓库地址/
                                    -- 型号链接）。攒着将来一次性补 OCR，不是「不配写笔记」

  -- ── 失败处理 ─────────────────────────────────────
  attempts      INTEGER DEFAULT 0,  -- 已尝试次数。超限则转 failed，避免无限重试烧钱
  last_error    TEXT,               -- 最后一次错误，排查用

  -- ── 时间戳 ──────────────────────────────────────
  downloaded_at INTEGER,
  transcribed_at INTEGER,           -- 转写完成时刻。mp4 保留期从这里算，
                                    -- 不能用 updated_at——每天的扫描都会刷新它，
                                    -- 只要条目还在收藏夹里就永远「刚动过」
  extracted_at  INTEGER,
  updated_at    INTEGER NOT NULL,

  PRIMARY KEY (platform, id)        -- 跨平台时 id 可能撞车，所以联合主键
);

-- 最频繁的查询是「按状态捞一批待处理的」
CREATE INDEX IF NOT EXISTS idx_status     ON items(status, platform);
-- 对账时按 last_seen 找出已消失的条目
CREATE INDEX IF NOT EXISTS idx_last_seen  ON items(last_seen);
-- 组织阶段会按分类和时效筛
CREATE INDEX IF NOT EXISTS idx_category   ON items(category, decay);
-- 清理 mp4 时找「已转写、过了保留期、还没删」的
CREATE INDEX IF NOT EXISTS idx_cleanable  ON items(status, media_deleted, transcribed_at);
`;

let _db = null;
export function db() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');   // 两个定时任务可能重叠，WAL 允许读写并发
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec(SCHEMA);
  migrate(_db);
  return _db;
}

/**
 * 补齐后加的列。
 * 建表用的是 IF NOT EXISTS，所以老库不会被新 SCHEMA 更新——
 * 早期靠「删库重建」凑合，40 条时无所谓，但全量 5800 条之后
 * 重扫一次要十几分钟，不能再靠重建了。
 * 期望的列直接从 SCHEMA 字符串里读，免得两处定义各自漂移。
 */
function migrate(d) {
  const want = [...SCHEMA.matchAll(/^ {2}(\w+)\s+(TEXT|INTEGER)/gm)]
    .map(m => [m[1], m[2]]);
  const have = new Set(d.prepare('PRAGMA table_info(items)').all().map(r => r.name));
  for (const [name, type] of want) {
    if (!have.has(name)) d.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
  }
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * 把一次扫描的结果并入账本。
 * 已存在的只更新 last_seen 和元数据，绝不覆盖处理状态——
 * 否则每天的扫描会把已经提取好的条目打回 pending。
 * @returns {{added:number, seen:number}}
 */
export function importScan(items, platform = 'douyin') {
  const d = db(), t = now();
  const ins = d.prepare(`
    INSERT INTO items (id, platform, title, author, created_at, duration_s, media_type,
                       first_seen, last_seen, status, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(platform, id) DO UPDATE SET
      last_seen  = excluded.last_seen,
      title      = COALESCE(excluded.title, items.title),
      author     = COALESCE(excluded.author, items.author),
      duration_s = COALESCE(excluded.duration_s, items.duration_s),
      updated_at = excluded.updated_at
  `);
  const countBefore = d.prepare('SELECT COUNT(*) n FROM items WHERE platform = ?').get(platform).n;
  d.exec('BEGIN');
  try {
    for (const it of items) {
      ins.run(it.aweme_id, platform, it.desc || null, it.author || null,
        it.create_time || null, it.duration_s || null,
        it.is_gallery ? 'gallery' : 'video',
        t, t, STATUS.PENDING, t);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  const countAfter = d.prepare('SELECT COUNT(*) n FROM items WHERE platform = ?').get(platform).n;
  return { added: countAfter - countBefore, seen: items.length };
}

/** 把一次下载的结果并入账本。 */
export function importDownload(results, platform = 'douyin') {
  const d = db(), t = now();
  const map = {
    done:            r => ({ status: STATUS.DOWNLOADED, reason: null }),
    cached:          r => ({ status: STATUS.DOWNLOADED, reason: null }),
    skipped_gallery: r => ({ status: STATUS.SKIPPED, reason: 'gallery' }),
    skipped_too_long:r => ({ status: STATUS.SKIPPED, reason: 'too_long' }),
    skipped_no_url:  r => ({ status: STATUS.SKIPPED, reason: 'no_url' }),
    skipped_expired: r => null,     // 地址过期不是终态，下次扫描重新拿地址即可
    failed:          r => null,     // 交给 attempts 逻辑，不直接判死
  };
  const upd = d.prepare(`
    UPDATE items SET status = ?, skip_reason = ?, media_path = ?, media_bytes = ?,
                     gear = ?, has_audio = ?, downloaded_at = COALESCE(downloaded_at, ?), updated_at = ?
    WHERE platform = ? AND id = ? AND status IN ('pending','skipped')
  `);
  const bump = d.prepare(`
    UPDATE items SET attempts = attempts + 1, last_error = ?, updated_at = ?
    WHERE platform = ? AND id = ?
  `);
  let touched = 0, bumped = 0;
  d.exec('BEGIN');
  try {
    for (const r of results) {
      const m = map[r.status]?.(r);
      if (!m) {
        if (r.status === 'failed') { bump.run((r.errors || []).join('; ').slice(0, 300), t, platform, r.aweme_id); bumped++; }
        continue;
      }
      const res = upd.run(m.status, m.reason, r.path || null, r.bytes || null,
        r.gear || null, r.has_audio === undefined ? null : (r.has_audio ? 1 : 0),
        t, t, platform, r.aweme_id);
      touched += res.changes;
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return { touched, bumped };
}

/**
 * 对账：本次扫描没见到、但账本里还是活跃状态的条目，标为 removed。
 * 只在全量扫描后调用——增量扫描本来就见不到旧条目，会误杀。
 */
/**
 * 对账：把「账本里有、但这次没扫到」的条目标为 removed。
 *
 * ⚠️ 这是全项目最危险的一个函数——它按「不在名单里」来判死，
 *    而名单是外部给的。名单不全，就会误杀。
 *
 * 两道闸，都是硬约束而不是注释：
 *
 *   ① 必须显式声明「这次是全量扫描」。日常只扫最新 200 条，
 *      拿那 200 条来对账会把其余五千多条全标成已取消收藏。
 *
 *   ② 即使声明了全量，一次要删掉超过 maxRemoveRatio 也拒绝执行。
 *      这道闸防的是「自称全量、其实扫挂了」——早期滚动容器找错，
 *      扫描只返回 69 条却一切正常地退出，正是这种情况。
 *      真要大批清理时手动带 force 跑。
 *
 * @param {string[]} scannedIds 本次扫到的全部 id
 * @param {{platform?, scanTime?, scanComplete?, maxRemoveRatio?, force?}} opts
 */
export function reconcile(scannedIds, opts = {}) {
  const {
    platform = 'douyin', scanTime = null,
    scanComplete = false, maxRemoveRatio = 0.1, force = false,
  } = opts;

  if (!scanComplete && !force) {
    throw new Error(
      '拒绝对账：调用方没有声明这是全量扫描。\n' +
      '  日常增量扫描只覆盖最新若干条，用它对账会把其余条目全部误标为已取消收藏。\n' +
      '  确认扫到底了（coll.truncated === false）再传 { scanComplete: true }。');
  }

  const d = db(), t = scanTime || now();
  const seen = new Set(scannedIds);
  const active = d.prepare(
    `SELECT id FROM items WHERE platform = ? AND status NOT IN ('removed')`
  ).all(platform);
  const gone = active.filter(r => !seen.has(r.id)).map(r => r.id);

  const ratio = active.length ? gone.length / active.length : 0;
  if (!force && ratio > maxRemoveRatio) {
    throw new Error(
      `拒绝对账：本次会标记 ${gone.length}/${active.length} 条为已移除（${(ratio * 100).toFixed(1)}%），` +
      `超过阈值 ${(maxRemoveRatio * 100).toFixed(0)}%。\n` +
      '  扫描很可能不完整。先核对扫描结果，确认无误再带 force 重跑。');
  }

  const upd = d.prepare(`UPDATE items SET status = 'removed', updated_at = ? WHERE platform = ? AND id = ?`);
  d.exec('BEGIN');
  try { for (const id of gone) upd.run(t, platform, id); d.exec('COMMIT'); }
  catch (e) { d.exec('ROLLBACK'); throw e; }
  return { removed: gone.length, checked: active.length };
}

/**
 * 捞一批待办。提取阶段用 status='downloaded'。
 *
 * 为什么这里没有「领取」语义（不写 in_progress 之类的标记）：
 *
 *   · 同阶段的并发已经被 stage.mjs 的 PID 锁挡住了，两个 extract 跑不到一起。
 *   · 单次运行内部是一个 worker 池共享同一个队列，Node 单线程下 shift() 不会撞。
 *   · 真正怕的是「花了钱但没记下来」，而那靠的是逐条即时写账本
 *     （每条 API 调用返回后立刻 markTranscribed），崩溃最多丢一条。
 *     加领取标记对这个场景毫无帮助——结果本来就丢了。
 *   · 反过来，领取标记会引入新问题：进程被 kill -9 之后标记留在库里，
 *     得再写一套超时回收逻辑，凭空多一个会出错的地方。
 *
 * 所以刻意保持它是个纯查询。
 */
export function claim(status, limit = 50, platform = 'douyin', maxAttempts = 3) {
  return db().prepare(`
    SELECT * FROM items
    WHERE platform = ? AND status = ? AND attempts < ?
    ORDER BY first_seen DESC
    LIMIT ?
  `).all(platform, status, maxAttempts, limit);
}

/** 记录一次转写成功。mp4 保持不动——提炼笔记之后才轮到清理。 */
export function markTranscribed(id, fields, platform = 'douyin') {
  return db().prepare(`
    UPDATE items SET status = 'transcribed', text_source = ?, text_chars = ?,
                     text_path = ?, audio_seconds = ?, attempts = 0, last_error = NULL,
                     transcribed_at = COALESCE(transcribed_at, ?), updated_at = ?
    WHERE platform = ? AND id = ?
  `).run(fields.text_source || null, fields.text_chars ?? null,
    fields.text_path || null, fields.audio_seconds ?? null,
    now(), now(), platform, id);
}

/** 记录一次提炼成功。 */
export function markExtracted(id, fields, platform = 'douyin') {
  return db().prepare(`
    UPDATE items SET status = 'extracted', text_source = ?, text_chars = ?, keyframes = ?,
                     note_path = ?, category = ?, decay = ?, needs_ocr = ?,
                     extracted_at = ?, updated_at = ?
    WHERE platform = ? AND id = ?
  `).run(fields.text_source || null, fields.text_chars || null, fields.keyframes || null,
    fields.note_path || null, fields.category || null, fields.decay || null,
    fields.needs_ocr ? 1 : 0, now(), now(), platform, id);
}

/** 记录一次失败。超过上限则转 failed，避免无限重试烧 API 额度。 */
export function markFailed(id, error, platform = 'douyin', maxAttempts = 3) {
  const d = db();
  d.prepare(`UPDATE items SET attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE platform = ? AND id = ?`).run(String(error).slice(0, 300), now(), platform, id);
  const row = d.prepare('SELECT attempts FROM items WHERE platform = ? AND id = ?').get(platform, id);
  if (row && row.attempts >= maxAttempts) {
    d.prepare(`UPDATE items SET status = 'failed', updated_at = ? WHERE platform = ? AND id = ?`)
      .run(now(), platform, id);
    return { gaveUp: true, attempts: row.attempts };
  }
  return { gaveUp: false, attempts: row?.attempts ?? 0 };
}

/** 标记 mp4 已清理。提取完之后调用，磁盘峰值因此可控。 */
export function markMediaDeleted(ids, platform = 'douyin') {
  const d = db();
  const upd = d.prepare(`UPDATE items SET media_deleted = 1, updated_at = ? WHERE platform = ? AND id = ?`);
  d.exec('BEGIN');
  try { for (const id of ids) upd.run(now(), platform, id); d.exec('COMMIT'); }
  catch (e) { d.exec('ROLLBACK'); throw e; }
}

/** 把「已下载但没有音轨」的条目打回 pending，好用新的挑档逻辑重下。
 *  ASR 需要音轨，纯视频文件对后半段没有价值。 */
export function requeueSilent(platform = 'douyin') {
  const d = db();
  const r = d.prepare(`UPDATE items SET status='pending', attempts=0, media_path=NULL,
                       media_bytes=NULL, gear=NULL, has_audio=NULL, updated_at=?
                       WHERE platform=? AND status='downloaded' AND has_audio = 0`).run(now(), platform);
  return { requeued: r.changes };
}

/** 找出可以删 mp4 的条目：已提取、还没删、文件还在。 */
/**
 * 找出可以删 mp4 的条目：转写完、过了保留期、文件还在。
 *
 * 为什么是 transcribed 而不是 extracted：
 *   第二段的出口就是那份 .txt，到此为止。笔记提炼归第三段，
 *   而第三段读的是 .txt，不需要原视频——所以不必等到 extracted 才删。
 *
 * 为什么要留保留期而不是转完就删：
 *   转写质量还在验证期，热词表也在长。删早了发现问题就得重下，
 *   而 CDN 地址会过期，等于要重新扫描一遍。
 *
 * @param {number} keepDays 转写完成后保留多少天。0 表示转完即可删。
 */
export function cleanable(platform = 'douyin', { keepDays = 7, limit = 1000 } = {}) {
  const cutoff = now() - keepDays * 86400;
  return db().prepare(`
    SELECT id, title, media_path, media_bytes, transcribed_at FROM items
    WHERE platform = ? AND status IN ('transcribed','extracted')
      AND media_deleted = 0 AND media_path IS NOT NULL
      AND COALESCE(transcribed_at, 0) <= ?
    ORDER BY transcribed_at
    LIMIT ?
  `).all(platform, cutoff, limit);
}

/** 某个 id 是否已知——扫描层增量判断「撞到已知就停」用。 */
/**
 * 在给定的 id 里，挑出账本认为「还该下载」的那些。
 *
 * 为什么需要它：download.mjs 只会问磁盘「文件在不在」，而磁盘的「不在」
 * 是个歧义答案——分不清「从没下过」和「转写完被清理了」。后者如果重下，
 * 会形成一个循环：下载 → 转写 → 保留期到了删掉 → 又在扫描窗口里 → 再下回来。
 * 扫描窗口（200 条 ≈ 13 天）比保留期（7 天）长，所以每条都会中招。
 *
 * 账本能分清，所以由它来筛，筛完再交给下载器。
 */
export function pendingAmong(ids, { platform = 'douyin', includeUnknown = false } = {}) {
  if (!ids.length) return new Set();
  const d = db();
  const out = new Set();
  const seen = new Set();
  // SQLite 有参数个数上限，分批查
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const q = d.prepare(`SELECT id, status FROM items WHERE platform = ? AND id IN (${ph})`);
    for (const r of q.all(platform, ...chunk)) {
      seen.add(r.id);
      if (r.status === STATUS.PENDING) out.add(r.id);
    }
  }
  // --dry-run 用：账本还没写入，但 importScan 之后这些会变成 pending。
  // 不带这个的话预览会把新条目全剔掉，报出一个假的「无事可做」。
  if (includeUnknown) for (const id of ids) if (!seen.has(id)) out.add(id);
  return out;
}

export function knownIds(platform = 'douyin') {
  return new Set(db().prepare('SELECT id FROM items WHERE platform = ?').all(platform).map(r => r.id));
}

export function stats(platform = null) {
  const d = db();
  const where = platform ? 'WHERE platform = ?' : '';
  const args = platform ? [platform] : [];
  return {
    total: d.prepare(`SELECT COUNT(*) n FROM items ${where}`).get(...args).n,
    byStatus: d.prepare(`SELECT status, COUNT(*) n FROM items ${where} GROUP BY status ORDER BY n DESC`).all(...args),
    bySkip: d.prepare(`SELECT skip_reason, COUNT(*) n FROM items ${where || 'WHERE 1=1'} AND skip_reason IS NOT NULL GROUP BY skip_reason`).all(...args),
    byPlatform: d.prepare('SELECT platform, COUNT(*) n FROM items GROUP BY platform').all(),
    media: d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(media_bytes),0) bytes FROM items ${where || 'WHERE 1=1'} AND media_deleted = 0 AND media_bytes IS NOT NULL`).get(...args),
    audio: d.prepare(`SELECT COALESCE(SUM(has_audio=1),0) y, COALESCE(SUM(has_audio=0),0) n, COALESCE(SUM(has_audio IS NULL),0) u FROM items ${where || 'WHERE 1=1'} AND status IN ('downloaded','transcribed','extracted')`).get(...args),
    reclaimable: d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(media_bytes),0) bytes FROM items ${where || 'WHERE 1=1'} AND status IN ('transcribed','extracted') AND media_deleted=0 AND media_path IS NOT NULL`).get(...args),
    // 累计送进 ASR 的音频秒数——这是计费单位，乘以单价就是花了多少
    text: d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(text_chars),0) chars, COALESCE(SUM(audio_seconds),0) secs,
                            COALESCE(SUM(text_chars=0),0) empty
                     FROM items ${where || 'WHERE 1=1'} AND text_source IS NOT NULL`).get(...args),
  };
}

// ── CLI ───────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith('ledger.mjs');
if (isMain) {
  const [cmd, a1, a2] = process.argv.slice(2);
  const fmtMB = b => b ? (b / 1024 / 1024).toFixed(1) + ' MB' : '0';
  const readJson = f => JSON.parse(readFileSync(f, 'utf8'));

  if (!cmd || cmd === 'stats') {
    const s = stats();
    console.log(`账本 ${DB_PATH}\n`);
    console.log(`  总条目 ${s.total}`);
    if (s.byPlatform.length > 1 || s.total) {
      console.log('\n  按平台:');
      for (const r of s.byPlatform) console.log(`    ${r.platform.padEnd(12)} ${r.n}`);
    }
    console.log('\n  按状态:');
    for (const r of s.byStatus) console.log(`    ${String(r.status).padEnd(12)} ${r.n}`);
    if (s.bySkip.length) {
      console.log('\n  跳过原因:');
      for (const r of s.bySkip) console.log(`    ${String(r.skip_reason).padEnd(12)} ${r.n}`);
    }
    console.log(`\n  音轨   有 ${s.audio.y} · 无 ${s.audio.n} · 未检测 ${s.audio.u}` +
      (s.audio.n ? `   ⚠️ 无音轨的做不了 ASR，跑 requeue-silent 重下` : ''));
    console.log(`  素材占用 ${fmtMB(s.media.bytes)}（${s.media.n} 条未清理）`);
    console.log(`  可回收   ${fmtMB(s.reclaimable.bytes)}（${s.reclaimable.n} 条已转写但 mp4 还在）`);
    if (s.text.n) {
      const secs = s.text.secs;
      const hh = Math.floor(secs / 3600), mm = Math.round((secs % 3600) / 60);
      console.log(`\n  已转写 ${s.text.n} 条 · ${s.text.chars.toLocaleString()} 字` +
        (s.text.empty ? ` · ${s.text.empty} 条空（纯画面）` : ''));
      // 秒数是计费单位。不在这里换算成钱：单价随模型和地域变，
      // 写死一个数迟早会过期，反而误导。
      console.log(`  计费音频 ${hh ? hh + ' 小时 ' : ''}${mm} 分（${secs.toLocaleString()} 秒）`);
    }
  } else if (cmd === 'list') {
    const rows = claim(a1 || 'pending', Number(a2) || 20, 'douyin', 99);
    console.log(`${a1 || 'pending'} 状态共列出 ${rows.length} 条:\n`);
    for (const r of rows) {
      console.log(`  ${r.id}  ${String(r.duration_s ?? '图集').padStart(5)}s  @${(r.author || '').slice(0, 10).padEnd(10)} ${(r.title || '').slice(0, 34)}`);
    }
  } else if (cmd === 'show') {
    const r = db().prepare('SELECT * FROM items WHERE id = ?').get(a1);
    if (!r) { console.error('未找到'); process.exit(1); }
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(14)} ${v === null ? '—' : v}`);
  } else if (cmd === 'import') {
    const j = readJson(a1);
    console.log('  ', JSON.stringify(importScan(j.items)));
  } else if (cmd === 'sweep') {
    const j = readJson(a1);
    console.log('  ', JSON.stringify(importDownload(j.results)));
  } else if (cmd === 'reconcile') {
    const j = readJson(a1);
    const complete = j.truncated === false;
    const force = process.argv.includes('--force');
    if (!complete && !force) {
      console.error(`这份扫描结果 truncated=${j.truncated}，不是全量，拒绝对账。`);
      console.error('确认要用它对账，加 --force（会把没扫到的全部标记为已移除）。');
      process.exit(1);
    }
    console.log('  ', JSON.stringify(reconcile(j.items.map(i => i.aweme_id), { scanComplete: complete, force })));
  } else if (cmd === 'requeue-silent') {
    console.log('  ', JSON.stringify(requeueSilent()));
  } else if (cmd === 'requeue') {
    const d = db();
    const byStatus = Object.values(STATUS).includes(a1);
    const r = byStatus
      ? d.prepare(`UPDATE items SET status='pending', attempts=0, last_error=NULL, updated_at=? WHERE status=?`).run(now(), a1)
      : d.prepare(`UPDATE items SET status='pending', attempts=0, last_error=NULL, updated_at=? WHERE id=?`).run(now(), a1);
    console.log(`  重新排队 ${r.changes} 条`);
  } else {
    console.error('未知命令。可用: stats | list | show | import | sweep | reconcile | requeue | requeue-silent');
    process.exit(2);
  }
}
