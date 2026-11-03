// 资料库数据：已读记录、选题、素材和对外访问令牌。
// 与收藏账本分开存放在 library.sqlite：这些都是用户在控制台里的操作，控制台直接读写，
// 不经过流水线锁，也不影响账本迁移。作品只按 ID 引用，笔记和媒体文件不复制。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { localPath } from './policy.mjs';
import { validItemId } from './platforms.mjs';
import { HttpError } from './console-store.mjs';

export const MATERIAL_KINDS = ['note', 'excerpt', 'video', 'gallery', 'post'];
export const MATERIAL_STATUSES = ['todo', 'using', 'used'];
export const TOKEN_SCOPES = ['read', 'write'];
const COLORS = ['#C2703D', '#5B7FC7', '#8A5BC7', '#2C8A6A', '#C79A3D', '#C75B6E', '#4E9AA8', '#7A8C3D'];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS reads (item TEXT PRIMARY KEY, read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  channels TEXT NOT NULL DEFAULT '[]', color TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, item TEXT NOT NULL, kind TEXT NOT NULL, topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'todo', excerpt TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_materials_topic ON materials(topic_id, status);
CREATE INDEX IF NOT EXISTS idx_materials_updated ON materials(updated_at, id);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, hint TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
`;
const digest = value => createHash('sha256').update(value).digest('hex');
const clean = (value, label, max) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}格式不正确`);
  const text = value.replace(/\0/g, '').trim();
  if (text.length > max) throw new HttpError(400, `${label}不能超过 ${max} 字`);
  return text;
};
const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

export function createLibrary(home, { now = () => Math.floor(Date.now() / 1000), path } = {}) {
  const file = localPath(path || process.env.DUST_LIBRARY_DB || join(home, 'library.sqlite'));
  let db = null;
  function open() {
    if (db) return db;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON');
    db.exec(SCHEMA);
    return db;
  }
  const one = (sql, ...args) => open().prepare(sql).get(...args);
  const all = (sql, ...args) => open().prepare(sql).all(...args);
  const run = (sql, ...args) => open().prepare(sql).run(...args);

  // ── 已读 ──
  function readIds() { return new Map(all('SELECT item, read_at FROM reads').map(r => [r.item, r.read_at])); }
  function setRead(item, read) {
    if (!validItemId(item)) throw new HttpError(400, '作品 ID 不正确');
    if (read) run('INSERT INTO reads(item, read_at) VALUES(?, ?) ON CONFLICT(item) DO UPDATE SET read_at=excluded.read_at', item, now());
    else run('DELETE FROM reads WHERE item=?', item);
    return { item, read: !!read };
  }

  // ── 选题 ──
  const topicRow = r => r && ({ id: r.id, name: r.name, description: r.description, channels: json(r.channels, []), color: r.color, created_at: r.created_at, updated_at: r.updated_at, count: r.count ?? 0, used: r.used ?? 0 });
  function topics() {
    return all(`SELECT t.*, count(m.id) count, sum(m.status='used') used FROM topics t LEFT JOIN materials m ON m.topic_id=t.id
      GROUP BY t.id ORDER BY t.created_at, t.id`).map(topicRow);
  }
  function topic(id) {
    const row = one('SELECT * FROM topics WHERE id=?', Number(id));
    if (!row) throw new HttpError(404, '选题不存在');
    return topicRow(row);
  }
  function saveTopic(input = {}) {
    const name = clean(input.name, '选题名称', 40);
    if (!name) throw new HttpError(400, '请填写选题名称');
    const description = clean(input.description, '选题说明', 500);
    const channels = Array.isArray(input.channels) ? [...new Set(input.channels.map(c => clean(c, '发布渠道', 20)).filter(Boolean))].slice(0, 6) : [];
    const duplicate = one('SELECT id FROM topics WHERE name=?', name);
    if (duplicate && duplicate.id !== Number(input.id)) throw new HttpError(409, '已有同名选题');
    if (input.id) {
      topic(input.id);
      run('UPDATE topics SET name=?, description=?, channels=?, updated_at=? WHERE id=?', name, description, JSON.stringify(channels), now(), Number(input.id));
      return topic(input.id);
    }
    const count = one('SELECT count(*) n FROM topics').n;
    const { lastInsertRowid } = run('INSERT INTO topics(name, description, channels, color, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)', name, description, JSON.stringify(channels), COLORS[count % COLORS.length], now(), now());
    return topic(Number(lastInsertRowid));
  }
  function deleteTopic(id) {
    topic(id);
    // 删除选题不删除素材：素材回到“未归类”。
    run('UPDATE materials SET topic_id=NULL, updated_at=? WHERE topic_id=?', now(), Number(id));
    run('DELETE FROM topics WHERE id=?', Number(id));
    return { deleted: true };
  }

  // ── 素材 ──
  const materialRow = r => r && ({ id: r.id, item: r.item, kind: r.kind, topic_id: r.topic_id, status: r.status, excerpt: r.excerpt, memo: r.memo, usage: json(r.usage, []), created_at: r.created_at, updated_at: r.updated_at });
  function material(id) {
    const row = one('SELECT * FROM materials WHERE id=?', Number(id));
    if (!row) throw new HttpError(404, '素材不存在');
    return materialRow(row);
  }
  function materials({ topic: topicId, status, kind, since, item, limit = 500, after = 0 } = {}) {
    const where = [], values = [];
    if (topicId === 'none') where.push('topic_id IS NULL');
    else if (topicId !== undefined && topicId !== '' && topicId !== 'all') { where.push('topic_id=?'); values.push(Number(topicId)); }
    if (status && status !== 'all') { if (!MATERIAL_STATUSES.includes(status)) throw new HttpError(400, '素材状态无效'); where.push('status=?'); values.push(status); }
    if (kind && kind !== 'all') { if (!MATERIAL_KINDS.includes(kind)) throw new HttpError(400, '素材类型无效'); where.push('kind=?'); values.push(kind); }
    if (since !== undefined && since !== '') { const n = Number(since); if (!Number.isFinite(n)) throw new HttpError(400, 'since 须为秒级时间戳'); where.push('(updated_at>? OR (updated_at=? AND id>?))'); values.push(n, n, Number(after) || 0); }
    if (item) { where.push('item=?'); values.push(String(item)); }
    const size = Math.min(500, Math.max(1, Number(limit) || 500));
    const order = since !== undefined && since !== '' ? 'updated_at ASC, id ASC' : 'updated_at DESC, id DESC';
    return all(`SELECT * FROM materials ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`, ...values, size).map(materialRow);
  }
  function addMaterial(input = {}) {
    if (!validItemId(input.item)) throw new HttpError(400, '作品 ID 不正确');
    if (!MATERIAL_KINDS.includes(input.kind)) throw new HttpError(400, '素材类型无效');
    const excerpt = clean(input.excerpt, '摘录', 4000), memo = clean(input.memo, '备注', 1000);
    if (input.kind === 'excerpt' && !excerpt) throw new HttpError(400, '摘录内容为空，请先选中一段文字');
    const topicId = input.topic_id === null || input.topic_id === undefined || input.topic_id === '' ? null : topic(input.topic_id).id;
    // 同一作品重复收整篇或原媒体时，更新已有素材而不是再建一条；摘录可以有多条。
    if (input.kind !== 'excerpt') {
      const existing = one('SELECT id FROM materials WHERE item=? AND kind=?', input.item, input.kind);
      if (existing) return updateMaterial(existing.id, { topic_id: input.topic_id === undefined ? undefined : topicId, memo: memo || undefined });
    }
    const { lastInsertRowid } = run('INSERT INTO materials(item, kind, topic_id, excerpt, memo, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)', input.item, input.kind, topicId, excerpt, memo, now(), now());
    return material(Number(lastInsertRowid));
  }
  function updateMaterial(id, input = {}) {
    const current = material(id), next = { ...current };
    if (input.topic_id !== undefined) next.topic_id = input.topic_id === null || input.topic_id === '' ? null : topic(input.topic_id).id;
    if (input.status !== undefined) { if (!MATERIAL_STATUSES.includes(input.status)) throw new HttpError(400, '素材状态无效'); next.status = input.status; }
    if (input.memo !== undefined) next.memo = clean(input.memo, '备注', 1000);
    if (input.excerpt !== undefined && current.kind === 'excerpt') { next.excerpt = clean(input.excerpt, '摘录', 4000); if (!next.excerpt) throw new HttpError(400, '摘录不能为空'); }
    run('UPDATE materials SET topic_id=?, status=?, memo=?, excerpt=?, updated_at=? WHERE id=?', next.topic_id, next.status, next.memo, next.excerpt, now(), current.id);
    return material(current.id);
  }
  function removeMaterial(id) { material(id); run('DELETE FROM materials WHERE id=?', Number(id)); return { deleted: true }; }
  function recordUsage(id, input = {}) {
    const current = material(id);
    const channel = clean(input.channel, '发布渠道', 20), title = clean(input.title, '标题', 200), url = clean(input.url, '链接', 500);
    if (!channel && !title) throw new HttpError(400, '请至少填写发布渠道或标题');
    if (url && !/^https?:\/\//.test(url)) throw new HttpError(400, '链接须为 http(s) 地址');
    const usage = [...current.usage, { channel, title, url, at: now() }].slice(-20);
    run("UPDATE materials SET usage=?, status='used', updated_at=? WHERE id=?", JSON.stringify(usage), now(), current.id);
    return material(current.id);
  }

  /**
   * 选题建议：按标签和分类与各选题已有素材的重合程度排序，不调用模型。
   * metaOf(itemId) 返回 {category, tags}；空选题没有可比的素材，不参与建议。
   */
  function suggest(meta, metaOf) {
    const mine = new Set((meta?.tags || []).map(t => t.toLowerCase()));
    const scores = [];
    for (const t of topics()) {
      let score = 0, shared = new Set(), sameCategory = 0;
      for (const m of materials({ topic: t.id, limit: 200 })) {
        const other = metaOf(m.item); if (!other) continue;
        for (const tag of other.tags || []) if (mine.has(tag.toLowerCase())) { shared.add(tag); score += 1; }
        if (meta?.category && other.category === meta.category) { sameCategory++; score += 2; }
      }
      if (score > 0) scores.push({ topic_id: t.id, score, reason: [shared.size ? `标签 ${[...shared].slice(0, 3).join('、')} 与已有素材重合` : '', sameCategory ? `分类「${meta.category}」与 ${sameCategory} 条素材相同` : ''].filter(Boolean).join('；') });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  // ── 对外访问令牌 ──
  const tokenRow = r => ({ id: r.id, name: r.name, hint: r.hint, scope: r.scope, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at });
  function tokens() { return all('SELECT * FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC').map(tokenRow); }
  function createToken({ name, scope } = {}) {
    const label = clean(name, '令牌名称', 40);
    if (!label) throw new HttpError(400, '请填写令牌名称，便于以后辨认');
    if (!TOKEN_SCOPES.includes(scope)) throw new HttpError(400, '令牌权限无效');
    if (one('SELECT count(*) n FROM api_tokens WHERE revoked_at IS NULL').n >= 20) throw new HttpError(409, '有效令牌已达 20 个，请先吊销不用的');
    const secret = 'dsk_' + randomBytes(24).toString('base64url');
    const { lastInsertRowid } = run('INSERT INTO api_tokens(name, hint, hash, scope, created_at) VALUES(?, ?, ?, ?, ?)', label, secret.slice(-4), digest(secret), scope, now());
    // 明文只在这里返回一次，库里只留哈希。
    return { ...tokenRow(one('SELECT * FROM api_tokens WHERE id=?', Number(lastInsertRowid))), token: secret };
  }
  function revokeToken(id) {
    const row = one('SELECT * FROM api_tokens WHERE id=?', Number(id));
    if (!row) throw new HttpError(404, '令牌不存在');
    if (!row.revoked_at) run('UPDATE api_tokens SET revoked_at=? WHERE id=?', now(), row.id);
    return { revoked: true };
  }
  function verifyToken(secret) {
    if (typeof secret !== 'string' || !/^dsk_[A-Za-z0-9_-]{32}$/.test(secret)) return null;
    const hash = digest(secret), row = one('SELECT * FROM api_tokens WHERE hash=?', hash);
    if (!row || row.revoked_at || !timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(hash, 'hex'))) return null;
    if (!row.last_used_at || now() - row.last_used_at >= 60) run('UPDATE api_tokens SET last_used_at=? WHERE id=?', now(), row.id);
    return tokenRow(row);
  }

  function close() { if (db) { db.close(); db = null; } }
  return { file, readIds, setRead, topics, topic, saveTopic, deleteTopic, materials, material, addMaterial, updateMaterial, removeMaterial, recordUsage, suggest, tokens, createToken, revokeToken, verifyToken, close };
}
