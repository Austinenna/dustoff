#!/usr/bin/env node
// dustoff / make-demo.mjs —— 按「放进演示站」的标记，从正式数据生成演示站的数据目录。
//
//   node scripts/make-demo.mjs            生成并替换演示数据（DUST_HOME 是正式数据，DUST_DEMO_HOME 是演示数据）
//   node scripts/make-demo.mjs --dry-run  只看选了哪些，不生成
//
// 只读正式数据，只写演示目录：先在「演示目录.next」里生成完整的一份，最后整体换掉旧目录，
// 游客不会看到生成到一半的数据。演示进程看到 demo.json 变了就重新读取，不用重启。
//
// 复制的内容：选中作品的账本记录、笔记、文字稿、视频和图集（同一磁盘上用硬链接，不多占空间）、
// 知识库索引里这些笔记的大类和概念。主题综述是把主题下全部笔记合写的，会带出没选的笔记，
// 所以只保留出处全在选中笔记里的综述，其余按选中的笔记重写（要调模型）；上一版演示站里
// 笔记没变的综述直接沿用，不重写。运行记录只留每轮的时间、退出码和数量，不带作品和错误。
// 标了「排队样例」的待决定作品，在演示站里摆成排队整理（正式数据不改）。
// 素材箱另外生成演示用的样例：按知识库主题建选题，收几篇选中的笔记和摘录。
// 不复制：已读、正式素材箱、令牌、登录状态、配置和密钥。
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, linkSync, copyFileSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DUST_HOME, loadConf, makeCfg } from './config.mjs';
import { localPath, under, atomicWrite } from './policy.mjs';
import { createLibrary } from './library-store.mjs';
import { createKnowledge } from './knowledge-store.mjs';
import { PAGE_HASH, knowledgeConfig } from './knowledge-extract.mjs';
import { readTranscriptMetadata, transcriptMetadataPath } from './transcript.mjs';
import { pagePass } from '../knowledge.mjs';

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.error(`[${stamp()}] ${a.join(' ')}`);
// 运行记录只留这些字段：时间、耗时、退出码和数量。失败条目、暂停原因里有作品和账号信息，不带过去。
const HISTORY_FIELDS = ['run', 'version', 'started', 'seconds', 'exit', 'processed', 'notes', 'saved', 'galleries', 'review', 'skipped', 'added'];
// 扫描状态只留时间；X 的那份里有账号名。
const STATE_FIELDS = ['version', 'created_at', 'scanned_at', 'start_at', 'complete'];

/** 演示目录：必须和正式数据分开，互不包含。 */
export function demoHome(home = DUST_HOME, cfg = makeCfg({ conf: loadConf(join(home, 'dustoff.conf')) })) {
  const value = cfg('DUST_DEMO_HOME', '');
  return value ? checkTarget(value, home) : null;
}
// 更新时会整个替换演示目录，所以它绝不能是正式数据或在正式数据里面。
function checkTarget(value, home) {
  if (!String(value).startsWith('/')) throw new Error('演示数据目录必须是独立的绝对路径，不能和正式数据互相包含');
  const target = localPath(value), prod = localPath(home);
  if (target === prod || under(target, prod) || under(prod, target) || target === '/') throw new Error('演示数据目录必须是独立的绝对路径，不能和正式数据互相包含');
  return target;
}
export const buildStatusFile = home => join(home, 'console', 'demo-build.json');
export function readBuildStatus(home) { try { return JSON.parse(readFileSync(buildStatusFile(home), 'utf8')); } catch { return null; } }
export function readDemoInfo(target) { try { return JSON.parse(readFileSync(join(target, 'demo.json'), 'utf8')); } catch { return null; } }

// 复制一个文件或目录：同一磁盘上建硬链接，跨盘时才真正复制。正式数据改写笔记是写新文件再改名，不会改到这里的副本。
function place(from, to) {
  const st = statSync(from);
  if (st.isDirectory()) { mkdirSync(to, { recursive: true }); for (const name of readdirSync(from)) if (!name.endsWith('.part')) place(join(from, name), join(to, name)); return; }
  if (!st.isFile()) return;
  mkdirSync(dirname(to), { recursive: true });
  try { linkSync(from, to); } catch { copyFileSync(from, to); }
}

export async function buildDemo({ home = DUST_HOME, target, cfg = makeCfg({ conf: loadConf(join(home, 'dustoff.conf')) }), dryRun = false, fetchImpl = fetch, now = Date.now, onLog = log } = {}) {
  home = localPath(home);
  target = target ? checkTarget(target, home) : demoHome(home, cfg);
  if (!target) throw new Error('还没有设置演示数据目录（DUST_DEMO_HOME）');
  const library = createLibrary(home), picks = library.demoPicks(), queued = library.demoQueued(); library.close();
  if (!picks.length) throw new Error('还没有选进演示站的作品');
  const ledgerFile = localPath(process.env.DUST_DB || join(home, 'index.sqlite'));
  if (!existsSync(ledgerFile)) throw new Error('正式数据里还没有收藏账本');

  const stage = target + '.next';
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    // ── 账本：整库拷一份，再删掉没选的 ──
    const source = new DatabaseSync(ledgerFile, { readOnly: true });
    try { source.exec(`VACUUM INTO '${join(stage, 'index.sqlite').replace(/'/g, "''")}'`); } finally { source.close(); }
    const db = new DatabaseSync(join(stage, 'index.sqlite'));
    let rows;
    try {
      db.exec('CREATE TEMP TABLE picks(id TEXT PRIMARY KEY)');
      const add = db.prepare('INSERT OR IGNORE INTO picks(id) VALUES(?)');
      for (const id of picks) add.run(id);
      db.exec("DELETE FROM items WHERE id NOT IN (SELECT id FROM picks) OR COALESCE(skip_reason,'')='user_deleted'");
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      if (tables.has('daily_queue')) db.exec('DELETE FROM daily_queue WHERE id NOT IN (SELECT id FROM items)');
      if (tables.has('daily_usage')) db.exec('DELETE FROM daily_usage');
      if (tables.has('daily_state')) for (const r of db.prepare('SELECT name,value FROM daily_state').all()) {
        let value; try { value = JSON.parse(r.value); } catch { value = null; }
        if (!r.name.startsWith('baseline') || !value || typeof value !== 'object') { db.prepare('DELETE FROM daily_state WHERE name=?').run(r.name); continue; }
        db.prepare('UPDATE daily_state SET value=? WHERE name=?').run(JSON.stringify(Object.fromEntries(STATE_FIELDS.filter(k => k in value).map(k => [k, value[k]]))), r.name);
      }
      // 错误信息里可能有服务器路径，演示站不需要。
      db.exec('UPDATE items SET last_error=NULL');
      // 排队样例：还在等决定的作品摆成「已选笔记、等下一轮整理」，放回队列。
      const queueCols = tables.has('daily_queue') ? new Set(db.prepare('PRAGMA table_info(daily_queue)').all().map(c => c.name)) : null;
      for (const id of queued) {
        const r = db.prepare("SELECT platform FROM items WHERE id=? AND status='review'").get(id);
        if (!r) continue;
        db.prepare("UPDATE items SET status='pending', processing_mode='note', attempts=0 WHERE id=?").run(id);
        if (queueCols && !db.prepare('SELECT 1 FROM daily_queue WHERE id=?').get(id)) {
          if (queueCols.has('platform')) db.prepare("INSERT INTO daily_queue(id,metadata,enqueued,platform) VALUES(?,'{}',?,?)").run(id, Math.floor(now() / 1000), r.platform);
          else db.prepare("INSERT INTO daily_queue(id,metadata,enqueued) VALUES(?,'{}',?)").run(id, Math.floor(now() / 1000));
        }
      }
      rows = db.prepare('SELECT id,status,media_type,processing_mode,note_path,text_path,media_path,media_deleted FROM items').all();
    } finally { db.close(); }
    const counts = { items: rows.length, notes: rows.filter(r => r.note_path).length, videos: rows.filter(r => r.media_type === 'video' && (r.status === 'saved' || r.processing_mode === 'video')).length,
      galleries: rows.filter(r => r.media_type === 'gallery').length, posts: rows.filter(r => r.media_type === 'post').length, review: rows.filter(r => r.status === 'review').length, queued: rows.filter(r => r.status === 'pending').length };
    onLog(`选进演示站 ${picks.length} 条，账本里找到 ${rows.length} 条：笔记 ${counts.notes}，视频 ${counts.videos}，图集 ${counts.galleries}，X 原帖 ${counts.posts}，待决定 ${counts.review}，排队 ${counts.queued}`);
    if (dryRun) { rmSync(stage, { recursive: true, force: true }); return { dryRun: true, picks: picks.length, counts }; }

    // ── 文件：按正式数据的目录结构放进演示目录 ──
    const get = key => cfg(key, '');
    const roots = [
      [localPath(get('DUST_SAVED_MEDIA') || join(home, 'saved-media')), 'saved-media'],
      [localPath(get('DUST_MEDIA') || join(home, 'media')), 'media'],
      [localPath(get('DUST_TEXT') || join(home, 'text')), 'text'],
      [localPath(get('DUST_NOTES') || join(homedir(), 'Documents', '抖音收藏')), 'notes'],
    ];
    // 正式路径 → 演示目录里的位置；不在这几个目录下的放进 files/<作品ID>/。
    const finalPath = p => join(target, relative(stage, p));
    const mapPath = (path, id) => {
      const p = localPath(path), root = roots.find(([r]) => under(p, r));
      return root ? join(stage, root[1], relative(root[0], p)) : join(stage, 'files', id, basename(p));
    };
    const update = new DatabaseSync(join(stage, 'index.sqlite'));
    let missing = 0;
    try {
      const set = update.prepare('UPDATE items SET note_path=?,text_path=?,media_path=?,media_deleted=? WHERE id=?');
      for (const r of rows) {
        // 每条作品自己的媒体目录整个带上：图集清单和图片、X 原帖的配图、收件箱预下载的视频。
        for (const [root, name] of roots.slice(0, 2)) for (const dir of [join(root, r.id), join(root, '.review', r.id)]) if (existsSync(dir)) place(dir, join(stage, name, relative(root, dir)));
        const next = {};
        for (const col of ['note_path', 'text_path', 'media_path']) {
          if (!r[col]) { next[col] = r[col]; continue; }
          const to = mapPath(r[col], r.id);
          // 找不到的文件：笔记和文字稿当作没有；视频记成已清理，路径仍指向演示目录，不留服务器上的位置。
          if (!existsSync(to)) { try { place(localPath(r[col]), to); } catch { if (col !== 'media_path' || !r.media_deleted) missing++; next[col] = col === 'media_path' ? to : null; continue; } }
          next[col] = to;
        }
        // 视频文件已经不在了的，按已清理处理。
        const mediaGone = !!r.media_path && !existsSync(next.media_path);
        if (r.text_path) { const words = join(dirname(localPath(r.text_path)), `${r.id}.words.json`); if (existsSync(words) && next.text_path) place(words, join(dirname(next.text_path), `${r.id}.words.json`)); }
        if (r.note_path && next.note_path) {
          // 格式化转写的排版记录按笔记路径的指纹存放，换了位置要按新路径重存一份。
          const meta = readTranscriptMetadata(localPath(r.note_path), { directory: join(home, 'transcript-meta') });
          if (meta) atomicWrite(transcriptMetadataPath(finalPath(next.note_path), { directory: join(stage, 'transcript-meta') }), JSON.stringify(meta));
        }
        set.run(next.note_path, next.text_path, next.media_path, mediaGone ? 1 : r.media_deleted, r.id);
      }
    } finally { update.close(); }
    if (missing) onLog(`有 ${missing} 个文件在正式数据里找不到，已跳过`);

    // ── 运行记录：只留汇总数字 ──
    const historyFile = join(home, 'runs', 'history.jsonl');
    if (existsSync(historyFile)) {
      const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(r => r && Date.parse(r.started) <= now()).slice(-60).map(r => JSON.stringify(Object.fromEntries(HISTORY_FIELDS.filter(k => r[k] !== undefined).map(k => [k, r[k]]))));
      mkdirSync(join(stage, 'runs'), { recursive: true });
      writeFileSync(join(stage, 'runs', 'history.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    }

    // ── 知识库索引 ──
    const pages = { kept: 0, reused: 0, written: 0, failed: 0, skipped: null };
    const kbFile = localPath(process.env.DUST_KNOWLEDGE_DB || join(home, 'knowledge.sqlite'));
    if (existsSync(kbFile)) {
      const k = new DatabaseSync(kbFile, { readOnly: true });
      try { k.exec(`VACUUM INTO '${join(stage, 'knowledge.sqlite').replace(/'/g, "''")}'`); } finally { k.close(); }
      const kb = createKnowledge(stage, { now: () => Math.floor(now() / 1000), path: join(stage, 'knowledge.sqlite') }), stageLedger = join(stage, 'index.sqlite');
      try {
        kb.syncDocs(stageLedger);   // 没选的笔记连同它们的概念关联一起删掉
        const raw = new DatabaseSync(kb.file);
        try {
          raw.exec(`PRAGMA foreign_keys=ON;
            DELETE FROM themes WHERE id NOT IN (SELECT theme_id FROM doc_themes);
            DELETE FROM merges;
            DELETE FROM domain_overrides WHERE item NOT IN (SELECT item FROM docs);
            UPDATE pages SET failed_hash=NULL, attempts=0, error=NULL;`);
          // 出处里有没选的笔记的综述删掉；主题下不够 3 篇的也删掉。
          const docs = new Set(raw.prepare('SELECT item FROM docs').all().map(r => r.item));
          const sizes = new Map(raw.prepare('SELECT theme_id, count(*) n FROM doc_themes GROUP BY theme_id').all().map(r => [r.theme_id, r.n]));
          for (const p of raw.prepare('SELECT theme_id, items, body FROM pages').all()) {
            let items = []; try { items = JSON.parse(p.items); } catch {}
            if (!p.body || (sizes.get(p.theme_id) || 0) < 3 || !items.every(i => docs.has(i))) raw.prepare('DELETE FROM pages WHERE theme_id=?').run(p.theme_id);
            else pages.kept++;
          }
        } finally { raw.close(); }
        // 上一版演示站里笔记没变的综述直接沿用。
        const previous = join(target, 'knowledge.sqlite');
        if (existsSync(previous)) {
          const old = new DatabaseSync(previous, { readOnly: true }), raw = new DatabaseSync(kb.file);
          try {
            const find = old.prepare('SELECT p.* FROM pages p JOIN themes t ON t.id=p.theme_id WHERE t.domain=? AND t.norm=? AND p.body IS NOT NULL');
            const norm = raw.prepare('SELECT norm FROM themes WHERE id=?');
            const put = raw.prepare('INSERT OR REPLACE INTO pages(theme_id,body,items,source_hash,prompt_hash,model,built_at,changes,complete) VALUES(?,?,?,?,?,?,?,?,?)');
            for (const t of kb.pageBatches({ promptHash: PAGE_HASH })) {
              const p = find.get(t.domain, norm.get(t.id).norm);
              if (p && p.source_hash === t.hash && p.prompt_hash === PAGE_HASH) { put.run(t.id, p.body, p.items, p.source_hash, p.prompt_hash, p.model, p.built_at, p.changes, p.complete); pages.reused++; }
            }
          } finally { old.close(); raw.close(); }
        }
        const todo = kb.pageBatches({ promptHash: PAGE_HASH }).length, config = knowledgeConfig(cfg);
        if (todo && !config.key) { pages.skipped = '没有配置模型密钥，这些主题先不显示综述'; onLog(`✗ 要重写 ${todo} 页综述，但${pages.skipped}`); }
        else if (todo) {
          onLog(`要按选中的笔记重写 ${todo} 页综述`);
          try {
            const r = await pagePass(kb, { config, fetchImpl, retryMs: 2000, today: new Date(now()).toLocaleDateString('sv'), onLog });
            pages.written = r.pages; pages.failed = r.failed;
          } catch (e) { pages.skipped = e.message; onLog(`✗ 综述没写完：${e.message}`); }
        }
        // 写不出来的综述删掉失败记录，演示站里不显示。
        const raw2 = new DatabaseSync(kb.file);
        try { raw2.exec('DELETE FROM pages WHERE body IS NULL; UPDATE pages SET failed_hash=NULL, attempts=0, error=NULL;'); } finally { raw2.close(); }
        const index = kb.syncChunks(stageLedger);
        onLog(`知识库：综述保留 ${pages.kept} 页，沿用上一版 ${pages.reused} 页，新写 ${pages.written} 页${pages.failed ? `，失败 ${pages.failed} 页` : ''}；全文索引 ${index.chunks} 段`);
      } finally { kb.close(); }
      const raw = new DatabaseSync(join(stage, 'knowledge.sqlite'));
      try { raw.prepare('UPDATE docs SET path=? || substr(path, ?) WHERE substr(path, 1, ?)=?').run(target + sep, stage.length + 2, stage.length + 1, stage + sep); raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { raw.close(); }
    }

    // ── 素材箱样例 ──
    const materials = sampleMaterials(stage, now);
    onLog(`素材箱样例：选题 ${materials.topics} 个，素材 ${materials.materials} 条`);

    // ── 收尾：路径改成正式位置，写说明，整体替换 ──
    const fix = new DatabaseSync(join(stage, 'index.sqlite'));
    try {
      for (const col of ['note_path', 'text_path', 'media_path']) fix.prepare(`UPDATE items SET ${col}=? || substr(${col}, ?) WHERE substr(${col}, 1, ?)=?`).run(target + sep, stage.length + 2, stage.length + 1, stage + sep);
      fix.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { fix.close(); }
    const info = { version: 1, build: randomBytes(8).toString('hex'), built_at: new Date(now()).toISOString(), snapshot_at: now(), picks: picks.length, counts, pages, materials };
    writeFileSync(join(stage, 'demo.json'), JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
    const old = target + '.old';
    rmSync(old, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, old);
    renameSync(stage, target);
    rmSync(old, { recursive: true, force: true });
    onLog(`演示数据已更新：${target}`);
    return info;
  } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
}

// 摘录：笔记正文里第一句成段的话（跳过属性、标题、列表、引用和表格），最多 140 字。
export function excerptOf(text) {
  const body = String(text).replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || /^(#|>|[-*+] |\d+[.、] |\||!\[|```|<|---)/.test(line)) continue;
    const plain = line.replace(/\*\*|__|`/g, '').replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    if (plain.length < 12) continue;
    if (plain.length <= 140) return plain;
    const cut = plain.slice(0, 140), end = Math.max(...['。', '！', '？', '；'].map(c => cut.lastIndexOf(c)));
    return end >= 40 ? cut.slice(0, end + 1) : cut + '…';
  }
  return '';
}

// 素材箱样例：笔记最多的两个知识库主题各建一个选题，收三篇笔记（一篇只进一个选题）和其中一段摘录；
// 再收一条视频、一个图集放在未归类。内容都取自选中的作品，备注留空，不替作者编话。
function sampleMaterials(stage, now) {
  const at = Math.floor(now() / 1000), lib = createLibrary(stage, { now: () => at, path: join(stage, 'library.sqlite') }), out = { topics: 0, materials: 0 };
  const ledger = new DatabaseSync(join(stage, 'index.sqlite'), { readOnly: true });
  const rows = new Map(ledger.prepare('SELECT id,status,media_type,note_path,media_path,media_deleted FROM items ORDER BY collected_at DESC, id').all().map(r => [r.id, r]));
  ledger.close();
  const add = (item, kind, topic_id, excerpt) => { out.materials++; return lib.addMaterial({ item, kind, topic_id, excerpt }); };
  try {
    let themes = [];
    if (existsSync(join(stage, 'knowledge.sqlite'))) {
      const kb = new DatabaseSync(join(stage, 'knowledge.sqlite'), { readOnly: true });
      try {
        themes = kb.prepare('SELECT t.id, t.name, t.summary, count(*) n FROM themes t JOIN doc_themes d ON d.theme_id=t.id GROUP BY t.id HAVING n>=2 ORDER BY n DESC, t.id').all()
          .map(t => ({ ...t, items: kb.prepare('SELECT item FROM doc_themes WHERE theme_id=? ORDER BY item').all(t.id).map(r => r.item) }));
      } finally { kb.close(); }
    }
    const used = new Set();
    for (const t of themes) {
      if (out.topics === 2) break;
      const notes = t.items.filter(i => rows.get(i)?.note_path && existsSync(rows.get(i).note_path) && !used.has(i)).slice(0, 3);
      if (notes.length < 2 || lib.topics().some(x => x.name === t.name.slice(0, 40))) continue;   // 不同大类可能有同名主题
      const topic = lib.saveTopic({ name: t.name.slice(0, 40), description: t.summary.slice(0, 500) }); out.topics++;
      for (const i of notes) { used.add(i); add(i, rows.get(i).media_type === 'post' ? 'post' : 'note', topic.id); }
      for (const i of notes) {
        const quote = excerptOf(readFileSync(rows.get(i).note_path, 'utf8'));
        if (!quote) continue;
        const m = add(i, 'excerpt', topic.id, quote);
        if (out.topics === 1) lib.updateMaterial(m.id, { status: 'using' });   // 看板的「在用」一栏也有一条
        break;
      }
    }
    for (const type of ['video', 'gallery']) {
      const r = [...rows.values()].find(r => r.media_type === type && r.status === 'saved' && r.media_path && !r.media_deleted && existsSync(r.media_path));
      if (r) add(r.id, type, null);
    }
  } finally { lib.close(); }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dryRun = process.argv.includes('--dry-run'), status = buildStatusFile(DUST_HOME);
  try {
    const info = await buildDemo({ dryRun });
    if (!dryRun) atomicWrite(status, JSON.stringify({ ok: true, at: Date.now(), ...info }) + '\n');
    console.log(JSON.stringify(info, null, 2));
  } catch (e) {
    if (!dryRun) { try { atomicWrite(status, JSON.stringify({ ok: false, at: Date.now(), error: e.message }) + '\n'); } catch {} }
    console.error(`✗ ${e.message}`);
    if (process.send) process.send({ type: 'action-error', message: e.message });
    process.exitCode = 1;
  }
}
