#!/usr/bin/env node
// dustoff / run.mjs
// 日常增量：扫一次收藏夹，然后**逐条串行**走完 下载 → 转写 → 提炼。
//
// 跟三个独立入口的关系：
//   sync / extract / notes 一个字没改，仍然各自可以单独跑。
//   这里只是换了个编排方式，把它们的单条流程按条串起来。
//   共用的还是同一本账本、同一套状态机、同一批函数——不是第二套实现。
//
// 为什么日常增量用串行，而不是分三段各自并发：
//   一天约 20 条，串行约 4 分钟，分段并发约 2 分钟。差两分钟，发生在凌晨没人等。
//   而串行白送四样东西：
//     ① 限流彻底不用管（并发 1 = 最多 1 QPS）。三个并发上限至今没人测过，
//        串行就不需要知道。
//     ② ffmpeg 是 spawnSync，会阻塞事件循环——并发 1 时没有别的东西在等，
//        这个缺陷退化成实现细节。
//     ③ 止损闸变精确：并发跑时数到第 3 个失败，前面若干条其实已经发出去了；
//        串行下「连续 3 条」是真的连续，几乎必然是系统性故障。
//     ④ 日志是一条线性叙事，凌晨出问题时不用在交错的日志里拼时序。
//
// 为什么存量补录**不能**用这个：
//   CDN 签名地址有效期 3~24 小时，而 5831 条 × 约 24 秒 = 39 小时，
//   跑到一半地址就全过期了。存量必须「趁地址新鲜批量下完，再慢慢转写提炼」——
//   也就是分段的形状。所以两种编排都要留着，它们服务的是两件不同的事。
//
// 用法:
//   node run.mjs                  扫描 + 逐条跑完三段
//   node run.mjs --limit 5        本轮最多处理 5 条
//   node run.mjs --no-scan        跳过扫描，直接消化账本里已有的待办
//   node run.mjs --dry-run        只报计划，不下载不调 API
//   node run.mjs --scan 400       本轮扫多少条
//   node run.mjs --skip-notes     只做到转写为止（提炼指令还在改的时候用）
//
// 退出码见 stage.mjs 的约定（0 正常 / 1 出错 / 3 已在跑 / 4 登录失效 / 5 磁盘 / 6 缺配置）。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { makeCfg, DUST_HOME, CONF_FILE, expand } from './scripts/config.mjs';
import {
  importScan, importDownload, pendingAmong, reconcile, db,
  markTranscribed, markExtracted, markSkipped, markFailed, stats,
} from './scripts/ledger.mjs';
import { createStage, freeGB, EXIT } from './scripts/stage.mjs';

// 从两个入口 import 单条流程。它们用 IS_MAIN 守住了自己的 main()，
// 被 import 时不会自己跑起来，也不建自己的运行记录目录。
import {
  transcribeOne, archiveMedia, backupText, cleanMedia,
  PermanentError as AsrPermanentError, CONF as EXTRACT_CONF,
} from './extract.mjs';
import {
  noteOne, writeNote, HASH,
  PermanentError as LlmPermanentError, CONF as NOTES_CONF,
} from './notes.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), 'scripts');

// ── 参数与配置 ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN    = has('--dry-run');
const NO_SCAN    = has('--no-scan');
const SKIP_NOTES = has('--skip-notes');
const LIMIT      = Number(valOf('--limit') || 0);

const cfg = makeCfg();
const MEDIA        = expand(cfg('DUST_MEDIA', join(DUST_HOME, 'media')));
const SCAN_COUNT   = Number(valOf('--scan') || cfg('DUST_SCAN_COUNT', 200));
const MAX_DUR_MIN  = Number(cfg('DUST_MAX_DURATION_MIN', 10));
const MIN_FREE_GB  = Number(cfg('DUST_MIN_FREE_GB', 5));
const KEEP_RUNS    = Number(cfg('DUST_KEEP_RUNS', 30));
const NOTIFY       = cfg('DUST_NOTIFY', '1') !== '0';
const FLAG         = join(DUST_HOME, 'NEEDS_LOGIN');

// 连续几条**整条链路**失败就中止。默认 3：串行下「连续」是真的连续，
// 三条都栽了基本可以断定是系统性的（key 失效 / 余额耗尽 / 网络断），
// 继续跑只是把剩下的挨个撞一遍。
const MAX_CONSECUTIVE_FAILS = Number(cfg('DUST_RUN_MAX_FAILS', 3));

const stage = createStage({
  name: 'run', dustHome: DUST_HOME,
  notify: NOTIFY, keepRuns: KEEP_RUNS, record: !DRY_RUN,
});
const { log, die, notify, runId, runDir } = stage;

// ── 锁 ────────────────────────────────────────────────────────────
/**
 * 这一轮同时扮演三个阶段，所以要把三把锁**都**攥住。
 *
 * 不这么做的话，`node run.mjs` 跑着的时候 `node extract.mjs` 照样能起来，
 * 两边会捞到同一批 transcribed 条目，对同一条视频付两次 ASR 的钱。
 * 账本的 WAL 能保证不写坏，但保证不了不重复花钱。
 */
const subStages = ['collect', 'extract', 'notes'].map(name =>
  createStage({ name, dustHome: DUST_HOME, notify: false, record: false }));

function acquireAll() {
  stage.acquireLock();
  for (const s of subStages) s.acquireLock();
}

// ── 小工具 ────────────────────────────────────────────────────────
const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${s.toFixed(1)}秒`;

/** 跑一个 scripts/ 下的脚本，stderr 转成本轮日志。 */
function spawnScript(script, args, { env = {}, stdoutTo = null } = {}) {
  return new Promise(res => {
    const p = spawn('node', [join(SCRIPTS, script), ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d =>
      String(d).split('\n').filter(Boolean).forEach(l => log('     ' + l.replace(/^>>\s*/, ''))));
    p.on('close', code => {
      if (stdoutTo && out.trim()) { try { writeFileSync(stdoutTo, out); } catch {} }
      res({ code, out });
    });
  });
}

/** 从账本重新读一条。每走完一步都要重读——上一步刚写进去的字段这一步要用。 */
const fresh = id => db().prepare('SELECT * FROM items WHERE platform = ? AND id = ?').get('douyin', id);

// ── 单条：下载 ────────────────────────────────────────────────────
/**
 * 一次只下一条，并发 1。
 *
 * 走的还是 download.mjs（四重校验、多 CDN 兜底、挑带音轨的档全在里面），
 * 只是喂给它一个单条的清单。重写一个「单条下载器」意味着那四重校验要么
 * 复制一遍要么退化，不划算。
 */
async function downloadOne(item, tmpRoot) {
  const todo = join(tmpRoot, `${item.aweme_id}.json`);
  writeFileSync(todo, JSON.stringify({ items: [item] }));
  const r = await spawnScript('download.mjs', [todo, '1'], {
    env: {
      DUST_MEDIA: MEDIA,
      DUST_MAX_DURATION_MIN: String(MAX_DUR_MIN),
      ...(DRY_RUN ? { DUST_DRY_RUN: '1' } : {}),
    },
  });
  if (r.code !== 0) throw new Error(`下载器退出码 ${r.code}`);
  let parsed = {};
  try { parsed = JSON.parse(r.out); } catch { throw new Error('下载器没给出可解析的结果'); }
  const one = (parsed.results || [])[0];
  if (!one) throw new Error('下载器没有返回这一条的结果');
  if (!DRY_RUN) importDownload([one]);
  return one;
}

// ── 单条：整条链路 ────────────────────────────────────────────────
/**
 * 一条视频从收藏项走到笔记。
 *
 * 每一步都**立刻写账本**，不攒到最后。所以任何时刻断电／崩溃，
 * 账本里的 status 都精确指出它走到了哪一步，下一轮从那儿接着走——
 * 「串行流式」和「分三段」在可恢复性上是等价的，靠的就是这个。
 *
 * @returns {{outcome:'note'|'ocr'|'skipped'|'text-only', detail:string}}
 */
async function chainOne(item, tmpRoot) {
  const id = item.aweme_id;
  let row = fresh(id);

  // ① 下载。已经是 downloaded/transcribed 的直接跳过这一步——
  // 昨天下到一半断了、或者 --no-scan 消化积压时，就是从链路中间接着走。
  if (!row || row.status === 'pending') {
    const dl = await downloadOne(item, tmpRoot);
    if (dl.status && dl.status.startsWith('skipped')) {
      return { outcome: 'skipped', detail: `下载阶段跳过（${dl.status.replace('skipped_', '')}）` };
    }
    if (dl.status === 'failed') throw new Error(dl.error || '下载失败');
    row = fresh(id);
    if (!row) throw new Error('下载后账本里找不到这一条');
  }

  // ② 转写
  if (row.status === 'downloaded') {
    const t = await transcribeOne(row, tmpRoot);
    markTranscribed(id, {
      text_source: 'asr', text_chars: t.chars,
      text_path: t.textPath, audio_seconds: t.seconds,
    });
    if (SKIP_NOTES) return { outcome: 'text-only', detail: `${t.chars} 字` };
    row = fresh(id);
  } else if (SKIP_NOTES) {
    return { outcome: 'text-only', detail: '已有转写稿' };
  }

  // ③ 提炼
  const n = await noteOne(row);
  if (n.skipped) {
    markSkipped(id, n.reason, { needsOcr: true });
    return { outcome: 'ocr', detail: n.why };
  }
  const w = writeNote(row, n.note, { dir: NOTES_CONF.NOTES_DIR });
  markExtracted(id, {
    text_source: 'asr', text_chars: row.text_chars, keyframes: row.keyframes,
    note_path: w.file, category: n.note.分类 || null, decay: w.decay,
    needs_ocr: n.needsOcr, prompt_hash: HASH,
  });
  return {
    outcome: 'note',
    detail: `「${n.note.标题}」${n.note.分类}/${w.decay}` +
            `${n.needsOcr ? ' ⚠️缺料' : ''}，¥${(n.usage?.yuan ?? 0).toFixed(4)}`,
    yuan: n.usage?.yuan ?? 0,
  };
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  if (!SKIP_NOTES && !NOTES_CONF.API_KEY && !DRY_RUN) {
    die(EXIT.CONFIG, `未配置 DUST_LLM_KEY（写进 ${CONF_FILE}），或加 --skip-notes 只做到转写`);
  }
  acquireAll();

  log(`dustoff 一趟跑完　run=${runId}`);
  log(`配置文件 ${existsSync(CONF_FILE) ? CONF_FILE : '（未找到，用内置默认值）'}`);
  log(`媒体 ${MEDIA}`);
  if (!SKIP_NOTES) log(`笔记 ${NOTES_CONF.NOTES_DIR}　模型 ${NOTES_CONF.MODEL} · effort ${NOTES_CONF.EFFORT} · 指令版本 ${HASH}`);

  // 目标盘可写性。跟 sync.mjs 同样的硬失败——静默落回本机会灌满系统盘。
  try {
    mkdirSync(MEDIA, { recursive: true });
    const probe = join(MEDIA, '.write_probe');
    writeFileSync(probe, ''); unlinkSync(probe);
  } catch (e) {
    notify('dustoff 无法开始', `媒体目录不可写：${MEDIA}`);
    die(EXIT.DISK, `媒体目录不可写：${MEDIA}（${e.message}）`);
  }
  const before = freeGB(MEDIA);
  if (before !== null) log(`本机剩余 ${before.toFixed(1)} GB`);

  // ── ① 扫描一次，拿到今天的待办清单 ──
  let candidates = [];
  if (NO_SCAN) {
    log('--no-scan，跳过扫描，直接消化账本里的待办');
    // 只捞 downloaded / transcribed，**不捞 pending**：
    // pending 缺的是播放地址，而 CDN 地址不进账本（带签名、3~24 小时就过期），
    // 不重新扫描根本下不了。捞进来只会白撞一轮然后误标成 skipped_no_url。
    candidates = db().prepare(
      `SELECT * FROM items WHERE platform = 'douyin' AND status IN ('downloaded','transcribed')
         AND attempts < ? ORDER BY first_seen DESC`).all(EXTRACT_CONF.MAX_ATTEMPTS)
      .map(r => ({ aweme_id: r.id, desc: r.title, author: r.author }));
  } else {
    log(`扫描收藏夹，最多 ${SCAN_COUNT} 条 ...`);
    // --dry-run 不建运行记录目录，所以 coll.json 得另找地方落，
    // 否则下面的 existsSync 判死在一个根本没打算创建的路径上。
    const collFile = stage.ensureDir()
      ? join(runDir, 'coll.json')
      : join(tmpdir(), `dustoff-coll-${process.pid}.json`);
    const r = await spawnScript('get_collection.mjs', [String(SCAN_COUNT)], { stdoutTo: collFile });
    if (r.code === 4) {
      notify('dustoff 登录已失效', '收藏夹同步已停止，需要重新扫码');
      die(EXIT.LOGIN, `登录态失效。请运行：node ${join(SCRIPTS, 'login.mjs')}\n     标记文件：${FLAG}`);
    }
    if (r.code !== 0) die(EXIT.ERROR, `扫描失败（退出码 ${r.code}）`);
    if (!existsSync(collFile)) die(EXIT.ERROR, '扫描没有产出 coll.json');

    const coll = JSON.parse(readFileSync(collFile, 'utf8'));
    log(`扫到 ${coll.count} 条${coll.truncated ? '（还有更多未取）' : ''}`);

    if (!DRY_RUN) {
      const imp = importScan(coll.items || []);
      log(`账本：新增 ${imp.added} 条（本次见到 ${imp.seen} 条）`);
      // 对账只在真翻到底时做。日常增量只覆盖最新若干条，
      // 拿它对账会把其余条目全部误判成已取消收藏。
      if (coll.truncated === false) {
        try {
          const rec = reconcile((coll.items || []).map(i => i.aweme_id), { scanComplete: true });
          if (rec.removed) log(`账本：${rec.removed} 条已从收藏夹移除`);
        } catch (e) {
          log(`⚠️ 对账被拒绝，本轮跳过：${String(e.message).split('\n')[0]}`);
        }
      }
    }

    const items = coll.items || [];
    const keep = pendingAmong(items.map(i => i.aweme_id), { includeUnknown: DRY_RUN });
    candidates = items.filter(i => keep.has(i.aweme_id));
    log(`账本筛选：${candidates.length} 条待处理，剔除 ${items.length - candidates.length} 条（已处理 / 已跳过 / 已放弃）`);
  }

  if (LIMIT && candidates.length > LIMIT) {
    log(`--limit ${LIMIT}，本轮只处理前 ${LIMIT} 条`);
    candidates = candidates.slice(0, LIMIT);
  }

  // ── ② 逐条串行 ──
  const stat = { note: 0, ocr: 0, skipped: 0, text: 0, fail: 0, yuan: 0 };
  const failures = [];
  let consecutiveFails = 0;
  let aborted = false;

  if (!candidates.length) {
    log('没有待处理的条目');
  } else if (DRY_RUN) {
    log(`\n--dry-run，不下载不调 API。计划逐条处理 ${candidates.length} 条：`);
    for (const i of candidates.slice(0, 20)) {
      log(`  ${i.aweme_id}  ${String(i.desc || '').replace(/\s+/g, ' ').slice(0, 40)}`);
    }
    if (candidates.length > 20) log(`  …… 还有 ${candidates.length - 20} 条`);
  } else {
    const tmpRoot = join(tmpdir(), `dustoff-run-${process.pid}`);
    mkdirSync(tmpRoot, { recursive: true });
    log(`\n逐条处理 ${candidates.length} 条（串行，下载 → 转写 → 提炼）`);
    const tAll = Date.now();

    try {
      for (const [idx, item] of candidates.entries()) {
        if (aborted) break;
        const id = item.aweme_id;
        const label = `[${idx + 1}/${candidates.length}] ${id} ${String(item.desc || '').replace(/\s+/g, ' ').slice(0, 24)}`;
        const t0 = Date.now();
        try {
          const r = await chainOne(item, tmpRoot);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          consecutiveFails = 0;
          if (r.outcome === 'note')      { stat.note++; stat.yuan += r.yuan || 0; log(`  ✓ ${label} — ${r.detail}，${secs}s`); }
          else if (r.outcome === 'ocr')  { stat.ocr++;  log(`  ⊘ ${label} — ${r.detail}`); }
          else if (r.outcome === 'text-only') { stat.text++; log(`  ✓ ${label} — 转写完成 ${r.detail}（--skip-notes）`); }
          else                           { stat.skipped++; log(`  ⊘ ${label} — ${r.detail}`); }
        } catch (e) {
          stat.fail++;
          failures.push({ id, title: item.desc, error: e.message });
          // 单条的问题（地址死了 / 没音轨 / 转写稿不在）重试没意义，一次就放弃；
          // 其余的留着重试次数，明天那轮还会捞回来。
          const permanent = e instanceof AsrPermanentError || e instanceof LlmPermanentError;
          const res = markFailed(id, e.message, 'douyin',
            permanent ? 1 : Math.max(EXTRACT_CONF.MAX_ATTEMPTS, NOTES_CONF.MAX_ATTEMPTS));
          log(`  ✗ ${label} — ${e.message}${res?.gaveUp ? '（已放弃）' : ''}`);
          if (++consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
            aborted = true;
            log(`\n连续 ${consecutiveFails} 条失败，中止本轮。`);
            log(`串行下「连续」是真的连续，这几乎必然是系统性故障——先查 key、余额、网络。`);
          }
        }
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    log(`\n处理完成，用时 ${fmtDur((Date.now() - tAll) / 1000)}`);
    log(`成稿 ${stat.note} 篇 · 缺料 ${stat.ocr} 条 · 跳过 ${stat.skipped} 条` +
        `${stat.text ? ` · 只转写 ${stat.text} 条` : ''} · 失败 ${stat.fail} 条`);
    if (stat.yuan) log(`提炼花费 ¥${stat.yuan.toFixed(4)}`);
  }

  // ── ③ 收尾：归档 → 备份 → 清理。跑一次，不是每条跑一次 ──
  //
  // 顺序不能反：先把能搬走的搬走，剩下的才轮到保留期判死刑。
  // 反了的话，插盘那天正好有条目到了第 7 天，会被删在搬走之前。
  if (!DRY_RUN) {
    log('');
    // 每一步都出声，包括「没事可做」。不说的话分不清「跑了且是最新的」
    // 和「根本没跑」——这两件事的后果差很远。
    if (EXTRACT_CONF.ARCHIVE_DIR) {
      const a = archiveMedia({ dryRun: false });
      if (a.n) log(`归档 ${a.n} 个视频到外接盘（${(a.bytes / 1048576).toFixed(1)} MB）`);
      else if (a.skipped) log('归档：外接盘没挂载，跳过（下次插上会把欠的一起补）');
      else log('归档：没有可搬的');
    }
    const b = backupText({ dryRun: false });
    if (b?.n) log(`备份 ${b.n} 份转写稿到外接盘`);
    else if (b?.skipped) log('备份：外接盘没挂载，跳过');
    else log('备份：外接盘已是最新');
    const c = cleanMedia({ keepDays: EXTRACT_CONF.KEEP_DAYS, dryRun: false });
    if (c?.n) log(`清理 ${c.n} 个超过 ${EXTRACT_CONF.KEEP_DAYS} 天的本地视频`);
  }

  const after = freeGB(MEDIA);
  if (after !== null && after < MIN_FREE_GB) {
    log(`⚠️ 本机仅剩 ${after.toFixed(1)} GB，低于阈值 ${MIN_FREE_GB} GB`);
    notify('dustoff 磁盘告警', `${MEDIA} 仅剩 ${after.toFixed(1)} GB`);
  }

  if (!DRY_RUN) {
    try {
      const st = stats();
      log('');
      for (const r of st.byStatus || []) log(`  ${r.status.padEnd(12)} ${r.n}`);
    } catch {}
    if (stage.ensureDir()) {
      try {
        writeFileSync(join(runDir, 'result.json'),
          JSON.stringify({ runId, counts: stat, failures, aborted }, null, 2));
      } catch {}
    }
    const pruned = stage.pruneRuns();
    if (pruned) log(`清理了 ${pruned} 份超过 ${KEEP_RUNS} 天的运行记录`);
    log(`记录 ${runDir}`);
  }

  // 中止是硬故障，必须让定时器看见。
  if (aborted) {
    notify('dustoff 本轮中止', `连续 ${MAX_CONSECUTIVE_FAILS} 条失败，多半是 key 失效或余额不足`);
    process.exit(EXIT.ERROR);
  }
  if (stat.fail) notify('dustoff 有失败条目', `${stat.fail} 条失败，${stat.note} 篇成稿`);
  process.exit(EXIT.OK);
}

main().catch(e => die(EXIT.ERROR, e.stack || e.message));
