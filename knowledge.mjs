#!/usr/bin/env node
// dustoff / knowledge.mjs —— 第四段：从笔记抽出概念，建知识库索引 knowledge.sqlite。
//
// 只读笔记和账本，只写 knowledge.sqlite；不改笔记、不改账本，所以不占流水线的锁。
//
//   node knowledge.mjs                 抽取新增和改过的笔记，全部抽完后做一次概念归并
//   node knowledge.mjs --limit 20      本轮最多抽 20 篇
//   node knowledge.mjs --stale         连同用旧版指令抽的一起重抽
//   node knowledge.mjs --retry-failed  重试失败满 3 次的
//   node knowledge.mjs --rebuild       清空抽取结果后全部重抽（做过的合并会重放）
//   node knowledge.mjs --no-merge      只抽取，不做归并
//   node knowledge.mjs --dry-run       只看有多少篇要抽，不调用模型
//   node knowledge.mjs --report        只输出当前统计
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeCfg, DUST_HOME } from './scripts/config.mjs';
import { PauseError } from './scripts/policy.mjs';
import { createKnowledge, bodyHash } from './scripts/knowledge-store.mjs';
import { EXTRACT_HASH, PermanentError, extractNote, knowledgeConfig, mergeConcepts, noteBody, normName } from './scripts/knowledge-extract.mjs';

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || '').href;
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.error(`[${stamp()}] ${a.join(' ')}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 正文太短没有可抽的东西；太长的只取开头，概念通常在前面就出现了。
const MIN_CHARS = 20, MAX_CHARS = 12000, MERGE_BATCH = 200;

/**
 * 抽取一批笔记。并发处理，每篇失败后本轮内再试两次；
 * 连续失败达到上限就停（多半是密钥、余额或网络出了问题），预算用完立即停。
 */
export async function extractPending(kb, docs, { config = knowledgeConfig(), fetchImpl = fetch, concurrency = 2, maxFails = 3, retryMs = 2000, onLog = log } = {}) {
  const queue = [...docs], result = { done: 0, failed: 0, skipped: 0, input: 0, output: 0, stopped: null };
  let streak = 0;
  async function one(doc) {
    let body;
    try { body = noteBody(readFileSync(doc.path, 'utf8')); } catch (e) { kb.markError(doc.item, `读不到笔记文件：${e.code || e.message}`); result.failed++; return; }
    if (body.length < MIN_CHARS) { kb.markError(doc.item, '正文太短，没有可抽取的内容', { permanent: true }); result.skipped++; return; }
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await extractNote({ id: doc.item, title: doc.title, author: doc.author, body: body.slice(0, MAX_CHARS), vocabulary: kb.vocabulary() }, { config, fetchImpl });
        kb.saveExtraction(doc.item, out, { promptHash: EXTRACT_HASH, model: config.model, contentHash: bodyHash(body) });
        result.done++; result.input += out.usage.input; result.output += out.usage.output; streak = 0;
        onLog(`✓ ${doc.item} ${out.domain}｜${out.concepts.map(c => (c.role === '主题' ? '★' : '') + c.name).join('、')}`);
        return;
      } catch (e) {
        if (e instanceof PauseError) { result.stopped = e.message; return; }
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

async function main() {
  const args = process.argv.slice(2), has = flag => args.includes(flag);
  const valOf = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const cfg = makeCfg(), config = knowledgeConfig(cfg);
  const kb = createKnowledge(DUST_HOME);
  if (has('--report')) { console.log(JSON.stringify({ ...kb.stats(), failures: kb.failures() }, null, 2)); return; }

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
  const limit = Number(valOf('--limit')) > 0 ? Number(valOf('--limit')) : 100000;
  const docs = kb.pendingDocs({ promptHash: EXTRACT_HASH, stale: has('--stale'), retryFailed: has('--retry-failed'), limit });
  log(`待抽取 ${docs.length} 篇（模型 ${config.model}，思考档位 ${config.effort}）`);
  if (has('--dry-run')) return;

  let stopped = null;
  if (docs.length) {
    if (!config.key) { log('✗ 未配置模型密钥（DUST_LLM_KEY 或 DUST_KB_KEY）'); process.exitCode = 6; return; }
    const r = await extractPending(kb, docs, { config, concurrency: Number(cfg('DUST_KB_CONCURRENCY', 2)), maxFails: Number(cfg('DUST_LLM_MAX_FAILS', 3)) });
    stopped = r.stopped;
    log(`抽取完成 ${r.done} 篇，失败 ${r.failed}，跳过 ${r.skipped}；用量 输入 ${r.input} 输出 ${r.output} token`);
    if (stopped) log(`✗ ${stopped}`);
  }
  const replayed = kb.replayMerges(), orphans = kb.dropOrphans();
  if (replayed || orphans) log(`重放以前的合并 ${replayed} 次，清掉没有笔记的概念 ${orphans} 个`);
  // 还有笔记没抽完时不做归并：概念不全，判断了也要重来。
  const rest = kb.pendingDocs({ promptHash: EXTRACT_HASH, stale: has('--stale') }).length;
  if (!has('--no-merge') && !stopped && !rest) {
    try {
      const m = await mergePass(kb, { config });
      log(`归并：合并 ${m.merged} 个，待确认 ${m.suggested} 对${m.failed ? `，${m.failed} 批失败` : ''}；用量 输入 ${m.input} 输出 ${m.output} token`);
    } catch (e) { stopped = e.message; log(`✗ ${e.message}`); }
  } else if (rest) log(`还有 ${rest} 篇没抽取，本轮不做归并`);
  console.log(JSON.stringify(kb.stats(), null, 2));
  if (stopped) process.exitCode = stopped.startsWith('连续') ? 1 : 5;
  else if (kb.failures().length) process.exitCode = 2;
  kb.close();
}

if (IS_MAIN) main().catch(e => { console.error(e.message); process.exitCode = 1; });
