#!/usr/bin/env node
// 运行历史：每轮结束往 runs/history.jsonl 追加一行摘要（版本、耗时、退出码、各项计数、失败条目与原因）。
// 运行记录目录按天数清理，这份摘要只保留最近 2000 轮，用来快速回答“哪几轮出过错、某条作品失败过几次”。
//
//   node scripts/run-history.mjs                最近 20 轮
//   node scripts/run-history.mjs --failures     只看有失败、暂停或扫描受阻的轮次
//   node scripts/run-history.mjs --id <作品ID>   这条作品在哪几轮失败、原因是什么
//   node scripts/run-history.mjs -n 50          显示条数
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DUST_HOME } from './config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEEP = 2000;
export const historyFile = home => join(home, 'runs', 'history.jsonl');

let cached;
/** 代码版本：发布包里由 git archive 写入 version.txt；开发目录直接问 git。 */
export function codeVersion(root = ROOT) {
  if (cached) return cached;
  try { const v = readFileSync(join(root, 'scripts', 'version.txt'), 'utf8').trim(); if (v && !v.includes('$Format')) return cached = v; } catch {}
  try { return cached = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h %cs'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() + '（开发目录）'; }
  catch { return cached = '未知版本'; }
}

export function appendHistory(home, runId, summary, exitCode, startedAt) {
  try {
    const file = historyFile(home), finished = Date.now();
    const keys = obj => Object.keys(obj || {}).length ? obj : undefined;
    const line = JSON.stringify({
      run: runId, version: codeVersion(), started: new Date(startedAt).toISOString(), seconds: Math.round((finished - startedAt) / 1000), exit: exitCode,
      processed: summary.processed, notes: summary.notes, saved: summary.saved, galleries: summary.galleries, review: summary.review, skipped: summary.skipped,
      added: summary.added, failures: summary.failures.length ? summary.failures.map(f => ({ ...f, error: String(f.error || '').slice(0, 300) })) : undefined,
      paused: summary.paused || undefined, pausedPlatforms: keys(summary.pausedPlatforms), pausedTypes: keys(summary.pausedTypes), scanWarning: summary.scanWarning || undefined,
    });
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line + '\n', { mode: 0o600 });
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > KEEP + 200) writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n', { mode: 0o600 });
  } catch {} // 摘要只是索引，写不进去不影响本轮结果
}

export function readHistory(home = DUST_HOME) {
  const file = historyFile(home);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const problems = r => r.exit || r.failures?.length || r.paused || r.pausedPlatforms || r.pausedTypes || r.scanWarning;
export function formatRun(r) {
  const t = new Date(r.started).toLocaleString('zh-CN', { hour12: false });
  const head = `${t}  退出码 ${r.exit}  ${r.seconds}s  处理 ${r.processed ?? 0}（笔记 ${r.notes ?? 0} 视频 ${r.saved ?? 0} 图集 ${r.galleries ?? 0} 待确认 ${r.review ?? 0} 跳过 ${r.skipped ?? 0}）  ${r.version}  ${r.run}`;
  const more = [];
  for (const f of r.failures || []) more.push(`    失败 ${f.id || '—'}${f.platform ? `（${f.platform}${f.kind ? '/' + f.kind : ''}）` : ''}：${f.error}`);
  if (r.paused) more.push(`    暂停：${r.paused}`);
  for (const [k, v] of Object.entries(r.pausedPlatforms || {})) more.push(`    平台暂停 ${k}：${v}`);
  for (const [k, v] of Object.entries(r.pausedTypes || {})) more.push(`    类型暂停 ${k}：${v}`);
  if (r.scanWarning) more.push(`    扫描受阻：${r.scanWarning}`);
  return [head, ...more].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), at = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const n = Math.max(1, Number(at('-n')) || 20), id = at('--id');
  let runs = readHistory();
  if (id) runs = runs.filter(r => r.failures?.some(f => f.id === id)).map(r => ({ ...r, failures: r.failures.filter(f => f.id === id) }));
  else if (args.includes('--failures')) runs = runs.filter(problems);
  if (!runs.length) console.log(id ? `历史中没有 ${id} 的失败记录` : '没有符合条件的运行记录（历史从本功能上线后开始累积）');
  for (const r of runs.slice(-n)) console.log(formatRun(r));
}
