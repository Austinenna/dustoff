// 知识库索引 knowledge.sqlite：每篇笔记讲到的概念、概念之间的关系、待确认的合并建议，以及各大类下归纳出的主题。
// 里面的内容全部由笔记和账本推导出来，删掉可以用 knowledge.mjs --rebuild 重建；
// 用户的操作记录（已读等）不放这里，放 library.sqlite。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { localPath } from './policy.mjs';
import { DOMAINS, UNSORTED, missingNotes, noteBody, normName } from './knowledge-extract.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  item TEXT PRIMARY KEY,            -- 沿用账本和 library.sqlite 的作品 ID
  platform TEXT NOT NULL, kind TEXT NOT NULL,   -- kind: note 整理过的笔记 / post 只存了原帖
  title TEXT, author TEXT, collected_at INTEGER, decay TEXT, path TEXT NOT NULL,
  gist TEXT NOT NULL DEFAULT '',    -- 正文第一段的开头，归纳主题时给模型看
  content_hash TEXT NOT NULL,       -- 当前笔记正文的哈希
  extracted_hash TEXT,              -- 上次抽取时的正文哈希；和 content_hash 不同就要重抽
  prompt_hash TEXT, model TEXT, extracted_at INTEGER,
  domain TEXT,                      -- 固定大类，由模型从列表里选
  domain_note TEXT NOT NULL DEFAULT '',       -- 模型归到这个大类的理由；「未分类」的是原因
  classified_hash TEXT, domain_hash TEXT,     -- 上次分类时的正文哈希和分类提示词指纹
  theme_checked INTEGER NOT NULL DEFAULT 0,   -- 所在大类归纳主题时有没有算上这篇
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, merge_checked INTEGER NOT NULL DEFAULT 0);
-- 一个概念的全部写法（归一后）。合并时把被并概念的写法指到保留的概念上，以后抽到旧写法也能对上。
CREATE TABLE IF NOT EXISTS aliases (norm TEXT PRIMARY KEY, concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mentions (
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, item TEXT NOT NULL REFERENCES docs(item) ON DELETE CASCADE,
  role TEXT NOT NULL,               -- 主题 / 提到
  PRIMARY KEY (concept_id, item));
CREATE INDEX IF NOT EXISTS idx_mentions_item ON mentions(item);
CREATE TABLE IF NOT EXISTS relations (
  from_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  type TEXT NOT NULL, item TEXT NOT NULL REFERENCES docs(item) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id, type, item));
-- 合并记录：模型拿不准、等用户确认的概念对，以及已经做过的合并。
-- 按两个概念当时的归一名记（a 是保留的那个），概念编号重建后会变，名字不会；
-- 所以重建后能照着重放已做的合并，问过的概念对也不会再问。
CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY, a_norm TEXT NOT NULL, b_norm TEXT NOT NULL, pair TEXT NOT NULL UNIQUE, reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',   -- pending 待确认 / merged 已合并 / kept 保持分开
  created_at INTEGER NOT NULL, decided_at INTEGER);
-- 用户在控制台手工指定的大类。重新分类、--rebuild 都不覆盖。
CREATE TABLE IF NOT EXISTS domain_overrides (item TEXT PRIMARY KEY, domain TEXT NOT NULL, created_at INTEGER NOT NULL);
-- 主题：一个大类下反复出现的题目，由模型看过该大类全部笔记后归纳。综述页按主题写。
CREATE TABLE IF NOT EXISTS themes (
  id INTEGER PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL, norm TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, UNIQUE (domain, norm));
CREATE TABLE IF NOT EXISTS doc_themes (
  theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE, item TEXT NOT NULL REFERENCES docs(item) ON DELETE CASCADE,
  PRIMARY KEY (theme_id, item));
CREATE INDEX IF NOT EXISTS idx_doc_themes_item ON doc_themes(item);
-- 综述页：一个主题一页，由模型把主题下的全部笔记合写出来。每次都从原笔记整页重写。
CREATE TABLE IF NOT EXISTS pages (
  theme_id INTEGER PRIMARY KEY REFERENCES themes(id) ON DELETE CASCADE,
  body TEXT,                        -- 综述内容（JSON）；里面的「笔记 N」和出处编号指 items 里的第 N 篇
  items TEXT NOT NULL DEFAULT '[]', -- 写这一版时用的笔记，按编号顺序
  source_hash TEXT,                 -- 写这一版时的笔记清单和各篇正文的哈希；和现在的不同就要重写
  prompt_hash TEXT, model TEXT, built_at INTEGER,
  changes TEXT NOT NULL DEFAULT '', -- 这一版相比上一版的变化；第一版为空
  complete INTEGER,                 -- 1 每篇笔记都写到了；0 重写 3 次仍有漏的；空：早先写的，没做过这项检查
  failed_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);   -- failed_hash：写不出来的那一版笔记，笔记不变就不再试
`;
// 3 篇以上的主题才写综述：一两篇没有可合并的内容，写出来只是复述。
export const PAGE_MIN_NOTES = 3;
const MANUAL_NOTE = '手动指定';
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
// 正文第一段文字的开头：跳过标题、分隔线和提示行，去掉加粗等标记。
function gistOf(body) {
  const line = body.split(/\r?\n/).find(l => l.trim() && !/^\s*(#|---|\||!\[|```)/.test(l) && !l.includes('⚠️')) || '';
  return line.replace(/^\s*(?:>|[-*+]|\d+[.)])\s*/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim().slice(0, 100);
}
function headerTitle(source) {
  const value = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.match(/^标题:\s*(.+)$/m)?.[1]?.trim();
  if (!value) return '';
  try { return value.startsWith('"') ? String(JSON.parse(value)).trim() : value; } catch { return value; }
}

export const bodyHash = sha;
export function createKnowledge(home, { now = () => Math.floor(Date.now() / 1000), path } = {}) {
  const file = localPath(path || process.env.DUST_KNOWLEDGE_DB || join(home, 'knowledge.sqlite'));
  let db = null;
  function open() {
    if (db) return db;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    db.exec(SCHEMA);
    // 早先建的库没有这几列。
    const cols = new Set(db.prepare('PRAGMA table_info(docs)').all().map(c => c.name));
    for (const [name, type] of [['domain_note', "TEXT NOT NULL DEFAULT ''"], ['classified_hash', 'TEXT'], ['domain_hash', 'TEXT']]) if (!cols.has(name)) db.exec(`ALTER TABLE docs ADD COLUMN ${name} ${type}`);
    if (!db.prepare('PRAGMA table_info(pages)').all().some(c => c.name === 'complete')) db.exec('ALTER TABLE pages ADD COLUMN complete INTEGER');
    return db;
  }
  const one = (sql, ...args) => open().prepare(sql).get(...args);
  const all = (sql, ...args) => open().prepare(sql).all(...args);
  const run = (sql, ...args) => open().prepare(sql).run(...args);
  function tx(fn) {
    open().exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  /**
   * 按账本对齐 docs：有笔记文件的条目进来，笔记没了的连同它的概念关联一起删掉。
   * 身份和元数据读账本，不读笔记头部（三个来源的头部字段不一样）。账本只读打开，不改任何数据。
   */
  function syncDocs(ledgerFile = localPath(process.env.DUST_DB || join(home, 'index.sqlite'))) {
    if (!existsSync(ledgerFile)) return { total: 0, added: 0, changed: 0, removed: 0 };
    const ledger = new DatabaseSync(ledgerFile, { readOnly: true });
    let rows;
    try {
      rows = ledger.prepare(`SELECT id,platform,title,author,media_type,decay,note_path,prompt_hash,collected_at,first_seen FROM items
        WHERE note_path IS NOT NULL AND note_path!='' AND COALESCE(skip_reason,'')!='user_deleted'`).all();
    } finally { ledger.close(); }
    const stats = { total: 0, added: 0, changed: 0, removed: 0 }, alive = new Set();
    tx(() => {
      for (const r of rows) {
        let source, path;
        try {
          path = localPath(r.note_path);
          if (extname(path) !== '.md' || statSync(path).size > 4 * 1024 ** 2) continue;
          source = readFileSync(path, 'utf8');
        } catch { continue; }   // 笔记文件缺失：当作没有这篇
        const body = noteBody(source), hash = sha(body);
        // 笔记里的标题是模型凝练过的，比账本里的原标题更适合看。
        const title = headerTitle(source) || r.title || r.id;
        const kind = r.media_type === 'post' && !r.prompt_hash ? 'post' : 'note';
        const old = one('SELECT content_hash FROM docs WHERE item=?', r.id);
        alive.add(r.id); stats.total++;
        if (!old) stats.added++; else if (old.content_hash !== hash) stats.changed++;
        run(`INSERT INTO docs(item,platform,kind,title,author,collected_at,decay,path,gist,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(item) DO UPDATE SET platform=excluded.platform,kind=excluded.kind,title=excluded.title,author=excluded.author,
          collected_at=excluded.collected_at,decay=excluded.decay,path=excluded.path,gist=excluded.gist,content_hash=excluded.content_hash`,
          r.id, r.platform, kind, title, r.author, r.collected_at || r.first_seen, r.decay, path, gistOf(body), hash);
      }
      for (const { item, domain } of all('SELECT item,domain FROM docs')) if (!alive.has(item)) {
        run('DELETE FROM docs WHERE item=?', item); stats.removed++;
        if (domain) run('UPDATE docs SET theme_checked=0 WHERE domain=?', domain);   // 少了一篇，这个大类的主题要重新归纳
      }
      dropOrphans();
    });
    return stats;
  }

  /**
   * 等待处理的笔记：没分类或没抽过、正文变了；stale 为真时再加上用旧版指令做的。失败满 3 次的不再自动重试。
   * need_classify、need_extract 标出这篇要做哪一步：只改了大类定义时，只重新分类，不重抽概念。
   */
  function pendingDocs({ promptHash, classifyHash, stale = false, retryFailed = false, limit = 100000 } = {}) {
    const classify = ['classified_hash IS NULL', 'classified_hash!=content_hash'], extract = ['extracted_hash IS NULL', 'extracted_hash!=content_hash'], args = [];
    if (stale) { classify.push('domain_hash IS NOT ?'); args.push(classifyHash ?? null); extract.push('prompt_hash IS NOT ?'); args.push(promptHash ?? null); }
    return all(`SELECT * FROM (SELECT item,platform,kind,title,author,path,content_hash,domain,collected_at,attempts,
      ((${classify.join(' OR ')}) AND item NOT IN (SELECT item FROM domain_overrides)) need_classify, (${extract.join(' OR ')}) need_extract FROM docs)
      WHERE (need_classify OR need_extract) ${retryFailed ? '' : 'AND attempts<3'} ORDER BY collected_at, item LIMIT ?`, ...args, limit);
  }

  /** 已有概念的名称，被越多笔记讲到的越靠前。给抽取做参照，让同一个东西用同一个写法。 */
  function vocabulary(limit = 400) {
    return all(`SELECT c.name FROM concepts c LEFT JOIN mentions m ON m.concept_id=c.id GROUP BY c.id ORDER BY count(m.item) DESC, c.id LIMIT ?`, limit).map(r => r.name);
  }

  function conceptId({ name, norm, type, summary }) {
    const hit = one('SELECT concept_id id FROM aliases WHERE norm=?', norm);
    if (hit) {
      // 先抽到的那篇可能没给说明，后面补上。
      if (summary) run("UPDATE concepts SET summary=? WHERE id=? AND summary=''", summary, hit.id);
      return hit.id;
    }
    const id = Number(run('INSERT INTO concepts(name,type,summary,created_at) VALUES(?,?,?,?)', name, type, summary || '', now()).lastInsertRowid);
    run('INSERT INTO aliases(norm,concept_id,name) VALUES(?,?,?)', norm, id, name);
    return id;
  }

  /** 写入一篇笔记的大类。大类变了，原来和现在的大类都要重新归纳主题。 */
  function saveDomain(item, { domain, domainNote = '' }, { hash, contentHash } = {}) {
    return tx(() => {
      const doc = one('SELECT domain,content_hash FROM docs WHERE item=?', item);
      if (!doc) return false;
      if (doc.domain !== domain) {
        run('DELETE FROM doc_themes WHERE item=?', item);
        if (doc.domain) run('UPDATE docs SET theme_checked=0 WHERE domain=?', doc.domain);
        run('UPDATE docs SET theme_checked=0 WHERE item=?', item);
      }
      run('UPDATE docs SET domain=?,domain_note=?,classified_hash=?,domain_hash=?,attempts=0,error=NULL WHERE item=?', domain, domainNote, contentHash || doc.content_hash, hash || null, item);
      return true;
    });
  }

  /** 用户手工指定大类；domain 为空表示取消指定，下次运行由模型重新分类。 */
  function setDomain(item, domain) {
    if (!one('SELECT 1 FROM docs WHERE item=?', item)) throw new Error('这篇笔记还没进知识库索引');
    if (!domain) {
      const changed = Number(run('DELETE FROM domain_overrides WHERE item=?', item).changes) > 0;
      if (changed) run('UPDATE docs SET classified_hash=NULL WHERE item=?', item);
      return { item, manual: false };
    }
    if (domain !== UNSORTED && !DOMAINS.some(d => d.name === domain)) throw new Error('大类不在固定列表里');
    run('INSERT INTO domain_overrides(item,domain,created_at) VALUES(?,?,?) ON CONFLICT(item) DO UPDATE SET domain=excluded.domain,created_at=excluded.created_at', item, domain, now());
    saveDomain(item, { domain, domainNote: MANUAL_NOTE });
    return { item, domain, manual: true };
  }

  /** 写入一篇笔记的抽取结果；重抽时先清掉这篇旧的概念关联。 */
  function saveExtraction(item, { concepts, relations }, { promptHash, model, contentHash } = {}) {
    return tx(() => {
      const doc = one('SELECT content_hash FROM docs WHERE item=?', item);
      if (!doc) return false;
      run('DELETE FROM mentions WHERE item=?', item); run('DELETE FROM relations WHERE item=?', item);
      const ids = new Map();
      for (const c of concepts) {
        const id = conceptId(c); ids.set(c.norm, id);
        // 两个写法指到同一个概念时，主题优先。
        run(`INSERT INTO mentions(concept_id,item,role) VALUES(?,?,?) ON CONFLICT(concept_id,item) DO UPDATE SET role=CASE WHEN excluded.role='主题' THEN '主题' ELSE role END`, id, item, c.role);
      }
      for (const r of relations) {
        const from = ids.get(r.from), to = ids.get(r.to);
        if (from && to && from !== to) run('INSERT OR IGNORE INTO relations(from_id,to_id,type,item) VALUES(?,?,?,?)', from, to, r.type, item);
      }
      run('UPDATE docs SET extracted_hash=?,prompt_hash=?,model=?,extracted_at=?,theme_checked=0,attempts=0,error=NULL WHERE item=?', contentHash || doc.content_hash, promptHash || null, model || null, now(), item);
      return true;
    });
  }
  function markError(item, message, { permanent = false } = {}) {
    run('UPDATE docs SET attempts=?,error=? WHERE item=?', permanent ? 3 : (one('SELECT attempts n FROM docs WHERE item=?', item)?.n || 0) + 1, String(message).slice(0, 300), item);
  }
  function dropOrphans() { return Number(run('DELETE FROM concepts WHERE id NOT IN (SELECT concept_id FROM mentions)').changes); }

  // ── 归并 ──
  const pairKey = (a, b) => [a, b].sort().join('\u0001');
  const byNorm = norm => one('SELECT concept_id id FROM aliases WHERE norm=?', norm)?.id;
  const normOf = id => { const row = one('SELECT name FROM concepts WHERE id=?', id); return row ? normName(row.name) : null; };
  function mergeRows(keep, drop) {
    run(`INSERT INTO mentions(concept_id,item,role) SELECT ?,item,role FROM mentions WHERE concept_id=? ON CONFLICT(concept_id,item) DO UPDATE SET role=CASE WHEN excluded.role='主题' THEN '主题' ELSE role END`, keep, drop);
    run('INSERT OR IGNORE INTO relations(from_id,to_id,type,item) SELECT ?,to_id,type,item FROM relations WHERE from_id=? AND to_id!=?', keep, drop, keep);
    run('INSERT OR IGNORE INTO relations(from_id,to_id,type,item) SELECT from_id,?,type,item FROM relations WHERE to_id=? AND from_id!=?', keep, drop, keep);
    run('UPDATE aliases SET concept_id=? WHERE concept_id=?', keep, drop);
    run("UPDATE concepts SET summary=(SELECT summary FROM concepts WHERE id=?) WHERE id=? AND summary=''", drop, keep);
    run('DELETE FROM concepts WHERE id=?', drop);   // 余下的 mentions、relations 随外键一起删
  }
  /** 把 drop 并进 keep：笔记关联、关系、写法都转过去，并记下这次合并供重建后重放。 */
  function merge(keep, drop, reason = '') {
    if (keep === drop) return false;
    return tx(() => {
      const a = normOf(keep), b = normOf(drop);
      if (!a || !b) return false;
      mergeRows(keep, drop);
      run(`INSERT INTO merges(a_norm,b_norm,pair,reason,state,created_at,decided_at) VALUES(?,?,?,?,'merged',?,?)
        ON CONFLICT(pair) DO UPDATE SET a_norm=excluded.a_norm,b_norm=excluded.b_norm,state='merged',decided_at=excluded.decided_at`, a, b, pairKey(a, b), reason, now(), now());
      return true;
    });
  }
  /** 重建或重抽之后，把以前做过的合并照着再做一遍。两个写法还各是一个概念时才需要做。 */
  function replayMerges() {
    return tx(() => {
      let n = 0;
      for (const row of all("SELECT a_norm,b_norm FROM merges WHERE state='merged' ORDER BY id")) {
        const keep = byNorm(row.a_norm), drop = byNorm(row.b_norm);
        if (keep && drop && keep !== drop) { mergeRows(keep, drop); n++; }
      }
      return n;
    });
  }
  /** 记一条待确认的合并建议。同一对概念问过一次就不再问，不管当时的结论是什么。 */
  function suggest(a, b, reason = '') {
    const x = normOf(a), y = normOf(b);
    if (a === b || !x || !y) return false;
    return Number(run('INSERT OR IGNORE INTO merges(a_norm,b_norm,pair,reason,created_at) VALUES(?,?,?,?,?)', x, y, pairKey(x, y), reason, now()).changes) > 0;
  }
  /** 用户对一条建议的决定：合并（a 保留），或保持分开。 */
  function decide(id, mergeIt) {
    const row = one("SELECT * FROM merges WHERE id=? AND state='pending'", Number(id));
    if (!row) return false;
    const keep = byNorm(row.a_norm), drop = byNorm(row.b_norm);
    if (mergeIt && keep && drop && keep !== drop) return merge(keep, drop, row.reason);
    run("UPDATE merges SET state=?,decided_at=? WHERE id=?", mergeIt ? 'merged' : 'kept', now(), row.id);
    return true;
  }
  /** 待确认的建议。其中一方已经不存在，或两个写法已经是同一个概念的，不再列出。 */
  function pendingMerges() {
    return all("SELECT id,a_norm,b_norm,reason FROM merges WHERE state='pending' ORDER BY id").map(g => {
      const a = byNorm(g.a_norm), b = byNorm(g.b_norm);
      if (!a || !b || a === b) return null;
      const name = id => one('SELECT name FROM concepts WHERE id=?', id).name;
      return { id: g.id, reason: g.reason, a_id: a, a_name: name(a), b_id: b, b_name: name(b) };
    }).filter(Boolean);
  }

  // 概念所属的大类：讲到它的笔记里出现最多的那个大类。
  const CONCEPT_ROWS = `SELECT c.id, c.name, c.type, c.summary, c.merge_checked, count(m.item) notes, sum(m.role='主题') topics,
      (SELECT d.domain FROM mentions m2 JOIN docs d ON d.item=m2.item WHERE m2.concept_id=c.id AND d.domain IS NOT NULL
        GROUP BY d.domain ORDER BY count(*) DESC, d.domain LIMIT 1) domain
    FROM concepts c JOIN mentions m ON m.concept_id=c.id GROUP BY c.id`;
  function concepts() { return all(`${CONCEPT_ROWS} ORDER BY topics DESC, notes DESC, c.name`); }
  /** 还有概念没做过归并判断的大类，连同该大类的全部概念。 */
  function mergeBatches() {
    const groups = new Map();
    for (const c of concepts()) { const list = groups.get(c.domain || '') || []; list.push(c); groups.set(c.domain || '', list); }
    return [...groups].filter(([domain, list]) => domain && list.length > 1 && list.some(c => !c.merge_checked)).map(([domain, list]) => ({ domain, concepts: list }));
  }
  function markMergeChecked(ids) { tx(() => { for (const id of ids) run('UPDATE concepts SET merge_checked=1 WHERE id=?', id); }); }

  // ── 主题 ──
  /** 有笔记还没参加过主题归纳的大类，连同该大类的全部笔记和已有主题。「未分类」里的笔记互不相干，不归纳。 */
  function themeBatches() {
    const domains = all('SELECT DISTINCT domain FROM docs WHERE domain IS NOT NULL AND domain!=? AND extracted_hash IS NOT NULL AND theme_checked=0', UNSORTED).map(r => r.domain);
    return domains.map(domain => {
      const notes = all('SELECT item,title,gist FROM docs WHERE domain=? AND extracted_hash IS NOT NULL ORDER BY collected_at, item', domain).map(d => {
        const cs = all('SELECT c.name, m.role FROM mentions m JOIN concepts c ON c.id=m.concept_id WHERE m.item=? ORDER BY c.id', d.item);
        return { ...d, topics: cs.filter(c => c.role === '主题').map(c => c.name), mentions: cs.filter(c => c.role !== '主题').map(c => c.name) };
      });
      return { domain, notes, themes: all('SELECT name,summary FROM themes WHERE domain=? ORDER BY id', domain) };
    });
  }
  /** 写入一个大类的主题归纳结果。名称没变的主题保留原编号（以后的综述页挂在编号上），不再出现的删掉。 */
  function saveThemes(domain, themes) {
    tx(() => {
      const keep = new Set();
      run('DELETE FROM doc_themes WHERE theme_id IN (SELECT id FROM themes WHERE domain=?)', domain);
      for (const t of themes) {
        run('INSERT INTO themes(domain,name,norm,summary,created_at) VALUES(?,?,?,?,?) ON CONFLICT(domain,norm) DO UPDATE SET name=excluded.name,summary=excluded.summary', domain, t.name, t.norm, t.summary || '', now());
        const id = one('SELECT id FROM themes WHERE domain=? AND norm=?', domain, t.norm).id; keep.add(id);
        for (const item of t.items) run('INSERT OR IGNORE INTO doc_themes(theme_id,item) SELECT ?,item FROM docs WHERE item=? AND domain=?', id, item, domain);
      }
      for (const { id } of all('SELECT id FROM themes WHERE domain=?', domain)) if (!keep.has(id)) run('DELETE FROM themes WHERE id=?', id);
      run('UPDATE docs SET theme_checked=1 WHERE domain=? AND extracted_hash IS NOT NULL', domain);
    });
  }
  /** 清空全部主题，之后每个大类从头归纳。改了归纳主题的指令后用。 */
  function resetThemes() { tx(() => { run('DELETE FROM doc_themes'); run('DELETE FROM themes'); run('UPDATE docs SET theme_checked=0'); }); }
  function themes() {
    // page_hash 不为空表示这个主题有综述页；控制台用它判断用户看过的是不是这一版。
    return all(`SELECT t.id, t.domain, t.name, t.summary, count(dt.item) notes,
      (SELECT source_hash FROM pages p WHERE p.theme_id=t.id AND p.body IS NOT NULL) page_hash,
      (SELECT built_at FROM pages p WHERE p.theme_id=t.id AND p.body IS NOT NULL) page_at,
      (SELECT changes FROM pages p WHERE p.theme_id=t.id AND p.body IS NOT NULL) page_changes
      FROM themes t LEFT JOIN doc_themes dt ON dt.theme_id=t.id GROUP BY t.id ORDER BY t.domain, notes DESC, t.id`);
  }
  // ── 综述页 ──
  const pageNotes = id => all('SELECT d.item, d.title, d.author, d.path, d.content_hash FROM doc_themes dt JOIN docs d ON d.item=dt.item WHERE dt.theme_id=? ORDER BY d.collected_at, d.item', id);
  const sourceHash = notes => sha(notes.map(n => `${n.item}:${n.content_hash}`).sort().join('\n'));
  /**
   * 要写或重写综述的主题：够篇数，并且还没有综述、笔记清单或正文变了；stale 为真时再加上用旧版指令写的。
   * 同一批笔记写不出来（失败满 3 次，或被内容审核拒绝）的不再自动重试，等笔记有变化再说。
   */
  function pageBatches({ promptHash, stale = false, retryFailed = false } = {}) {
    return themes().filter(t => t.notes >= PAGE_MIN_NOTES).map(t => {
      const notes = pageNotes(t.id), hash = sourceHash(notes), page = one('SELECT source_hash,prompt_hash,failed_hash,attempts,body,complete FROM pages WHERE theme_id=?', t.id);
      // 早先写的综述没检查过有没有漏写笔记，漏了的重写一次。
      const unchecked = page?.body && page.complete === null && missingNotes(JSON.parse(page.body), notes.length).length > 0;
      const fresh = page?.body && page.source_hash === hash && !unchecked && !(stale && page.prompt_hash !== (promptHash ?? null));
      const gaveUp = !retryFailed && page?.failed_hash === hash && page.attempts >= 3;
      return fresh || gaveUp ? null : { ...t, notes, hash };
    }).filter(Boolean);
  }
  /** 写入一页综述，并记下和上一版相比多了、少了哪几篇笔记。 */
  function savePage(themeId, body, { notes, hash, promptHash, model, complete = true } = {}) {
    return tx(() => {
      if (!one('SELECT 1 FROM themes WHERE id=?', themeId)) return false;
      const old = one('SELECT body,items FROM pages WHERE theme_id=?', themeId), items = notes.map(n => n.item);
      let changes = '';
      if (old?.body) {
        const before = new Set(JSON.parse(old.items)), now_ = new Set(items);
        const added = notes.filter(n => !before.has(n.item)), removed = [...before].filter(i => !now_.has(i)).length;
        changes = [added.length && `新增 ${added.length} 篇：${added.slice(0, 3).map(n => `《${n.title}》`).join('')}${added.length > 3 ? ' 等' : ''}`, removed && `移出 ${removed} 篇`].filter(Boolean).join('；') || '有笔记的正文改过，已按新内容重写';
      }
      run(`INSERT INTO pages(theme_id,body,items,source_hash,prompt_hash,model,built_at,changes,complete) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(theme_id) DO UPDATE SET body=excluded.body,items=excluded.items,source_hash=excluded.source_hash,prompt_hash=excluded.prompt_hash,
        model=excluded.model,built_at=excluded.built_at,changes=excluded.changes,complete=excluded.complete,failed_hash=NULL,attempts=0,error=NULL`,
        themeId, JSON.stringify(body), JSON.stringify(items), hash, promptHash || null, model || null, now(), changes, complete ? 1 : 0);
      return true;
    });
  }
  /** 记一次写综述失败。原来写成的那一版留着继续显示。 */
  function markPageError(themeId, hash, message, { permanent = false } = {}) {
    const old = one('SELECT failed_hash,attempts FROM pages WHERE theme_id=?', themeId);
    const attempts = permanent ? 3 : (old?.failed_hash === hash ? old.attempts : 0) + 1;
    run(`INSERT INTO pages(theme_id,failed_hash,attempts,error) VALUES(?,?,?,?)
      ON CONFLICT(theme_id) DO UPDATE SET failed_hash=excluded.failed_hash,attempts=excluded.attempts,error=excluded.error`, themeId, hash, attempts, String(message).slice(0, 300));
  }
  /** 一页综述，连同它引用的笔记（按编号顺序）。outdated：写完之后主题下的笔记又有变化，下一轮会重写。 */
  function page(themeId) {
    const row = one(`SELECT p.*, t.domain, t.name, t.summary FROM pages p JOIN themes t ON t.id=p.theme_id WHERE p.theme_id=? AND p.body IS NOT NULL`, Number(themeId));
    if (!row) return null;
    const titles = new Map(all('SELECT item,title FROM docs').map(d => [d.item, d.title]));
    return { theme_id: row.theme_id, domain: row.domain, name: row.name, summary: row.summary, body: JSON.parse(row.body),
      notes: JSON.parse(row.items).map(item => ({ item, title: titles.get(item) || null })),   // title 为空：这篇笔记已经不在了
      hash: row.source_hash, built_at: row.built_at, changes: row.changes, model: row.model, outdated: sourceHash(pageNotes(row.theme_id)) !== row.source_hash };
  }
  function pageFailures() { return all('SELECT t.domain, t.name, p.attempts, p.error FROM pages p JOIN themes t ON t.id=p.theme_id WHERE p.error IS NOT NULL ORDER BY t.domain, t.name'); }
  function themeNotes(id) {
    return all('SELECT d.item, d.title, d.platform, d.collected_at, d.decay FROM doc_themes dt JOIN docs d ON d.item=dt.item WHERE dt.theme_id=? ORDER BY d.collected_at DESC', id);
  }
  /** 没有归进任何主题的笔记。 */
  function looseNotes() {
    return all('SELECT item,title,domain FROM docs WHERE extracted_hash IS NOT NULL AND item NOT IN (SELECT item FROM doc_themes) ORDER BY domain, collected_at');
  }

  function conceptNotes(id) {
    return all(`SELECT d.item, d.title, d.platform, d.collected_at, d.decay, d.domain, m.role FROM mentions m JOIN docs d ON d.item=m.item
      WHERE m.concept_id=? ORDER BY m.role='主题' DESC, d.collected_at DESC`, id);
  }
  function stats() {
    const docs = one('SELECT count(*) total, sum(extracted_hash IS NOT NULL) extracted, sum(extracted_hash IS NULL AND attempts>=3) failed FROM docs');
    const c = one(`SELECT count(*) total, sum(notes=1) single, sum(topics>=3) with_page FROM (SELECT count(*) notes, sum(role='主题') topics FROM mentions GROUP BY concept_id)`);
    // 孤立笔记：它讲到的概念没有一个被别的笔记讲到。
    const isolated = one(`SELECT count(*) n FROM docs d WHERE d.extracted_hash IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mentions m JOIN mentions o ON o.concept_id=m.concept_id AND o.item!=m.item WHERE m.item=d.item)`).n;
    return {
      docs: { total: docs.total, extracted: docs.extracted || 0, failed: docs.failed || 0 },
      concepts: { total: c.total, single: c.single || 0, with_page: c.with_page || 0 },
      isolated, pending_merges: pendingMerges().length,
      // with_page：3 篇以上的主题，会写综述页；covered：归进了这类主题的笔记数。
      themes: { total: one('SELECT count(*) n FROM themes').n,
        with_page: one('SELECT count(*) n FROM (SELECT 1 FROM doc_themes GROUP BY theme_id HAVING count(*)>=3)').n,
        covered: one('SELECT count(DISTINCT item) n FROM doc_themes WHERE theme_id IN (SELECT theme_id FROM doc_themes GROUP BY theme_id HAVING count(*)>=3)').n,
        loose: looseNotes().length },
      pages: { total: one('SELECT count(*) n FROM pages WHERE body IS NOT NULL').n, failed: pageFailures().length },
      domains: all('SELECT domain, count(*) notes FROM docs WHERE domain IS NOT NULL GROUP BY domain ORDER BY notes DESC'),
      unsorted: unsorted(),
    };
  }
  /** 归到「未分类」的笔记和原因。 */
  function unsorted() { return all('SELECT item,title,domain_note note FROM docs WHERE domain=? ORDER BY collected_at, item', UNSORTED); }
  /** 控制台用的目录：各大类和它的主题，每篇笔记的大类、主题和概念。 */
  function catalog() {
    const counts = new Map(all('SELECT domain, count(*) n FROM docs WHERE domain IS NOT NULL GROUP BY domain').map(r => [r.domain, r.n]));
    const docs = {};
    const manual = new Set(all('SELECT item FROM domain_overrides').map(r => r.item));
    for (const d of all('SELECT item, domain, domain_note note FROM docs WHERE domain IS NOT NULL')) docs[d.item] = { domain: d.domain, note: d.note, manual: manual.has(d.item), themes: [], concepts: [] };
    for (const r of all('SELECT item, theme_id FROM doc_themes')) docs[r.item]?.themes.push(r.theme_id);
    for (const r of all("SELECT item, concept_id id, role FROM mentions ORDER BY role='主题' DESC, concept_id")) docs[r.item]?.concepts.push({ id: r.id, role: r.role });
    return {
      all: [...DOMAINS.map(d => d.name), UNSORTED],
      domains: [...DOMAINS, { name: UNSORTED, definition: '题材不属于任何一个大类，或模型服务拒绝处理的笔记' }].map(d => ({ ...d, notes: counts.get(d.name) || 0 })).filter(d => d.notes),
      themes: themes(), docs,
      concepts: Object.fromEntries(concepts().map(c => [c.id, { name: c.name, type: c.type, summary: c.summary, notes: c.notes }])),
    };
  }
  function failures() { return all('SELECT item,title,attempts,error FROM docs WHERE error IS NOT NULL ORDER BY item'); }
  function doc(item) { return one('SELECT * FROM docs WHERE item=?', item); }
  function relations() {
    return all(`SELECT r.from_id, r.to_id, r.type, count(*) notes FROM relations r GROUP BY r.from_id, r.to_id, r.type`);
  }
  /** 清空抽取结果，之后全部重抽。合并记录留着：做过的合并会重放，问过的概念对不再问。 */
  function reset() {
    tx(() => {
      run('DELETE FROM mentions'); run('DELETE FROM relations'); run('DELETE FROM concepts'); run('DELETE FROM doc_themes'); run("UPDATE docs SET extracted_hash=NULL,prompt_hash=NULL,model=NULL,extracted_at=NULL,domain=NULL,domain_note='',classified_hash=NULL,domain_hash=NULL,theme_checked=0,attempts=0,error=NULL");
      run('UPDATE docs SET domain=(SELECT domain FROM domain_overrides o WHERE o.item=docs.item),domain_note=?,classified_hash=content_hash WHERE item IN (SELECT item FROM domain_overrides)', MANUAL_NOTE);
    });
  }
  function close() { if (db) { db.close(); db = null; } }
  return { file, syncDocs, pendingDocs, vocabulary, saveDomain, setDomain, saveExtraction, markError, dropOrphans, merge, replayMerges, suggest, decide, pendingMerges, concepts, mergeBatches, markMergeChecked, themeBatches, saveThemes, resetThemes, themes, themeNotes, pageBatches, savePage, markPageError, page, pageFailures, looseNotes, conceptNotes, relations, stats, catalog, failures, unsorted, doc, reset, close };
}
