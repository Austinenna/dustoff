#!/usr/bin/env node
// dustoff / knowledge.mjs —— 第四段：给笔记定大类、抽出概念，建知识库索引 knowledge.sqlite。
//
// 只读笔记和账本，只写 knowledge.sqlite；不改笔记、不改账本，所以不占流水线的锁。
//
//   node knowledge.mjs                 给新增和改过的笔记定大类、抽概念，全部做完后归并概念、按大类归纳主题、给主题写综述页
//   node knowledge.mjs --limit 20      本轮最多抽 20 篇
//   node knowledge.mjs --stale         连同用旧版指令做的一起重做（只改了大类定义时只重新分类，只改了综述指令时只重写综述）
//   node knowledge.mjs --retry-failed  重试失败满 3 次的笔记和综述
//   node knowledge.mjs --rebuild       清空抽取结果后全部重抽（做过的合并会重放）
//   node knowledge.mjs --rethemes      清空主题后每个大类从头归纳（改了归纳主题的指令后用）
//   node knowledge.mjs --no-merge      只抽取，不做归并、主题归纳和综述
//   node knowledge.mjs --no-pages      不写综述页
//   node knowledge.mjs --dry-run       只看有多少篇要抽，不调用模型
//   node knowledge.mjs --report        只输出当前统计
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeCfg, DUST_HOME } from './scripts/config.mjs';
import { PauseError } from './scripts/policy.mjs';
import { createKnowledge, bodyHash } from './scripts/knowledge-store.mjs';
import { CLASSIFY_HASH, EXTRACT_HASH, PAGE_HASH, ModerationError, PermanentError, UNSORTED, classifyNote, clusterThemes, extractNote, knowledgeConfig, mergeConcepts, noteBody, notePublished, normName, writePage } from './scripts/knowledge-extract.mjs';

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || '').href;
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.error(`[${stamp()}] ${a.join(' ')}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 正文太短没有可抽的东西；太长的只取开头，概念通常在前面就出现了。
const MIN_CHARS = 20, MAX_CHARS = 12000, MERGE_BATCH = 200;
// 写综述时每篇笔记最多给这么多字，整个主题合计不超过 PAGE_TOTAL_CHARS；篇数多时每篇按比例少给。
const PAGE_NOTE_CHARS = 8000, PAGE_TOTAL_CHARS = 60000;

/**
 * 处理一批笔记：定大类、抽概念，每篇各调一次模型。并发处理，每篇失败后本轮内再试两次；
 * 连续失败达到上限就停（多半是密钥、余额或网络出了问题），预算用完立即停。
 */
export async function extractPending(kb, docs, { config = knowledgeConfig(), fetchImpl = fetch, concurrency = 2, maxFails = 3, retryMs = 2000, onLog = log } = {}) {
  const queue = [...docs], result = { done: 0, failed: 0, skipped: 0, moderated: 0, input: 0, output: 0, stopped: null };
  let streak = 0;
  async function one(doc) {
    let body;
    try { body = noteBody(readFileSync(doc.path, 'utf8')); } catch (e) { kb.markError(doc.item, `读不到笔记文件：${e.code || e.message}`); result.failed++; return; }
    if (body.length < MIN_CHARS) { kb.markError(doc.item, '正文太短，没有可抽取的内容', { permanent: true }); result.skipped++; return; }
    const input = body.slice(0, MAX_CHARS), saved = { model: config.model, contentHash: bodyHash(body) };
    const used = usage => { result.input += usage.input; result.output += usage.output; };
    let domain = doc.domain, line = '';
    for (let attempt = 1; ; attempt++) {
      try {
        // 先定大类，再抽概念。前一步成功后就存下来，后一步失败重试时不用再做一遍。
        if (doc.need_classify) {
          const out = await classifyNote({ id: doc.item, title: doc.title, body: input }, { config, fetchImpl });
          kb.saveDomain(doc.item, out, { hash: CLASSIFY_HASH, contentHash: saved.contentHash });
          doc.need_classify = 0; domain = out.domain; used(out.usage);
          if (out.domain === UNSORTED) line = `（${out.domainNote}）`;
        }
        if (doc.need_extract) {
          const out = await extractNote({ id: doc.item, title: doc.title, author: doc.author, body: input, vocabulary: kb.vocabulary() }, { config, fetchImpl });
          kb.saveExtraction(doc.item, out, { promptHash: EXTRACT_HASH, ...saved });
          doc.need_extract = 0; used(out.usage);
          line += `｜${out.concepts.map(c => (c.role === '主题' ? '★' : '') + c.name).join('、')}`;
        }
        result.done++; streak = 0;
        onLog(`✓ ${doc.item} ${domain}${line}`);
        return;
      } catch (e) {
        if (e instanceof PauseError) { result.stopped = e.message; return; }
        // 内容审核拒绝的不算失败：放进「未分类」并写明原因，不抽概念，也不再重试。
        if (e instanceof ModerationError) {
          kb.saveDomain(doc.item, { domain: UNSORTED, domainNote: '模型服务的内容审核拒绝处理这篇笔记' }, { hash: CLASSIFY_HASH, contentHash: saved.contentHash });
          if (doc.need_extract) kb.saveExtraction(doc.item, { concepts: [], relations: [] }, { promptHash: EXTRACT_HASH, ...saved });
          result.done++; result.moderated++; streak = 0;
          onLog(`✓ ${doc.item} ${UNSORTED}｜内容审核拒绝`);
          return;
        }
        const permanent = e instanceof PermanentError;
        if (!permanent && attempt < 3) { await sleep(retryMs * attempt); continue; }
        kb.markError(doc.item, e.message, { permanent });
        result.failed++; streak++;
        onLog(`✗ ${doc.item} ${e.message}`);
        if (streak >= maxFails) result.stopped = `连续 ${streak} 篇失败，本轮停止`;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length && !result.stopped) await one(queue.shift());
  }));
  return result;
}

/** 归并：按大类把概念交给模型，指同一个东西的直接合并，拿不准的记成待确认建议。 */
export async function mergePass(kb, { config = knowledgeConfig(), fetchImpl = fetch, onLog = log } = {}) {
  const result = { merged: 0, suggested: 0, failed: 0, input: 0, output: 0 };
  for (const { domain, concepts } of kb.mergeBatches()) {
    // 按归一名排序再分批，写法相近的概念落在同一批里。
    const sorted = [...concepts].sort((a, b) => normName(a.name).localeCompare(normName(b.name)));
    for (let n = 0; n < sorted.length; n += MERGE_BATCH) {
      const batch = sorted.slice(n, n + MERGE_BATCH);
      if (batch.length < 2) { kb.markMergeChecked(batch.map(c => c.id)); continue; }
      try {
        const out = await mergeConcepts(domain, batch, { config, fetchImpl });
        const name = id => batch.find(c => c.id === id)?.name;
        for (const m of out.merges) for (const drop of m.drop) if (kb.merge(m.keep, drop, '模型判断为同一个概念')) { result.merged++; onLog(`合并 ${name(drop)} → ${name(m.keep)}`); }
        for (const u of out.unsure) if (kb.suggest(u.a, u.b, u.reason)) result.suggested++;
        kb.markMergeChecked(batch.map(c => c.id));
        result.input += out.usage.input; result.output += out.usage.output;
      } catch (e) {
        if (e instanceof PauseError) throw e;
        result.failed++; onLog(`✗ 归并「${domain}」失败：${e.message}`);   // 这一批没标记，下次再试
      }
    }
  }
  return result;
}

/** 主题归纳：有新笔记或笔记变动的大类，把该大类全部笔记交给模型重新归纳一遍。 */
export async function themePass(kb, { config = knowledgeConfig(), fetchImpl = fetch, onLog = log } = {}) {
  const result = { domains: 0, themes: 0, failed: 0, input: 0, output: 0 };
  for (const { domain, notes, themes } of kb.themeBatches()) {
    try {
      // 只有一篇笔记的大类没有可归纳的，直接记为已处理。
      const out = notes.length < 2 ? { themes: [], usage: { input: 0, output: 0 } } : await clusterThemes(domain, notes, themes, { config, fetchImpl });
      kb.saveThemes(domain, out.themes.map(t => ({ ...t, items: t.notes.map(i => notes[i].item) })));
      result.domains++; result.themes += out.themes.length; result.input += out.usage.input; result.output += out.usage.output;
      onLog(`主题「${domain}」${notes.length} 篇：${out.themes.map(t => `${t.name}(${t.notes.length})`).join('、') || '无'}`);
    } catch (e) {
      if (e instanceof PauseError) throw e;
      result.failed++; onLog(`✗ 归纳「${domain}」的主题失败：${e.message}`);   // 没标记，下次再试
    }
  }
  return result;
}

/**
 * 综述页：够篇数的主题里，还没有综述或笔记有变化的，把主题下全部笔记交给模型重写一页。
 * 每页失败后本轮内再试两次。被内容审核拒绝的记下来，这批笔记不变就不再试。
 */
export async function pagePass(kb, { config = knowledgeConfig(), fetchImpl = fetch, concurrency = 2, stale = false, retryFailed = false, retryMs = 2000, today = new Date().toLocaleDateString('sv'), onLog = log } = {}) {
  const queue = kb.pageBatches({ promptHash: PAGE_HASH, stale, retryFailed }), result = { pages: 0, failed: 0, input: 0, output: 0 };
  let stop = null;
  async function one(theme) {
    const cap = Math.min(PAGE_NOTE_CHARS, Math.floor(PAGE_TOTAL_CHARS / theme.notes.length));
    let notes;
    try {
      notes = theme.notes.map(n => { const source = readFileSync(n.path, 'utf8'); return { ...n, published: notePublished(source), body: noteBody(source).slice(0, cap) }; });
    } catch (e) { kb.markPageError(theme.id, theme.hash, `读不到笔记文件：${e.code || e.message}`); result.failed++; return; }
    for (let attempt = 1; ; attempt++) {
      try {
        const { usage, ...body } = await writePage({ domain: theme.domain, name: theme.name, summary: theme.summary, notes, today }, { config, fetchImpl });
        kb.savePage(theme.id, body, { notes, hash: theme.hash, promptHash: PAGE_HASH, model: config.model });
        result.pages++; result.input += usage.input; result.output += usage.output;
        onLog(`综述「${theme.name}」${notes.length} 篇，${body.sections.reduce((n, s) => n + s.points.length, 0)} 条要点`);
        return;
      } catch (e) {
        if (e instanceof PauseError) { stop = e; return; }
        const permanent = e instanceof PermanentError;
        if (!permanent && attempt < 3) { await sleep(retryMs * attempt); continue; }
        kb.markPageError(theme.id, theme.hash, e instanceof ModerationError ? '模型服务的内容审核拒绝处理这个主题的笔记' : e.message, { permanent });
        result.failed++; onLog(`✗ 综述「${theme.name}」失败：${e.message}`);
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => { while (queue.length && !stop) await one(queue.shift()); }));
  if (stop) throw stop;
  return result;
}

async function main() {
  const args = process.argv.slice(2), has = flag => args.includes(flag);
  const valOf = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const cfg = makeCfg(), config = knowledgeConfig(cfg);
  const kb = createKnowledge(DUST_HOME);
  if (has('--report')) { console.log(JSON.stringify({ ...kb.stats(), failures: kb.failures(), page_failures: kb.pageFailures() }, null, 2)); return; }

  // 同一时间只跑一个：两个进程同时抽，会各自新建同一个概念。
  const lock = join(DUST_HOME, '.lock.knowledge');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code !== 'ESRCH'; }
    if (alive) { log(`✗ 已有 knowledge 实例在跑（pid ${pid}），本次退出`); process.exitCode = 3; return; }
  }
  mkdirSync(DUST_HOME, { recursive: true });
  writeFileSync(lock, String(process.pid), { mode: 0o600 });
  const release = () => { try { if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  const sync = kb.syncDocs();
  log(`笔记 ${sync.total} 篇：新增 ${sync.added}，正文有改动 ${sync.changed}，已不存在 ${sync.removed}`);
  if (has('--rebuild')) { kb.reset(); log('已清空抽取结果，全部重抽'); }
  if (has('--rethemes')) { kb.resetThemes(); log('已清空主题，每个大类从头归纳'); }
  const limit = Number(valOf('--limit')) > 0 ? Number(valOf('--limit')) : 100000;
  const docs = kb.pendingDocs({ promptHash: EXTRACT_HASH, classifyHash: CLASSIFY_HASH, stale: has('--stale'), retryFailed: has('--retry-failed'), limit });
  log(`待处理 ${docs.length} 篇，其中要分类 ${docs.filter(d => d.need_classify).length}、要抽概念 ${docs.filter(d => d.need_extract).length}（模型 ${config.model}，思考档位 ${config.effort}）`);
  if (has('--dry-run')) { log(`按现在的主题，要写或重写的综述 ${has('--no-pages') ? 0 : kb.pageBatches({ promptHash: PAGE_HASH, stale: has('--stale'), retryFailed: has('--retry-failed') }).length} 页`); return; }

  let stopped = null;
  if (docs.length) {
    if (!config.key) { log('✗ 未配置模型密钥（DUST_LLM_KEY 或 DUST_KB_KEY）'); process.exitCode = 6; return; }
    const r = await extractPending(kb, docs, { config, concurrency: Number(cfg('DUST_KB_CONCURRENCY', 2)), maxFails: Number(cfg('DUST_LLM_MAX_FAILS', 3)) });
    stopped = r.stopped;
    log(`抽取完成 ${r.done} 篇，失败 ${r.failed}，跳过 ${r.skipped}${r.moderated ? `，其中 ${r.moderated} 篇被内容审核拒绝、已放进「未分类」` : ''}；用量 输入 ${r.input} 输出 ${r.output} token`);
    if (stopped) log(`✗ ${stopped}`);
  }
  const replayed = kb.replayMerges(), orphans = kb.dropOrphans();
  if (replayed || orphans) log(`重放以前的合并 ${replayed} 次，清掉没有笔记的概念 ${orphans} 个`);
  // 还有笔记没抽完时不做归并：概念不全，判断了也要重来。
  const rest = kb.pendingDocs({ promptHash: EXTRACT_HASH, classifyHash: CLASSIFY_HASH, stale: has('--stale') }).length;
  if (!has('--no-merge') && !stopped && !rest) {
    try {
      const m = await mergePass(kb, { config });
      log(`归并：合并 ${m.merged} 个，待确认 ${m.suggested} 对${m.failed ? `，${m.failed} 批失败` : ''}；用量 输入 ${m.input} 输出 ${m.output} token`);
      const t = await themePass(kb, { config });
      log(`主题：${t.domains} 个大类重新归纳，共 ${t.themes} 个主题${t.failed ? `，${t.failed} 个大类失败` : ''}；用量 输入 ${t.input} 输出 ${t.output} token`);
      if (!has('--no-pages')) {
        const p = await pagePass(kb, { config, concurrency: Number(cfg('DUST_KB_CONCURRENCY', 2)), stale: has('--stale'), retryFailed: has('--retry-failed') });
        log(`综述：写了 ${p.pages} 页${p.failed ? `，${p.failed} 页失败` : ''}；用量 输入 ${p.input} 输出 ${p.output} token`);
      }
    } catch (e) { stopped = e.message; log(`✗ ${e.message}`); }
  } else if (rest) log(`还有 ${rest} 篇没抽取，本轮不做归并、主题归纳和综述`);
  console.log(JSON.stringify(kb.stats(), null, 2));
  if (stopped) process.exitCode = stopped.startsWith('连续') ? 1 : 5;
  else if (kb.failures().length || kb.pageFailures().length) process.exitCode = 2;
  kb.close();
}

if (IS_MAIN) main().catch(e => { console.error(e.message); process.exitCode = 1; });
