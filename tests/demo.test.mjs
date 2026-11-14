import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createConsole } from '../console.mjs';
import { createLibrary } from '../scripts/library-store.mjs';
import { createKnowledge } from '../scripts/knowledge-store.mjs';
import { PAGE_HASH } from '../scripts/knowledge-extract.mjs';
import { buildDemo } from '../scripts/make-demo.mjs';

const SNAPSHOT = Date.parse('2026-11-14T12:00:00+08:00');
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
// 虚构的正式数据：笔记 1、2、7 和图集 4、待决定的 5、X 原帖 x6 选进演示站，笔记 3 没选。
// 主题 A（1、2、3）和主题 C（1、2、3、7）的综述出处里有没选的 3；主题 B（1、2、7）的全在选中的笔记里。
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dustoff-demo-'))), home = join(base, 'prod'), demo = join(base, 'demo');
  mkdirSync(home);
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', `import {db} from ${JSON.stringify(new URL('../scripts/ledger.mjs', import.meta.url).href)};db().close();`], { env: { ...process.env, DUST_HOME: home }, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const d of ['notes', 'text', 'saved-media/4/images', 'saved-media/.review/5', 'runs']) mkdirSync(join(home, d), { recursive: true });
  const note = id => { writeFileSync(join(home, 'notes', `${id}.md`), `---\n标题: "笔记${id}"\n---\n# 核心观点\n\n第 ${id} 篇讲剪辑节拍的正文，内容足够长。`); writeFileSync(join(home, 'text', `${id}.txt`), `第 ${id} 篇的原稿。`); };
  for (const id of ['1', '2', '3', '7', 'x6']) note(id);
  writeFileSync(join(home, 'text', '1.words.json'), '[]');
  writeFileSync(join(home, 'saved-media', '4', 'images', '001.jpg'), 'jpg');
  writeFileSync(join(home, 'saved-media', '4', 'images', 'gallery.json'), JSON.stringify({ version: 1, id: '4', images: [{ index: 0, file: '001.jpg', ext: 'jpg', width: 3, height: 4, bytes: 3 }] }));
  writeFileSync(join(home, 'saved-media', '.review', '5', 'video.mp4'), 'mp4');
  const db = new DatabaseSync(join(home, 'index.sqlite'));
  db.exec('CREATE TABLE daily_state(name TEXT PRIMARY KEY,value TEXT); CREATE TABLE daily_queue(id TEXT PRIMARY KEY,metadata TEXT,enqueued INTEGER); CREATE TABLE daily_usage(day TEXT,id TEXT,PRIMARY KEY(day,id));');
  db.prepare('INSERT INTO daily_state VALUES(?,?)').run('baseline', JSON.stringify({ created_at: 1, scanned_at: 2, anchors: ['3'] }));
  db.prepare('INSERT INTO daily_state VALUES(?,?)').run('baseline:x', JSON.stringify({ version: 1, user_id: '42', username: 'secret_handle', complete: true, scanned_at: 3 }));
  db.exec("INSERT INTO daily_queue VALUES('3','{}',1),('5','{}',1); INSERT INTO daily_usage VALUES('2026-11-14','3');");
  const add = db.prepare("INSERT INTO items(id,platform,title,author,status,media_type,processing_mode,first_seen,last_seen,updated_at,collected_at,extracted_at,note_path,text_path,media_path,media_deleted,last_error) VALUES(?,?,?,'作者',?,?,?,1,1,1,?,?,?,?,?,?,?)");
  for (const [n, id] of ['1', '2', '3', '7'].entries()) add.run(id, 'douyin', `原标题${id}`, 'extracted', 'video', 'note', SNAPSHOT / 1000 - 86400 * (n + 1), SNAPSHOT / 1000 - 3600, join(home, 'notes', `${id}.md`), join(home, 'text', `${id}.txt`), join(home, 'media', id, 'video.mp4'), 1, `读不到 ${home}/media/${id}`);
  add.run('4', 'douyin', '图集', 'saved', 'gallery', 'gallery', 1, null, null, null, join(home, 'saved-media', '4', 'images', 'gallery.json'), 0, null);
  add.run('5', 'douyin', '待决定的视频', 'review', 'video', 'review', 1, null, null, null, join(home, 'saved-media', '.review', '5', 'video.mp4'), 0, null);
  add.run('x6', 'x', '原帖', 'extracted', 'post', 'note', 1, 1, join(home, 'notes', 'x6.md'), join(home, 'text', 'x6.txt'), null, 0, null);
  db.close();
  writeFileSync(join(home, 'runs', 'history.jsonl'), [
    { run: 'r1', version: 'abc', started: '2026-11-13T02:00:00Z', seconds: 60, exit: 2, notes: 1, failures: [{ id: '3', error: `下载失败 ${home}` }], paused: '风控' },
    { run: 'r2', started: '2027-01-01T00:00:00Z', seconds: 1, exit: 0 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(home, 'dustoff.conf'), `DUST_NOTES=${join(home, 'notes')}\nDUST_TEXT=${join(home, 'text')}\nDUST_DEMO_HOME=${demo}\nDUST_DEMO_URL=https://example.test/demo/\nDUST_LLM_KEY=fixture-token\nDUST_LLM_BASE=http://127.0.0.1:8317/v1/chat/completions\n`);
  // 知识库：每篇都定好大类；概念「只在3」只有没选的笔记讲到。
  const kb = createKnowledge(home);
  kb.syncDocs();
  const raw = new DatabaseSync(kb.file);
  raw.exec("PRAGMA foreign_keys=ON; UPDATE docs SET domain='视频创作', extracted_hash=content_hash, classified_hash=content_hash, theme_checked=1;");
  raw.exec("INSERT INTO concepts(id,name,type,created_at) VALUES(1,'节拍网格','方法',1),(2,'只在3','产品',1); INSERT INTO mentions VALUES(1,'1','主题'),(2,'3','主题'); INSERT INTO merges(a_norm,b_norm,pair,created_at) VALUES('a','b','a|b',1);");
  const hashes = new Map(raw.prepare('SELECT item, content_hash FROM docs').all().map(r => [r.item, r.content_hash]));
  const theme = (id, name, items) => {
    raw.prepare('INSERT INTO themes(id,domain,name,norm,summary,created_at) VALUES(?,?,?,?,?,1)').run(id, '视频创作', name, name, `${name}说明`);
    for (const i of items) raw.prepare('INSERT INTO doc_themes VALUES(?,?)').run(id, i);
    const body = { intro: name, sections: [{ title: '', points: items.map((_, n) => ({ text: '要点', refs: [n + 1] })) }], disputes: [], stale: [], order: [], skip: [] };
    raw.prepare('INSERT INTO pages(theme_id,body,items,source_hash,prompt_hash,built_at,complete) VALUES(?,?,?,?,?,1,1)').run(id, JSON.stringify(body), JSON.stringify(items), sha(items.map(i => `${i}:${hashes.get(i)}`).sort().join('\n')), PAGE_HASH);
  };
  theme(1, '主题A', ['1', '2', '3']); theme(2, '主题B', ['1', '2', '7']); theme(3, '主题C', ['1', '2', '3', '7']);
  raw.close(); kb.close();
  const lib = createLibrary(home);
  for (const id of ['1', '2', '7', '4', '5', 'x6']) lib.setDemoPick(id, true);
  lib.setRead('1', true);
  lib.close();
  return { home, demo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const reply = data => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
// 只会被要求写综述：每篇笔记各一条要点。
const pageModel = calls => async (url, init) => {
  const user = JSON.parse(init.body).messages[1].content, n = user.match(/=== 笔记 \d+ ===/g).length; calls.push(n);
  return reply({ 是什么: '重写的综述', 分节: [{ 标题: '要点', 要点: Array.from({ length: n }, (_, i) => ({ 内容: `第 ${i + 1} 篇`, 出处: [i + 1] })) }], 分歧: [], 可能过期: [], 阅读顺序: [], 可跳过: [] });
};
const quiet = () => {};

test('演示数据：只复制选中的作品和文件，路径改到演示目录，扫描状态和运行记录去掉账号与明细', async () => {
  const f = fixture();
  try {
    const calls = [], info = await buildDemo({ home: f.home, fetchImpl: pageModel(calls), now: () => SNAPSHOT, onLog: quiet });
    assert.equal(info.snapshot_at, SNAPSHOT);
    assert.deepEqual(info.counts, { items: 6, notes: 4, videos: 0, galleries: 1, posts: 1, review: 1 });
    assert.ok(!existsSync(f.demo + '.next') && !existsSync(f.demo + '.old'));
    const db = new DatabaseSync(join(f.demo, 'index.sqlite'), { readOnly: true });
    const rows = new Map(db.prepare('SELECT * FROM items').all().map(r => [r.id, r]));
    assert.deepEqual([...rows.keys()].sort(), ['1', '2', '4', '5', '7', 'x6']);
    assert.equal(rows.get('1').note_path, join(f.demo, 'notes', '1.md'));
    assert.equal(rows.get('4').media_path, join(f.demo, 'saved-media', '4', 'images', 'gallery.json'));
    assert.equal(rows.get('5').media_path, join(f.demo, 'saved-media', '.review', '5', 'video.mp4'));
    assert.equal(rows.get('1').media_path, join(f.demo, 'media', '1', 'video.mp4'));   // 已清理的视频不留正式数据的位置
    assert.equal(rows.get('1').media_deleted, 1);
    assert.equal(rows.get('1').last_error, null);
    for (const r of rows.values()) for (const col of ['note_path', 'text_path', 'media_path']) assert.ok(!String(r[col] ?? '').includes(f.home), col);
    assert.ok(existsSync(join(f.demo, 'saved-media', '4', 'images', '001.jpg')) && existsSync(join(f.demo, 'text', '1.words.json')));
    assert.ok(!existsSync(join(f.demo, 'notes', '3.md')));
    assert.equal(statSync(join(f.demo, 'notes', '1.md')).ino, statSync(join(f.home, 'notes', '1.md')).ino);   // 同一磁盘用硬链接
    assert.deepEqual(db.prepare('SELECT id FROM daily_queue').all().map(r => r.id), ['5']);
    assert.equal(db.prepare('SELECT count(*) n FROM daily_usage').get().n, 0);
    const state = Object.fromEntries(db.prepare('SELECT name,value FROM daily_state').all().map(r => [r.name, JSON.parse(r.value)]));
    assert.deepEqual(state, { baseline: { created_at: 1, scanned_at: 2 }, 'baseline:x': { version: 1, scanned_at: 3, complete: true } });
    db.close();
    const history = readFileSync(join(f.demo, 'runs', 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(history, [{ run: 'r1', version: 'abc', started: '2026-11-13T02:00:00Z', seconds: 60, exit: 2, notes: 1 }]);   // 快照之后的不带，失败明细和暂停原因不带
    // 已读、素材、令牌不复制
    assert.ok(!existsSync(join(f.demo, 'library.sqlite')) && !existsSync(join(f.demo, 'dustoff.conf')));
    // 知识库：没选的笔记和只属于它的概念删掉；综述出处全在选中笔记里的保留，带出没选笔记的删掉，够 3 篇的按选中的重写。
    const kb = new DatabaseSync(join(f.demo, 'knowledge.sqlite'), { readOnly: true });
    assert.deepEqual(kb.prepare('SELECT item FROM docs ORDER BY item').all().map(r => r.item), ['1', '2', '7', 'x6']);
    assert.deepEqual(kb.prepare('SELECT name FROM concepts').all().map(r => r.name), ['节拍网格']);
    assert.equal(kb.prepare('SELECT count(*) n FROM merges').get().n, 0);
    const pages = Object.fromEntries(kb.prepare('SELECT t.name, p.items FROM pages p JOIN themes t ON t.id=p.theme_id').all().map(r => [r.name, JSON.parse(r.items).sort()]));
    assert.deepEqual(pages, { 主题B: ['1', '2', '7'], 主题C: ['1', '2', '7'] });
    assert.deepEqual(calls, [3]);
    assert.ok(kb.prepare('SELECT path FROM docs').all().every(r => r.path.startsWith(join(f.demo, 'notes'))));
    assert.ok(kb.prepare("SELECT count(*) n FROM chunk_sources WHERE key='3'").get().n === 0);
    kb.close();
    assert.deepEqual(info.pages, { kept: 1, reused: 0, written: 1, failed: 0, skipped: null });

    // 再更新一次：主题 C 的笔记没变，沿用上一版，不再调模型。
    const again = await buildDemo({ home: f.home, fetchImpl: async () => { throw new Error('不该调模型'); }, now: () => SNAPSHOT + 1000, onLog: quiet });
    assert.deepEqual(again.pages, { kept: 1, reused: 1, written: 0, failed: 0, skipped: null });
    assert.notEqual(again.build, info.build);
  } finally { f.cleanup(); }
});

test('演示数据：没设置目录、没选作品、目录和正式数据重叠时都不生成', async () => {
  const f = fixture();
  try {
    await assert.rejects(buildDemo({ home: f.home, target: f.home, onLog: quiet }), /必须是独立的绝对路径|不能和正式数据互相包含/);
    await assert.rejects(buildDemo({ home: f.home, cfg: () => '', onLog: quiet }), /DUST_DEMO_HOME/);
    const lib = createLibrary(f.home); for (const id of lib.demoPicks()) lib.setDemoPick(id, false); lib.close();
    await assert.rejects(buildDemo({ home: f.home, onLog: quiet }), /还没有选进演示站/);
    assert.ok(!existsSync(f.demo) && !existsSync(f.demo + '.next'));
  } finally { f.cleanup(); }
});

const serve = async options => {
  const app = createConsole({ scheduler: { status: () => ({ loaded: false }), start() { throw new Error('不该启动定时'); } }, ...options }), url = await app.listen(0);
  const html = await (await fetch(url)).text(), token = html.match(/name="dustoff-token" content="([^"]+)"/)[1];
  const get = async path => { const r = await fetch(url + '/api/' + path); return { status: r.status, body: await r.json() }; };
  const post = async (path, data) => { const r = await fetch(url + '/api/' + path, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-Dustoff-Token': token }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  return { url, html, get, post, close: () => new Promise(r => app.server.close(r)) };
};

test('演示站：不要密码、只能看；「现在」固定在快照那天；不给账号、成本、日志和服务器路径', async () => {
  const f = fixture();
  await buildDemo({ home: f.home, fetchImpl: pageModel([]), now: () => SNAPSHOT, onLog: quiet });
  const s = await serve({ home: f.demo, guest: true, publicUrl: '' });
  try {
    assert.match(s.html, /name="dustoff-guest" content="1"/);
    assert.match(s.html, new RegExp(`name="dustoff-now" content="${SNAPSHOT}"`));
    const o = (await s.get('overview')).body;
    assert.equal(o.day, '2026-11-14');
    assert.equal(o.total, 6); assert.equal(o.review, 1);
    assert.equal(o.paths, null); assert.equal(o.x.username, null); assert.equal(o.scheduler.loaded, false); assert.equal(o.demo.snapshot_at, SNAPSHOT);
    assert.ok(!JSON.stringify(o).includes(f.demo));
    const item = (await s.get('item?id=1')).body;
    assert.equal(item.note_path, '/notes/1.md');
    assert.ok(!JSON.stringify((await s.get('document?id=1&kind=note')).body).includes(f.demo));
    assert.equal((await s.get('item?id=3')).status, 404);
    assert.ok((await s.get('notes-index')).body.items.every(n => n.read_at === null));   // 作者自己的已读不带过来
    assert.deepEqual((await s.get('library')).body, { topics: [], materials: [], unsorted: 0 });
    assert.deepEqual((await s.get('summaries?ids=1,3')).body.items.map(i => i.id), ['1']);
    assert.equal((await s.get('search?q=节拍')).body.ready, true);
    for (const path of ['tokens', 'settings', 'costs', 'runs', 'log?kind=console', 'session', 'demo']) assert.equal((await s.get(path)).status, 404, path);
    for (const path of ['read', 'purpose', 'run', 'settings', 'material', 'demo-pick', 'demo-build', 'token']) assert.equal((await s.post(path, { id: '1', read: true, purpose: 'note' })).status, 403, path);
    assert.equal((await fetch(s.url + '/api/v1/topics')).status, 404);
    // 演示数据换过之后，不用重启就读到新的。
    const lib = createLibrary(f.home); lib.setDemoPick('5', false); lib.close();
    await buildDemo({ home: f.home, fetchImpl: pageModel([]), now: () => SNAPSHOT + 86400000, onLog: quiet });
    const next = (await s.get('overview')).body;
    assert.equal(next.total, 5); assert.equal(next.day, '2026-11-15');
  } finally { await s.close(); f.cleanup(); }
});

test('正式控制台：在收藏里标记放进演示站，筛出已选的，更新演示站按现有任务方式运行', async () => {
  const f = fixture();
  const spawned = [];
  const spawnProcess = (cmd, args) => { spawned.push(args); const child = new EventEmitter(); child.pid = 1; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.send = () => {}; setTimeout(() => child.emit('close', 0), 10); return child; };
  const s = await serve({ home: f.home, spawnProcess });
  try {
    let d = (await s.get('demo')).body;
    assert.equal(d.configured, true); assert.equal(d.url, 'https://example.test/demo/');
    assert.deepEqual([...d.picks].sort(), ['1', '2', '4', '5', '7', 'x6']);
    assert.deepEqual((await s.post('demo-pick', { id: '3', picked: true })).body, { item: '3', picked: true });
    assert.equal((await s.post('demo-pick', { id: '999', picked: true })).status, 404);
    assert.equal((await s.get('items?demo=1&size=50')).body.total, 7);
    await s.post('demo-pick', { id: '3', picked: false });
    assert.equal((await s.get('items?demo=1&size=50')).body.total, 6);
    assert.equal((await s.post('demo-build', {})).status, 200);
    assert.match(spawned[0][0], /scripts\/make-demo\.mjs$/);
  } finally { await s.close(); f.cleanup(); }
});
