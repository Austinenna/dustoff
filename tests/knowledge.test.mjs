import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createKnowledge } from '../scripts/knowledge-store.mjs';
import { CLASSIFY_HASH, EXTRACT_HASH, cleanClassification, cleanExtraction, cleanMerge, cleanPage, cleanThemes, noteBody, notePublished, normName } from '../scripts/knowledge-extract.mjs';
import { extractPending, mergePass, pagePass, themePass } from '../knowledge.mjs';
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
// 按标题给出固定的分类和抽取结果；同时记下每次请求，供断言用。
function fakeModel(calls = [], domains = { 节拍网格: '视频创作' }) {
  const answers = {
    剪刀手入门: { 概念: [concept('剪刀手'), concept('木工坊', '提到', '机构')], 关系: [{ 从: '剪刀手', 到: '木工坊', 类型: '出自' }] },
    剪刀手进阶: { 概念: [concept('Scissor Hand'), concept('节拍网格', '提到', '方法')], 关系: [{ 从: 'Scissor Hand', 到: '节拍网格', 类型: '用于' }] },
    节拍网格: { 概念: [concept('节拍网格', '主题', '方法')], 关系: [] },
    发现一个项目: { 概念: [concept('剪 刀 手', '提到')], 关系: [] },
  };
  return async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body });
    const user = body.messages[1].content;
    if (body.messages[0].content.includes('给个人收藏笔记归类')) return reply({ 大类: domains[user.match(/^标题：(.+)$/m)[1]] || '软件与开发工具', 理由: '按内容归类' });
    if (body.messages[0].content.includes('归纳出这个大类里反复出现的')) {
      // 把标题里带「剪刀手」或正文讲剪刀手的归成一个主题；只有一篇的不归。
      const rows = user.split('\n').filter(line => /^\d+｜/.test(line)), hit = rows.filter(r => /剪刀手|Scissor/.test(r)).map(r => Number(r.split('｜')[0]));
      return reply({ 主题: hit.length >= 2 ? [{ 名称: '剪刀手用法', 说明: '命令行剪辑工具剪刀手的入门和进阶', 笔记: hit }] : [] });
    }
    if (body.messages[0].content.includes('合写成一页综述')) {
      const n = user.match(/=== 笔记 \d+ ===/g).length;
      return reply({ 是什么: '剪刀手是命令行剪辑工具。', 分节: [{ 标题: '用法', 要点: [{ 内容: '适合批量处理', 出处: [1] }, { 内容: '可以把剪辑写成脚本', 出处: [2, n] }, { 内容: '没有出处的要点', 出处: [] }] }],
        分歧: [], 可能过期: [{ 内容: '笔记 3 说的 2.0 版可能已有新版', 出处: [n] }], 阅读顺序: [{ 笔记: 1, 理由: '入门' }], 可跳过: [{ 笔记: 1, 理由: '重复列出' }, { 笔记: n, 理由: '只是一句话' }] });
    }
    if (body.messages[0].content.includes('找出指同一个东西的概念')) {
      const rows = user.split('\n').slice(2).map(line => line.split('｜')), id = name => Number(rows.find(r => r[1] === name)?.[0]);
      return reply(id('Scissor Hand') ? { 合并: [{ 保留: id('剪刀手'), 并入: [id('Scissor Hand')] }], 不确定: [{ 成员: [id('剪刀手'), id('木工坊')], 原因: '可能是同一个' }] } : { 合并: [], 不确定: [] });
    }
    return reply(answers[user.match(/^标题：(.+)$/m)[1]]);
  };
}
const quiet = { config, retryMs: 0, onLog(m) { if (process.env.KB_DEBUG) console.error(m); } };

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

test('抽取结果校验：坏条目丢掉，主题最多 2 个、关系最多 3 条', () => {
  const out = cleanExtraction({ 概念: [concept('甲'), concept('乙'), concept('丙'), concept('丁'), concept('甲'), { 名称: '坏类型', 类型: '别的' }, concept('')],
    关系: [{ 从: '甲', 到: '乙', 类型: '用于' }, { 从: '甲', 到: '乙', 类型: '用于' }, { 从: '甲', 到: '不存在', 类型: '用于' }, { 从: '甲', 到: '乙', 类型: '喜欢' }, { 从: '甲', 到: '甲', 类型: '属于' }] });
  assert.deepEqual(out.concepts.map(c => [c.name, c.role]), [['甲', '主题'], ['乙', '主题'], ['丙', '提到'], ['丁', '提到']]);
  assert.deepEqual(out.relations, [{ from: '甲', to: '乙', type: '用于' }]);
  assert.equal(cleanExtraction({ 概念: [concept('没有类型', '主题', '话题')], 关系: [] }).concepts.length, 0);   // 概念只收有名字的东西
  const many = cleanExtraction({ 概念: ['甲', '乙', '丙', '丁'].map(n => concept(n)), 关系: [['甲', '乙'], ['甲', '丙'], ['甲', '丁'], ['乙', '丙']].map(([从, 到]) => ({ 从, 到, 类型: '用于' })) });
  assert.equal(many.relations.length, 3);
});

test('归并结果校验：编号必须在这一批里，不确定里被并掉的换成保留的那个', () => {
  const out = cleanMerge({ 合并: [{ 保留: 1, 并入: [2, 9, 1] }, { 保留: 2, 并入: [3] }], 不确定: [{ 成员: [2, 4], 原因: 'r' }, { 成员: [1, 2] }] }, [1, 2, 3, 4]);
  assert.deepEqual(out.merges, [{ keep: 1, drop: [2] }]);
  assert.deepEqual(out.unsure, [{ a: 1, b: 4, reason: 'r' }]);
});

test('分类和抽取入库：每篇先定大类再抽概念，同一个东西的不同写法落到同一个概念，请求显式带思考档位', async () => {
  const f = fixture(), calls = [];
  try {
    assert.deepEqual(f.kb.syncDocs(), { total: 4, added: 4, changed: 0, removed: 0 });
    assert.equal(f.kb.doc('1').title, '剪刀手入门');
    assert.equal(f.kb.doc('x9').kind, 'post');
    const docs = f.kb.pendingDocs({ promptHash: EXTRACT_HASH, classifyHash: CLASSIFY_HASH });
    assert.deepEqual(docs.map(d => [d.item, d.need_classify, d.need_extract]), [['1', 1, 1], ['2', 1, 1], ['3', 1, 1], ['x9', 1, 1]]);
    const r = await extractPending(f.kb, docs, { ...quiet, fetchImpl: fakeModel(calls), concurrency: 1 });
    assert.deepEqual([r.done, r.failed, r.input, r.output], [4, 0, 80, 40]);
    assert.equal(calls.length, 8);
    assert.match(calls[0].body.messages[0].content, /给个人收藏笔记归类[\s\S]*- 未分类：/);
    assert.doesNotMatch(calls[1].body.messages[0].content, /大类/);   // 抽概念的提示词里不再提大类
    assert.equal(calls[0].body.reasoning_effort, 'high');
    assert.equal(calls[0].body.model, 'fixture-model');
    assert.doesNotMatch(calls[0].body.messages[1].content, /口语原稿/);
    // 第二篇开始，已有概念作为参照传给模型。
    assert.match(calls[3].body.messages[1].content, /已有概念[^\n]*\n剪刀手/);
    const byName = Object.fromEntries(f.kb.concepts().map(c => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['Scissor Hand', '剪刀手', '木工坊', '节拍网格']);
    assert.deepEqual([byName.剪刀手.notes, byName.剪刀手.topics, byName.剪刀手.domain], [2, 1, '软件与开发工具']);   // 「剪 刀 手」对上了「剪刀手」
    assert.deepEqual([byName.节拍网格.notes, byName.节拍网格.topics], [2, 1]);
    assert.deepEqual([f.kb.doc('3').domain, f.kb.doc('3').domain_note], ['视频创作', '按内容归类']);
    const hashes = { promptHash: EXTRACT_HASH, classifyHash: CLASSIFY_HASH };
    assert.equal(f.kb.pendingDocs(hashes).length, 0);
    assert.equal(f.kb.pendingDocs({ ...hashes, stale: true }).length, 0);
    assert.equal(f.kb.pendingDocs({ ...hashes, promptHash: 'newprompt', stale: true }).length, 4);
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
    assert.equal(calls.length, 1);   // 只有「软件与开发工具」有多个概念；另一个大类只有一个概念，不用问
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
    f.kb.saveExtraction('3', cleanExtraction({ 概念: [concept('scissor-hand')], 关系: [] }));
    assert.equal(f.kb.concepts().find(c => c.name === '剪刀手').notes, 4);
  } finally { f.kb.close(); f.cleanup(); }
});

test('主题归纳结果校验：至少 2 篇，一篇最多归 2 个主题，不能用大类名', () => {
  const out = cleanThemes({ 主题: [{ 名称: '甲', 说明: 's', 笔记: [1, 2, 2, 9] }, { 名称: '游戏攻略', 笔记: [1, 2] }, { 名称: '乙', 笔记: [1, 3] }, { 名称: '丙', 笔记: [1, 3] }, { 名称: '丁', 笔记: [4] }, { 名称: '甲', 笔记: [3, 4] }] }, 4, '游戏攻略');
  assert.deepEqual(out.map(t => [t.name, t.notes]), [['甲', [1, 2]], ['乙', [1, 3]]]);   // 丙：第 1 篇已经归了两个主题，只剩一篇，不成主题
});

test('主题：按大类归纳，名称没变的主题保留编号，大类里笔记有变动才重新归纳', async () => {
  const f = fixture(), calls = [];
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    const t = await themePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) });
    assert.deepEqual([t.domains, t.themes, t.failed], [2, 1, 0]);
    assert.equal(calls.length, 1);   // 「AI 视频与创作」只有一篇，不用问模型
    assert.match(calls[0].body.messages[1].content, /1｜剪刀手入门｜剪刀手是一个命令行剪辑工具[^｜]*｜★剪刀手、木工坊/);
    const [theme] = f.kb.themes();
    assert.deepEqual([theme.domain, theme.name, theme.notes], ['软件与开发工具', '剪刀手用法', 3]);
    assert.deepEqual(f.kb.themeNotes(theme.id).map(n => n.item).sort(), ['1', '2', 'x9']);
    assert.deepEqual(f.kb.looseNotes().map(n => n.item), ['3']);
    assert.deepEqual([f.kb.stats().themes.with_page, f.kb.stats().themes.covered, f.kb.stats().themes.loose], [1, 3, 1]);
    // 没有变动，再跑不调用模型。
    calls.length = 0;
    assert.equal((await themePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) })).domains, 0);
    // 删掉一篇后，所在大类重新归纳；主题名称没变，编号不变，已有主题会传给模型。
    rmSync(join(f.home, 'notes', 'x9.md'));
    f.kb.syncDocs();
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) });
    assert.match(calls[0].body.messages[1].content, /已有主题：\n- 剪刀手用法/);
    assert.deepEqual(f.kb.themes().map(x => [x.id, x.notes]), [[theme.id, 2]]);
    // 再删一篇，只剩一篇成不了主题，主题跟着消失。
    rmSync(join(f.home, 'notes', '2.md'));
    f.kb.syncDocs();
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) });
    assert.equal(f.kb.themes().length, 0);
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

test('只改了大类定义：只重新分类，不重抽概念；大类变了的笔记，原来和现在的大类都重新归纳主题', async () => {
  const f = fixture(), calls = [];
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel() });
    assert.equal(f.kb.themes()[0].notes, 3);
    const db = new DatabaseSync(f.kb.file); db.exec("UPDATE docs SET domain_hash='old'"); db.close();
    const docs = f.kb.pendingDocs({ promptHash: EXTRACT_HASH, classifyHash: CLASSIFY_HASH, stale: true });
    assert.deepEqual(docs.map(d => [d.item, d.need_classify, d.need_extract]), [['1', 1, 0], ['2', 1, 0], ['3', 1, 0], ['x9', 1, 0]]);
    const r = await extractPending(f.kb, docs, { ...quiet, fetchImpl: fakeModel(calls, { 节拍网格: '视频创作', 发现一个项目: 'AI行业动态' }), concurrency: 1 });
    assert.deepEqual([r.done, calls.length], [4, 4]);
    assert.equal(f.kb.concepts().length, 4);   // 概念没动
    assert.equal(f.kb.doc('x9').domain, 'AI行业动态');
    assert.deepEqual(f.kb.themeNotes(f.kb.themes()[0].id).map(n => n.item).sort(), ['1', '2']);   // 改了大类的那篇先从主题里拿掉
    assert.deepEqual(f.kb.themeBatches().map(b => b.domain).sort(), ['AI行业动态', '软件与开发工具']);
  } finally { f.kb.close(); f.cleanup(); }
});

test('未分类：模型可以选未分类并写原因，内容审核拒绝的也放进去，都不参加主题归纳', async () => {
  assert.throws(() => cleanClassification({ 大类: '其他', 理由: '' }), /不在固定列表里/);
  assert.deepEqual(cleanClassification({ 大类: '未分类', 理由: '讲公益故事，建议设「科技公益」' }), { domain: '未分类', domainNote: '讲公益故事，建议设「科技公益」' });
  const f = fixture();
  try {
    f.kb.syncDocs();
    const rejected = async () => new Response(JSON.stringify({ error: { code: '1301', message: '内容不合规' } }), { status: 400 });
    const r = await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: rejected, concurrency: 1, maxFails: 2 });
    assert.deepEqual([r.done, r.moderated, r.failed, r.stopped], [4, 4, 0, null]);   // 不算失败，不触发连续失败停止
    assert.deepEqual([f.kb.doc('1').domain, f.kb.doc('1').error], ['未分类', null]);
    assert.match(f.kb.doc('1').domain_note, /内容审核/);
    assert.equal(f.kb.pendingDocs({}).length, 0);
    assert.equal(f.kb.stats().unsorted.length, 4);
    assert.equal(f.kb.themeBatches().length, 0);
  } finally { f.kb.close(); f.cleanup(); }
});

test('失败处理：参数错误不重试，连续失败停止，预算用完立即停止', async () => {
  const f = fixture();
  try {
    f.kb.syncDocs();
    const status = (code, error) => async () => new Response(JSON.stringify({ error }), { status: code });
    let r = await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: status(400, { code: '1210', message: '参数有误' }), concurrency: 1, maxFails: 2 });
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
    await assert.rejects(mergePass({ mergeBatches: () => [{ domain: '游戏攻略', concepts: [{ id: 1, name: '甲', type: '产品' }, { id: 2, name: '乙', type: '产品' }] }] }, { ...quiet, fetchImpl: status(402, {}) }), PauseError);
  } finally { f.kb.close(); f.cleanup(); }
});

test('控制台目录：各大类和主题，每篇笔记的大类、主题和概念；索引没建过时不替它新建', async () => {
  const f = fixture();
  const { createConsole } = await import('../console.mjs');
  const app = createConsole({ home: f.home, scheduler: { status: () => ({ installed: false }), plan: () => null } });
  const url = await app.listen(0);
  try {
    assert.deepEqual(await (await fetch(url + '/api/knowledge')).json(), { ready: false });
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel() });
    const c = await (await fetch(url + '/api/knowledge')).json();
    assert.equal(c.ready, true);
    assert.deepEqual(c.domains.map(d => [d.name, d.notes]), [['视频创作', 1], ['软件与开发工具', 3]]);   // 按固定顺序，没有笔记的大类不列
    assert.deepEqual(c.themes.map(t => [t.domain, t.name, t.notes]), [['软件与开发工具', '剪刀手用法', 3]]);
    assert.deepEqual([c.docs['1'].domain, c.docs['1'].note, c.docs['1'].themes], ['软件与开发工具', '按内容归类', [c.themes[0].id]]);
    assert.deepEqual(c.docs['1'].concepts.map(x => [c.concepts[x.id].name, x.role]), [['剪刀手', '主题'], ['木工坊', '提到']]);
    assert.deepEqual(c.docs['3'].themes, []);
  } finally { await new Promise(r => app.server.close(r)); f.kb.close(); f.cleanup(); }
});

test('手工指定大类：重新分类和重建都不覆盖，两个大类重新归纳主题；取消后交回模型', async () => {
  const f = fixture();
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel() });
    assert.throws(() => f.kb.setDomain('1', '其他'), /不在固定列表里/);
    assert.throws(() => f.kb.setDomain('nope', '游戏攻略'), /还没进知识库索引/);
    assert.deepEqual(f.kb.setDomain('x9', '游戏攻略'), { item: 'x9', domain: '游戏攻略', manual: true });
    assert.deepEqual([f.kb.doc('x9').domain, f.kb.doc('x9').domain_note, f.kb.catalog().docs.x9.manual], ['游戏攻略', '手动指定', true]);
    assert.deepEqual(f.kb.themeBatches().map(b => b.domain).sort(), ['游戏攻略', '软件与开发工具']);
    const hashes = { promptHash: EXTRACT_HASH, classifyHash: 'new-definitions', stale: true };
    assert.deepEqual(f.kb.pendingDocs(hashes).map(d => d.item), ['1', '2', '3']);   // 手工指定的不再交给模型分类
    f.kb.reset();
    assert.equal(f.kb.doc('x9').domain, '游戏攻略');
    assert.deepEqual(f.kb.pendingDocs({}).find(d => d.item === 'x9').need_classify, 0);
    assert.deepEqual(f.kb.setDomain('x9', null), { item: 'x9', manual: false });
    assert.equal(f.kb.pendingDocs({}).find(d => d.item === 'x9').need_classify, 1);
  } finally { f.kb.close(); f.cleanup(); }
});

test('综述结果校验：没有出处的条目丢掉，一篇笔记不同时出现在阅读顺序和可跳过里，要点覆盖不到一半的笔记算没写好', () => {
  const out = cleanPage({ 是什么: '说明', 分节: [{ 标题: '甲', 要点: [{ 内容: '一', 出处: [1, 1, 9] }, { 内容: '二', 出处: ['2'] }] }, { 标题: '空', 要点: [] }],
    分歧: [{ 内容: '三', 出处: [2] }], 阅读顺序: [{ 笔记: 2, 理由: '全' }, { 笔记: 7 }], 可跳过: [{ 笔记: 2, 理由: '重复' }, { 笔记: 1, 理由: '被 2 覆盖' }] }, 2);
  assert.deepEqual(out.sections, [{ title: '甲', points: [{ text: '一', refs: [1] }] }]);
  assert.deepEqual([out.disputes, out.stale, out.order, out.skip], [[{ text: '三', refs: [2] }], [], [{ note: 2, why: '全' }], [{ note: 1, why: '被 2 覆盖' }]]);
  assert.throws(() => cleanPage({ 分节: [{ 要点: [{ 内容: '一', 出处: [] }] }] }, 3), /没有带出处的要点/);
  assert.throws(() => cleanPage({ 分节: [{ 要点: [{ 内容: '一', 出处: [1] }] }] }, 3), /不到一半/);
  assert.equal(notePublished('---\n标题: "x"\n发布日期: 2026-01-09\n---\n正文'), '2026-01-09');
  assert.equal(notePublished('正文里写 发布日期: 2026-01-09'), '');
});

test('综述页：3 篇以上的主题才写，笔记没变不重写，变了整页重写并记下变化；写不出来的同一批笔记不再试', async () => {
  const f = fixture(), calls = [];
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel() });
    const [theme] = f.kb.themes();
    assert.equal(theme.page_hash, null);
    // 内容审核拒绝：记下来，这批笔记不变就不再试。
    const blocked = async () => new Response(JSON.stringify({ error: { code: '1301', message: '敏感内容' } }), { status: 400 });
    assert.deepEqual([(await pagePass(f.kb, { ...quiet, fetchImpl: blocked })).failed, f.kb.pageBatches({}).length], [1, 0]);
    assert.match(f.kb.pageFailures()[0].error, /内容审核拒绝/);
    assert.equal(f.kb.page(theme.id), null);
    const p = await pagePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls), retryFailed: true, today: '2026-11-11' });
    assert.deepEqual([p.pages, p.failed, calls.length], [1, 0, 1]);
    assert.match(calls[0].body.messages[1].content, /主题：剪刀手用法[\s\S]*今天的日期：2026-11-11[\s\S]*=== 笔记 1 ===\n标题：剪刀手入门\n作者：测试作者/);
    assert.doesNotMatch(calls[0].body.messages[1].content, /口语原稿/);   // 只给提炼正文，不给转写稿
    const page = f.kb.page(theme.id);
    assert.deepEqual(page.notes.map(n => n.item), ['1', '2', 'x9']);   // 编号按收藏时间
    assert.deepEqual(page.body.sections[0].points.map(x => x.refs), [[1], [2, 3]]);
    assert.deepEqual([page.body.order, page.body.skip.map(x => x.note), page.changes, page.outdated], [[{ note: 1, why: '入门' }], [3], '', false]);
    assert.deepEqual([f.kb.themes()[0].page_hash, f.kb.stats().pages, f.kb.pageFailures()], [page.hash, { total: 1, failed: 0 }, []]);
    // 没有变动，不调用模型。
    calls.length = 0;
    assert.deepEqual([(await pagePass(f.kb, { ...quiet, fetchImpl: fakeModel(calls) })).pages, calls.length], [0, 0]);
    // 改了综述指令：--stale 才重写。
    assert.deepEqual([f.kb.pageBatches({ promptHash: 'new' }).length, f.kb.pageBatches({ promptHash: 'new', stale: true }).length], [0, 1]);
    // 主题里多了一篇：标成待更新，重写后记下新增了哪篇。
    writeFileSync(join(f.home, 'notes', '4.md'), '---\n标题: "剪刀手插件"\n---\n# 核心观点\n\n剪刀手可以装插件扩展转场效果。');
    const db = new DatabaseSync(join(f.home, 'index.sqlite'));
    db.prepare("INSERT INTO items(id,platform,title,author,media_type,status,first_seen,last_seen,updated_at,note_path,prompt_hash,collected_at,decay) VALUES('4','douyin','剪刀手插件','测试作者','video','extracted',1,1,1,?,'aaaa',500,'slow')").run(join(f.home, 'notes', '4.md'));
    db.close();
    f.kb.syncDocs();
    const model = async (url, init) => /标题：剪刀手插件/.test(JSON.parse(init.body).messages[1].content) && !JSON.parse(init.body).messages[0].content.includes('合写成一页综述') && JSON.parse(init.body).messages[0].content.includes('抽出它讲到的')
      ? reply({ 概念: [concept('剪刀手')], 关系: [] }) : fakeModel(calls)(url, init);
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: model, concurrency: 1 });
    await themePass(f.kb, { ...quiet, fetchImpl: model });
    assert.equal(f.kb.page(theme.id).outdated, true);
    await pagePass(f.kb, { ...quiet, fetchImpl: model });
    const next = f.kb.page(theme.id);
    assert.deepEqual([next.notes.length, next.changes, next.outdated, next.hash !== page.hash], [4, '新增 1 篇：《剪刀手插件》', false, true]);
    // 主题不够 3 篇了，不再写；主题消失，综述跟着删掉。
    for (const file of ['x9.md', '4.md', '2.md']) rmSync(join(f.home, 'notes', file));
    f.kb.syncDocs();
    await themePass(f.kb, { ...quiet, fetchImpl: model });
    assert.deepEqual([f.kb.themes().length, f.kb.stats().pages.total], [0, 0]);
  } finally { f.kb.close(); f.cleanup(); }
});

test('控制台综述页：返回综述和它引用的笔记；标记看过记的是当时那一版，不动笔记的已读', async () => {
  const f = fixture();
  const { createConsole } = await import('../console.mjs');
  const app = createConsole({ home: f.home, scheduler: { status: () => ({ installed: false }), plan: () => null } });
  const url = await app.listen(0);
  const token = (await (await fetch(url)).text()).match(/name="dustoff-token" content="([^"]+)"/)[1];
  const post = (path, data) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin, 'X-Dustoff-Token': token }, body: JSON.stringify(data) });
  try {
    f.kb.syncDocs();
    await extractPending(f.kb, f.kb.pendingDocs({}), { ...quiet, fetchImpl: fakeModel(), concurrency: 1 });
    await themePass(f.kb, { ...quiet, fetchImpl: fakeModel() });
    const id = f.kb.themes()[0].id;
    assert.equal((await fetch(`${url}/api/knowledge-page?id=${id}`)).status, 404);
    await pagePass(f.kb, { ...quiet, fetchImpl: fakeModel() });
    const page = await (await fetch(`${url}/api/knowledge-page?id=${id}`)).json();
    assert.deepEqual([page.name, page.notes.map(n => n.title), page.body.intro], ['剪刀手用法', ['剪刀手入门', '剪刀手进阶', '发现一个项目'], '剪刀手是命令行剪辑工具。']);
    const c = await (await fetch(url + '/api/knowledge')).json();
    assert.deepEqual([c.themes[0].page_hash, c.pageReads], [page.hash, {}]);
    const r = await post('/api/page-read', { id });
    assert.equal(r.status, 200, await r.clone().text());
    const after = await (await fetch(url + '/api/knowledge')).json();
    assert.equal(after.pageReads['软件与开发工具｜剪刀手用法'].hash, page.hash);
    assert.equal((await (await fetch(url + '/api/notes-index')).json()).items.every(i => !i.read_at), true);
    await post('/api/page-read', { id, read: false });
    assert.deepEqual((await (await fetch(url + '/api/knowledge')).json()).pageReads, {});
  } finally { await new Promise(r => app.server.close(r)); f.kb.close(); f.cleanup(); }
});
