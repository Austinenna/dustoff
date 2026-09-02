#!/usr/bin/env node
// dustoff / sync.mjs
// 第一段（采集）的入口。串起「扫收藏夹 → 下载 → 写账本」，
// 并处理无人值守需要的那些事：配置、加锁、运行记录、日志、磁盘告警、退出码。
//
// 它刻意不调用第二段（提取）。两段只通过账本对话：
//   采集写 pending / downloaded，提取读 downloaded。
// 合并成一个进程会废掉故障隔离——登录态失效时采集会直接退出，
// 而账本里可能还躺着一批已下载待转写的，它们本来完全不受登录影响。
// 手动跑全链路就是依次跑两条命令；以后两个定时器跑的也是同样这两条。
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
  mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { importScan, importDownload, reconcile, stats, pendingAmong } from './scripts/ledger.mjs';
import { createStage, freeGB, EXIT } from './scripts/stage.mjs';

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

const FLAG = join(DUST_HOME, 'NEEDS_LOGIN');

// 阶段骨架（加锁、日志落盘、运行记录、通知、退出码）抽在 scripts/stage.mjs，
// 与第二段共用一份实现——两段是平级的独立入口，需要同样这套东西。
const stage = createStage({
  name: 'collect', dustHome: DUST_HOME, notify: NOTIFY, keepRuns: KEEP_RUNS,
  runId: RESUME || null,
  pruneLegacy: true,        // 分阶段之前的运行记录没有阶段后缀，一并清理
});
const { log, die, notify, runId, runDir, RUNS_DIR, releaseLock } = stage;

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
  stage.acquireLock();

  const collFile = join(runDir, 'coll.json');
  const todoFile = join(runDir, 'todo.json');
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

  // 扫描结果并入账本。已存在的只刷新 last_seen 和元数据，
  // 绝不覆盖处理状态——否则每天的扫描会把已经转写好的条目打回 pending。
  if (!DRY_RUN) {
    const imp = importScan(coll.items || []);
    log(`账本：新增 ${imp.added} 条（本次见到 ${imp.seen} 条）`);

    // 对账只在真的翻到底时做。日常增量只覆盖最新若干条，
    // 拿它对账会把其余条目全部误判为已取消收藏。
    if (coll.truncated === false) {
      try {
        const rec = reconcile((coll.items || []).map(i => i.aweme_id), { scanComplete: true });
        if (rec.removed) log(`账本：${rec.removed} 条已从收藏夹移除（共核对 ${rec.checked} 条）`);
      } catch (e) {
        // 闸门拦下来了。不中断整轮——采集和下载都已完成，
        // 对账失败只意味着「已取消收藏」这个信息今天没更新，不影响其他。
        log(`⚠️ 对账被拒绝，本轮跳过：${String(e.message).split('\n')[0]}`);
      }
    } else {
      log(`扫描未到底，跳过对账`);
    }
  }

  // ② 按账本筛出真正要下的，写成 todo.json
  //
  // 为什么要这一步：download.mjs 只会问磁盘「文件在不在」，而磁盘的「不在」
  // 是个歧义答案——分不清「从没下过」和「转写完被正常清理了」。后者如果重下，
  // 会形成一个循环：下载 → 转写 → 保留期到了删掉 → 但它还在扫描窗口里 → 再下回来。
  // 扫描窗口（200 条 ≈ 13 天）比保留期（7 天）长，所以每一条都会中招。
  //
  // 账本能分清，所以由它来筛。筛完 download.mjs 就只管「给我什么下什么」，
  // 不需要认识账本，也不需要改一行代码。
  //
  // 只放行 status='pending'，没有例外。文件不在就是不在，不追究原因——
  // 用户手工删掉的东西，工具不该自作主张下回来。
  const items = coll.items || [];
  // --dry-run 不写账本，所以预演时把「账本还没见过的」也算进来——
  // 真跑时 importScan 会把它们记成 pending，效果一样。
  const keep = pendingAmong(items.map(i => i.aweme_id), { includeUnknown: DRY_RUN });
  const todo = { ...coll, items: items.filter(i => keep.has(i.aweme_id)), count: keep.size };
  writeFileSync(todoFile, JSON.stringify(todo));
  log(`账本筛选：${keep.size} 条待下载，剔除 ${items.length - keep.size} 条（已处理 / 已跳过 / 已放弃）`);

  // ③ 下载
  let result = {};
  if (keep.size) {
    const env = { ...process.env, DUST_MEDIA: MEDIA, DUST_MAX_DURATION_MIN: String(MAX_DUR_MIN) };
    if (DRY_RUN) env.DUST_DRY_RUN = '1';
    log(`下载${DRY_RUN ? '（DRY RUN）' : ''}，并发 ${CONCURRENCY} ...`);
    const dl = await new Promise(res => {
      const p = spawn('node', [join(SCRIPTS, 'download.mjs'), todoFile, String(CONCURRENCY)],
        { stdio: ['ignore', 'pipe', 'pipe'], env });
      let out = '';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => log('   ' + l.replace(/^>>\s*/, ''))));
      p.on('close', code => { if (out.trim()) { try { writeFileSync(resultFile, out); } catch {} } res({ code, out }); });
    });
    if (dl.code !== 0) die(1, `下载失败（退出码 ${dl.code}）`);
    try { result = JSON.parse(dl.out); } catch {}
  } else {
    log('没有需要下载的，跳过下载');
  }
  const sum = result.summary || {};

  if (!DRY_RUN && result.results) {
    const imp = importDownload(result.results);
    log(`账本：更新 ${imp.touched} 条${imp.bumped ? `，${imp.bumped} 条计入失败重试` : ''}`);
  }

  // ④ 收尾：磁盘告警 + 清理超期运行记录
  const after = freeGB(MEDIA);
  if (after !== null && after < MIN_FREE_GB) {
    log(`⚠️ 目标盘仅剩 ${after.toFixed(1)} GB，低于阈值 ${MIN_FREE_GB} GB`);
    notify('dustoff 磁盘告警', `${MEDIA} 仅剩 ${after.toFixed(1)} GB`);
  }
  const pruned = stage.pruneRuns();
  if (pruned) log(`清理了 ${pruned} 份超过 ${KEEP_RUNS} 天的运行记录`);

  const parts = Object.entries(sum).map(([k, v]) => `${k} ${v}`).join(' · ');
  log(`完成：${parts || '无变化'}　落盘 ${((result.bytes || 0) / 1024 / 1024).toFixed(1)} MB　用时 ${result.elapsed_s || 0}s`);
  log(`记录 ${runDir}`);

  // 明确交接给第二段。两段是独立入口，衔接点是账本——
  // 这里把待办数量说出来，免得「跑完了但没转写」这件事悄无声息。
  if (!DRY_RUN) {
    try {
      const st = stats('douyin');
      const pending = (st.byStatus || []).find(r => r.status === 'downloaded');
      if (pending && pending.n) {
        log(`\n第二段待转写 ${pending.n} 条 → node ${join(__dirname, 'extract.mjs')}`);
      }
    } catch {}
  }

  if (sum.failed) log(`⚠️ ${sum.failed} 条全部 CDN 地址失败，可稍后重试：node sync.mjs --resume ${runId}`);
  if (sum.skipped_expired) log(`⚠️ ${sum.skipped_expired} 条地址已过期，需要重新扫描`);
  if (sum.skipped_too_long) {
    log(`ℹ️ ${sum.skipped_too_long} 条超过 ${MAX_DUR_MIN} 分钟被拦下（明细见 ${resultFile}）`);
    log(`   想要其中某条：node scripts/fetch.mjs '<链接>'　或临时放开：DUST_MAX_DURATION_MIN=0 node sync.mjs`);
  }

  releaseLock();
  process.exit(0);
})().catch(e => die(1, e.stack || e.message));
