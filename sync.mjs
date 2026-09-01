#!/usr/bin/env node
// dustoff / sync.mjs
// 唯一入口。串起「扫收藏夹 → 下载」，并处理无人值守需要的那些事：
// 配置、加锁、运行记录、日志、磁盘告警、退出码。
//
// 用法:
//   node sync.mjs                日常增量（定时任务跑这个）
//   node sync.mjs --init         首次初始化（走外接盘、扫全量，手动跑一次）
//   node sync.mjs --resume <id>  重试某次运行的下载，不重新扫描
//   node sync.mjs --dry-run      只报计划，不真的下载
//   node sync.mjs --list         列出最近的运行记录
//
// 为什么分 --init 和默认两种模式：
//   两者的目标盘和扫描量差一个数量级（本机 61MB/天 vs 外接盘 29GB 一次性）。
//   与其让人来回改配置，不如把两套值都写进配置文件，由命令行选用哪一套。
//   带 _INIT 后缀的键就是 --init 模式下的覆盖值。
//
// 退出码:
//   0  成功
//   1  出错
//   3  已有实例在跑（不排队，直接退出）
//   4  登录态失效，需要重新扫码（定时任务应据此告警）
//   5  外接盘未挂载（仅 --init）

import { spawn } from 'node:child_process';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, rmSync,
  readdirSync, statSync, appendFileSync, openSync, closeSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, 'scripts');

// ── 参数 ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const MODE_INIT = has('--init');
const DRY_RUN = has('--dry-run');
const RESUME = valOf('--resume');
const LIST = has('--list');

// ── 配置：命令行 > 环境变量 > 配置文件 > 内置默认 ──────────────────
const HOME_DEFAULT = join(homedir(), '.dustoff');
const DUST_HOME = expand(process.env.DUST_HOME || HOME_DEFAULT);

function expand(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|\/)/, homedir()).replace(/\$HOME/g, homedir());
}

/** 极简 KEY=VALUE 解析。值不加引号，# 起始为注释。 */
function loadConf(file) {
  const conf = {};
  if (!existsSync(file)) return conf;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const hash = v.indexOf(' #');            // 行尾注释
    if (hash >= 0) v = v.slice(0, hash).trim();
    if (k) conf[k] = expand(v);
  }
  return conf;
}

const CONF_FILE = join(DUST_HOME, 'dustoff.conf');
const conf = loadConf(CONF_FILE);

/** 取一个配置项。--init 模式下优先用 <KEY>_INIT。 */
function cfg(key, fallback) {
  const initKey = `${key}_INIT`;
  if (MODE_INIT) {
    const v = process.env[initKey] ?? conf[initKey];
    if (v !== undefined && v !== '') return expand(v);
  }
  const v = process.env[key] ?? conf[key];
  return v !== undefined && v !== '' ? expand(v) : fallback;
}

const MEDIA        = resolve(cfg('DUST_MEDIA', join(DUST_HOME, 'media')));
const SCAN_COUNT   = Number(cfg('DUST_SCAN_COUNT', MODE_INIT ? 99999 : 200));
const CONCURRENCY  = Number(cfg('DUST_CONCURRENCY', 3));
const KEEP_RUNS    = Number(cfg('DUST_KEEP_RUNS', 30));
const MIN_FREE_GB  = Number(cfg('DUST_MIN_FREE_GB', 5));
const MAX_DUR_MIN  = cfg('DUST_MAX_DURATION_MIN', '10');
const NOTIFY       = cfg('DUST_NOTIFY', '1') !== '0';

const RUNS_DIR = join(DUST_HOME, 'runs');
const LOCK     = join(DUST_HOME, '.lock');
const FLAG     = join(DUST_HOME, 'NEEDS_LOGIN');

// ── 日志：同时打屏幕和写文件（定时任务没有终端，必须落盘）────────────
let logFile = null;
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.error(line);
  if (logFile) { try { appendFileSync(logFile, line + '\n'); } catch {} }
}
function die(code, msg) {
  log(`✗ ${msg}`);
  releaseLock();
  process.exit(code);
}

function notify(title, message) {
  if (!NOTIFY || process.platform !== 'darwin') return;
  const esc = s => String(s).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');
  try {
    execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "Basso"'`,
      { timeout: 5000, stdio: 'ignore' });
  } catch {}
}

// ── 锁：防止上一次没跑完又被触发（两个 Chrome 抢同一个 profile 会炸）──
function acquireLock() {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) {
      console.error(`[${stamp()}] ✗ 已有实例在跑（pid ${pid}），本次退出`);
      process.exit(3);
    }
    log(`发现过期的锁（pid ${pid} 已不存在），接管`);
    try { unlinkSync(LOCK); } catch {}
  }
  mkdirSync(DUST_HOME, { recursive: true });
  writeFileSync(LOCK, String(process.pid));
}
function releaseLock() { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch {} }
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

// ── 跑子脚本，stdout 收集、stderr 转发进日志 ────────────────────────
function run(script, args, { stdoutTo = null } = {}) {
  return new Promise(res => {
    const p = spawn('node', [join(SCRIPTS, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => log('   ' + l.replace(/^>>\s*/, ''))));
    p.on('close', code => {
      if (stdoutTo && out.trim()) { try { writeFileSync(stdoutTo, out); } catch {} }
      res({ code, out });
    });
  });
}

function freeGB(path) {
  try {
    const o = execSync(`df -k ${JSON.stringify(path)}`, { encoding: 'utf8' }).trim().split('\n').pop();
    return Number(o.split(/\s+/)[3]) / 1024 / 1024;
  } catch { return null; }
}

function pruneRuns() {
  if (!existsSync(RUNS_DIR) || !(KEEP_RUNS > 0)) return 0;
  const cutoff = Date.now() - KEEP_RUNS * 86400_000;
  let n = 0;
  for (const d of readdirSync(RUNS_DIR)) {
    const p = join(RUNS_DIR, d);
    try {
      if (!statSync(p).isDirectory()) continue;
      if (statSync(p).mtimeMs < cutoff) { rmSync(p, { recursive: true, force: true }); n++; }
    } catch {}
  }
  return n;
}

// ── --list ────────────────────────────────────────────────────────
if (LIST) {
  if (!existsSync(RUNS_DIR)) { console.log('还没有任何运行记录'); process.exit(0); }
  const runs = readdirSync(RUNS_DIR).filter(d => statSync(join(RUNS_DIR, d)).isDirectory()).sort().reverse();
  console.log(`最近 ${Math.min(runs.length, 20)} 次运行（共 ${runs.length}）：\n`);
  for (const r of runs.slice(0, 20)) {
    const rp = join(RUNS_DIR, r);
    let summary = '（无结果）';
    try {
      const res = JSON.parse(readFileSync(join(rp, 'result.json'), 'utf8'));
      summary = Object.entries(res.summary || {}).map(([k, v]) => `${k}:${v}`).join(' ') +
                `  ${(res.bytes / 1024 / 1024).toFixed(1)}MB  ${res.elapsed_s}s`;
    } catch {}
    console.log(`  ${r}   ${summary}`);
  }
  process.exit(0);
}

// ── 主流程 ────────────────────────────────────────────────────────
(async () => {
  acquireLock();

  const runId = RESUME || new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const runDir = join(RUNS_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  logFile = join(runDir, 'run.log');

  const collFile = join(runDir, 'coll.json');
  const resultFile = join(runDir, 'result.json');

  log(`dustoff ${RESUME ? '重试下载' : MODE_INIT ? '首次初始化' : '日常增量'}　run=${runId}`);
  log(`配置文件 ${existsSync(CONF_FILE) ? CONF_FILE : '（未找到，用内置默认值）'}`);
  log(`媒体目录 ${MEDIA}`);

  // 目标盘检查。--init 常指向外接盘，盘没挂载时必须硬失败——
  // 静默落回本机会把系统盘瞬间灌满。
  const parent = dirname(MEDIA);
  if (!existsSync(parent)) {
    notify('dustoff 无法开始', `目标位置不存在：${parent}（外接盘没插？）`);
    die(5, `媒体目录的父级不存在：${parent}\n     若指向外接盘，请确认已插好并挂载（ls /Volumes/）`);
  }
  try {
    mkdirSync(MEDIA, { recursive: true });
    const probe = join(MEDIA, '.write_probe');
    writeFileSync(probe, ''); unlinkSync(probe);
  } catch (e) {
    die(5, `媒体目录不可写：${MEDIA}（${e.message}）`);
  }

  const before = freeGB(MEDIA);
  if (before !== null) log(`目标盘剩余 ${before.toFixed(1)} GB`);

  // ① 扫描（--resume 时跳过，直接用上次存下的 coll.json）
  if (RESUME) {
    if (!existsSync(collFile)) die(1, `运行记录 ${runId} 里没有 coll.json`);
    log(`复用 ${runId} 的扫描结果，跳过扫描`);
  } else {
    log(`扫描收藏夹，最多 ${SCAN_COUNT} 条 ...`);
    const r = await run('get_collection.mjs', [String(SCAN_COUNT)], { stdoutTo: collFile });
    if (r.code === 4) {
      notify('dustoff 登录已失效', '收藏夹同步已停止，需要重新扫码');
      die(4, `登录态失效。请运行：node ${join(SCRIPTS, 'login.mjs')}\n     标记文件：${FLAG}`);
    }
    if (r.code !== 0) die(1, `扫描失败（退出码 ${r.code}）`);
    if (!existsSync(collFile)) die(1, '扫描没有产出 coll.json');
  }

  const coll = JSON.parse(readFileSync(collFile, 'utf8'));
  log(`扫到 ${coll.count} 条${coll.truncated ? '（还有更多未取）' : ''}`);

  // ② 下载
  const dlArgs = [collFile, String(CONCURRENCY)];
  const env = { ...process.env, DUST_MEDIA: MEDIA, DUST_MAX_DURATION_MIN: String(MAX_DUR_MIN) };
  if (DRY_RUN) env.DUST_DRY_RUN = '1';
  log(`下载${DRY_RUN ? '（DRY RUN）' : ''}，并发 ${CONCURRENCY} ...`);
  const dl = await new Promise(res => {
    const p = spawn('node', [join(SCRIPTS, 'download.mjs'), ...dlArgs], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => log('   ' + l.replace(/^>>\s*/, ''))));
    p.on('close', code => { if (out.trim()) { try { writeFileSync(resultFile, out); } catch {} } res({ code, out }); });
  });
  if (dl.code !== 0) die(1, `下载失败（退出码 ${dl.code}）`);

  let result = {};
  try { result = JSON.parse(dl.out); } catch {}
  const sum = result.summary || {};

  // ③ 收尾：磁盘告警 + 清理超期运行记录
  const after = freeGB(MEDIA);
  if (after !== null && after < MIN_FREE_GB) {
    log(`⚠️ 目标盘仅剩 ${after.toFixed(1)} GB，低于阈值 ${MIN_FREE_GB} GB`);
    notify('dustoff 磁盘告警', `${MEDIA} 仅剩 ${after.toFixed(1)} GB`);
  }
  const pruned = pruneRuns();
  if (pruned) log(`清理了 ${pruned} 份超过 ${KEEP_RUNS} 天的运行记录`);

  const parts = Object.entries(sum).map(([k, v]) => `${k} ${v}`).join(' · ');
  log(`完成：${parts || '无变化'}　落盘 ${((result.bytes || 0) / 1024 / 1024).toFixed(1)} MB　用时 ${result.elapsed_s || 0}s`);
  log(`记录 ${runDir}`);

  if (sum.failed) log(`⚠️ ${sum.failed} 条全部 CDN 地址失败，可稍后重试：node sync.mjs --resume ${runId}`);
  if (sum.skipped_expired) log(`⚠️ ${sum.skipped_expired} 条地址已过期，需要重新扫描`);
  if (sum.skipped_too_long) {
    log(`ℹ️ ${sum.skipped_too_long} 条超过 ${MAX_DUR_MIN} 分钟被拦下（明细见 ${resultFile}）`);
    log(`   想要其中某条：node scripts/fetch.mjs '<链接>'　或临时放开：DUST_MAX_DURATION_MIN=0 node sync.mjs`);
  }

  releaseLock();
  process.exit(0);
})().catch(e => die(1, e.stack || e.message));
