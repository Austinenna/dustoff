import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createKnowledge } from '../scripts/knowledge-store.mjs';
import { EXTRACT_HASH, cleanExtraction, cleanMerge, noteBody, normName } from '../scripts/knowledge-extract.mjs';
import { extractPending, mergePass } from '../knowledge.mjs';
import { PauseError } from '../scripts/policy.mjs';

// 虚构笔记：三篇整理过的笔记（两篇讲同一个工具，写法不同），一条只存了原帖的 X 书签。
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dustoff-knowledge-')));
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', `import {db} from ${JSON.stringify(new URL('../scripts/ledger.mjs', import.meta.url).href)};db().close();`], { env: { ...process.env, DUST_HOME: home }, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(home, 'notes'));
  const note = (file, title, body, tail = '\n\n---\n## 完整转写稿\n\n口语原稿不该进正文。\n\n---\n[完整转写稿](#完整转写稿)\n') =>
    writeFileSync(join(home, 'notes', file), `---\n标题: "${title}"\n分类: "旧分类"\n---\n# 核心观点\n\n${body}${tail}`);
  note('1.md', '剪刀手入门', '剪刀手是一个命令行剪辑工具，由木工坊开发，适合批量处理。');
  note('2.md', '剪刀手进阶', '用 Scissor Hand 把剪辑写成脚本，再配合节拍网格对齐音乐。');
  note('3.md', '节拍网格', '节拍网格是先分析音乐找出每一拍的位置，再让画面变化落在拍子上。');
  note('x9.md', '发现一个项目', '剪刀手发布了 2.0 版本，值得一看。', '\n\n---\n[原推文](https://x.com/i/status/9)\n');
  const db = new DatabaseSync(join(home, 'index.sqlite'));
  const insert = db.prepare("INSERT INTO items(id,platform,title,author,media_type,status,first_seen,last_seen,updated_at,note_path,prompt_hash,collected_at,decay) VALUES(?,?,?,'测试作者',?,'extracted',1,1,1,?,?,?,'slow')");
  insert.run('1', 'douyin', '原标题一', 'video', join(home, 'notes', '1.md'), 'aaaa', 100);
  insert.run('2', 'douyin', '原标题二', 'video', join(home, 'notes', '2.md'), 'aaaa', 200);
  insert.run('3', 'douyin', '原标题三', 'video', join(home, 'notes', '3.md'), 'aaaa', 300);
  insert.run('x9', 'x', '发现一个项目', 'post', join(home, 'notes', 'x9.md'), null, 400);
  db.close();
  return { home, kb: createKnowledge(home), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const config = { base: 'http://127.0.0.1:8317/v1/chat/completions', key: 'fixture-token', model: 'fixture-model', effort: 'high', maxTokens: 1000, timeoutMs: 5000 };
const reply = data => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
const concept = (名称, 角色 = '主题', 类型 = '产品') => ({ 名称, 类型, 角色, 说明: `${名称}的说明` });
// 按标题给出固定的抽取结果；同时记下每次请求，供断言用。
function fakeModel(calls = []) {
  const answers = {
    剪刀手入门: { 大类: '效率工具', 概念: [concept('剪刀手'), concept('木工坊', '提到', '机构')], 关系: [{ 从: '剪刀手', 到: '木工坊', 类型: '出自' }] },
    剪刀手进阶: { 大类: '效率工具', 概念: [concept('Scissor Hand'), concept('节拍网格', '提到', '方法')], 关系: [{ 从: 'Scissor Hand', 到: '节拍网格', 类型: '用于' }] },
    节拍网格: { 大类: 'AI 视频与创作', 概念: [concept('节拍网格', '主题', '方法')], 关系: [] },
    发现一个项目: { 大类: '效率工具', 概念: [concept('剪 刀 手', '提到')], 关系: [] },
  };
  return async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body });
    const user = body.messages[1].content;
    if (body.messages[0].content.includes('找出指同一个东西的概念')) {
      const rows = user.split('\n').slice(2).map(line => line.split('｜')), id = name => Number(rows.find(r => r[1] === name)?.[0]);
      return reply(id('Scissor Hand') ? { 合并: [{ 保留: id('剪刀手'), 并入: [id('Scissor Hand')] }], 不确定: [{ 成员: [id('剪刀手'), id('木工坊')], 原因: '可能是同一个' }] } : { 合并: [], 不确定: [] });
    }
    return reply(answers[user.match(/^标题：(.+)$/m)[1]]);
  };
}
const quiet = { config, retryMs: 0, onLog() {} };

test('概念名归一：全半角、大小写、空格和连接符不同算同一个名字，版本号保留', () => {
  assert.equal(normName('Claude Code'), normName('claude-code'));
  assert.equal(normName('Ｃｌａｕｄｅ　Code'), 'claudecode');
  assert.notEqual(normName('Opus 4.5'), normName('Opus 5.5'));
  assert.equal(normName(null), '');
});

test('取笔记正文：去掉元信息、转写稿和原帖，只存原帖的整篇都算正文', () => {
  const head = '---\n标题: "t"\n---\n';
  assert.equal(noteBody(`${head}# 核心\n\n正文。\n\n---\n## 完整转写稿\n\n口语。\n\n---\n[完整转写稿](#完整转写稿)\n`), '# 核心\n\n正文。');
  assert.equal(noteBody(`${head}# 核心\n\n正文。\n\n---\n## 原帖\n\n原文。\n`), '# 核心\n\n正文。');
  assert.equal(noteBody(`${head}# 帖子\n\n只有原帖。\n\n- [图 1](https://x.invalid/a.png) · 本地：\`/home/u/a.png\`\n`), '# 帖子\n\n只有原帖。\n\n- [图 1](https://x.invalid/a.png)');
});

test('抽取结果校验：大类必须在固定列表里，坏条目丢掉，主题最多 3 个', () => {
  assert.throws(() => cleanExtraction({ 大类: '其他', 概念: [] }), /不在固定列表里/);
  const out = cleanExtraction({ 大类: '游戏', 概念: [concept('甲'), concept('乙'), concept('丙'), concept('丁'), concept('甲'), { 名称: '坏类型', 类型: '别的' }, concept('')],
    关系: [{ 从: '甲', 到: '乙', 类型: '用于' }, { 从: '甲', 到: '乙', 类型: '用于' }, { 从: '甲', 到: '不存在', 类型: '用于' }, { 从: '甲', 到: '乙', 类型: '喜欢' }, { 从: '甲', 到: '甲', 类型: '属于' }] });
  assert.deepEqual(out.concepts.map(c => [c.name, c.role]), [['甲', '主题'], ['乙', '主题'], ['丙', '主题'], ['丁', '提到']]);
  assert.deepEqual(out.relations, [{ from: '甲', to: '乙', type: '用于' }]);
});

test('归并结果校验：编号必须在这一批里，不确定里被并掉的换成保留的那个', () => {
  const out = cleanMerge({ 合并: [{ 保留: 1, 并入: [2, 9, 1] }, { 保留: 2, 并入: [3] }], 不确定: [{ 成员: [2, 4], 原因: 'r' }, { 成员: [1, 2] }] }, [1, 2, 3, 4]);
  assert.deepEqual(out.merges, [{ keep: 1, drop: [2] }]);
  assert.deepEqual(out.unsure, [{ a: 1, b: 4, reason: 'r' }]);
});

test('抽取入库：同一个东西的不同写法落到同一个概念，请求显式带思考档位', async () => {
  const f = fixture(), calls = [];
  try {
    assert.deepEqual(f.kb.syncDocs(), { total: 4, added: 4, changed: 0, removed: 0 });
    assert.equal(f.kb.doc('1').title, '剪刀手入门');
    assert.equal(f.kb.doc('x9').kind, 'post');
    const docs = f.kb.pendingDocs({ promptHash: EXTRACT_HASH });
    assert.deepEqual(docs.map(d => d.item), ['1', '2', '3', 'x9']);
    const r = await extractPending(f.kb, docs, { ...quiet, fetchImpl: fakeModel(calls), concurrency: 1 });
    assert.deepEqual([r.done, r.failed, r.input, r.output], [4, 0, 40, 20]);
    assert.equal(calls[0].body.reasoning_effort, 'high');
    assert.equal(calls[0].body.model, 'fixture-model');
    assert.doesNotMatch(calls[0].body.messages[1].content, /口语原稿/);
    // 第二篇开始，已有概念作为参照传给模型。
    assert.match(calls[1].body.messages[1].content, /已有概念[^\n]*\n剪刀手/);
    const byName = Object.fromEntries(f.kb.concepts().map(c => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['Scissor Hand', '剪刀手', '木工坊', '节拍网格']);
    assert.deepEqual([byName.剪刀手.notes, byName.剪刀手.topics, byName.剪刀手.domain], [2, 1, '效率工具']);   // 「剪 刀 手」对上了「剪刀手」
    assert.deepEqual([byName.节拍网格.notes, byName.节拍网格.topics], [2, 1]);
    assert.equal(f.kb.doc('3').domain, 'AI 视频与创作');
    assert.equal(f.kb.pendingDocs({ promptHash: EXTRACT_HASH }).length, 0);
    assert.equal(f.kb.pendingDocs({ promptHash: 'newprompt', stale: true }).length, 4);
    const s = f.kb.stats();
    assert.deepEqual([s.docs.extracted, s.concepts.total, s.concepts.single, s.isolated], [4, 4, 2, 0]);
  } finally { f.kb.close(); f.cleanup(); }
});

test('归并：模型认定的直接合并，拿不准的等确认；问过的不再问，重建后合并会重放', async () => {
  const f = fixture(), calls = [];
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    const m = await mergePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) });
    assert.deepEqual([m.merged, m.suggested, m.failed], [1, 1, 0]);
    assert.equal(calls.length, 1);   // 只有「效率工具」有多个概念；另一个大类只有一个概念，不用问
    let names = f.kb.concepts().map(c => c.name).sort();
    assert.deepEqual(names, ['剪刀手', '木工坊', '节拍网格']);
    const tool = f.kb.concepts().find(c => c.name === '剪刀手');
    assert.deepEqual([tool.notes, tool.topics], [3, 2]);
    assert.deepEqual(f.kb.conceptNotes(tool.id).map(n => n.item).sort(), ['1', '2', 'x9']);
    // 原来挂在被并概念上的关系转到了保留的概念上。
    const grid = f.kb.concepts().find(c => c.name === '节拍网格');
    assert.ok(f.kb.relations().some(r => r.from_id === tool.id && r.to_id === grid.id && r.type === '用于'));
    // 全部判断过了，再跑一遍不调用模型。
    calls.length = 0;
    assert.deepEqual((await mergePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) })).merged, 0);
    assert.equal(calls.length, 0);
    // 待确认建议：保持分开后不再出现，也不会被重新记一遍。
    const [pending] = f.kb.pendingMerges();
    assert.deepEqual([pending.a_name, pending.b_name], ['剪刀手', '木工坊']);
    assert.equal(f.kb.decide(pending.id, false), true);
    assert.equal(f.kb.pendingMerges().length, 0);
    assert.equal(f.kb.suggest(pending.b_id, pending.a_id), false);
    // 重建：抽取结果清空重抽，以前的合并照着重放。
    f.kb.reset();
    assert.equal(f.kb.concepts().length, 0);
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    assert.equal(f.kb.concepts().length, 4);
    assert.equal(f.kb.replayMerges(), 1);
    assert.deepEqual(f.kb.concepts().map(c => c.name).sort(), names);
    // 合并后，旧写法再出现也指向保留的概念。
    f.kb.saveExtraction('3', cleanExtraction({ 大类: '效率工具', 概念: [concept('scissor-hand')], 关系: [] }));
    assert.equal(f.kb.concepts().find(c => c.name === '剪刀手').notes, 4);
  } finally { f.kb.close(); f.cleanup(); }
});

test('笔记改了要重抽，笔记没了连同只属于它的概念一起清掉', async () => {
  const f = fixture();
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    writeFileSync(join(f.home, 'notes', '3.md'), '---\n标题: "节拍网格"\n---\n# 核心观点\n\n改过的正文，比原来多了一段内容。\n');
    rmSync(join(f.home, 'notes', '1.md'));
    assert.deepEqual(f.kb.syncDocs(), { total: 3, added: 0, changed: 1, removed: 1 });
    assert.deepEqual(f.kb.pendingDocs({}).map(d => d.item), ['3']);
    assert.deepEqual(f.kb.concepts().map(c => c.name).sort(), ['Scissor Hand', '剪刀手', '节拍网格']);   // 木工坊只有第 1 篇讲到
  } finally { f.kb.close(); f.cleanup(); }
});

test('失败处理：参数错误不重试，连续失败停止，预算用完立即停止', async () => {
  const f = fixture();
  try {
    f.kb.syncDocs();
    const status = (code, error) => async () => new Response(JSON.stringify({ error }), { status: code });
    let r = await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: status(400, { code: '1301', message: '内容不合规' }), concurrency: 1, maxFails: 2 });
    assert.deepEqual([r.done, r.failed], [0, 2]);
    assert.match(r.stopped, /连续 2 篇失败/);
    assert.equal(f.kb.doc('1').attempts, 3);                    // 永久失败，不再自动重试
    assert.deepEqual(f.kb.pendingDocs({}).map(d => d.item), ['3', 'x9']);
    assert.equal(f.kb.pendingDocs({ retryFailed: true }).length, 4);
    let n = 0;
    r = await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: async () => { n++; return new Response('{}', { status: 500 }); }, concurrency: 1, maxFails: 9 });
    assert.equal(n, 6);                                          // 每篇本轮内试 3 次
    assert.deepEqual([f.kb.doc('3').attempts, f.kb.doc('x9').attempts], [1, 1]);
    r = await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: status(402, { message: '本月预算已用完' }), concurrency: 1 });
    assert.match(r.stopped, /预算已用完/);
    assert.equal(f.kb.doc('3').attempts, 1);                     // 预算用完不算这篇的失败
    await assert.rejects(mergePass({ mergeBatches: () => [{ domain: '游戏', concepts: [{ id: 1, name: '甲', type: '产品' }, { id: 2, name: '乙', type: '产品' }] }] }, { ...quiet, fetchImpl: status(402, {}) }), PauseError);
  } finally { f.kb.close(); f.cleanup(); }
});
