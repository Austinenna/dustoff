#!/usr/bin/env node
// dustoff / extract.mjs
// 第二段的前半截：把视频里的话转成文字（ASR）。
//
// 只做转写，不写笔记。转写是机器活、结果稳定；写笔记要靠 prompt，
// 还没定稿。分开之后改 prompt 重跑不用为转写重复付一次钱。
//
// 为什么必须先下 mp4 再转：抖音不提供纯音频流，也没有字幕轨，
// 拿到声音的唯一途径就是从视频里剥。
//
// 它是跟 sync.mjs 平级的独立阶段，不由 sync.mjs 调用——两段只通过账本对话。
// 手动跑全链路就是依次跑这两条命令；以后两个定时器跑的也是同样这两条。
//
// 用法:
//   node extract.mjs                 转所有 downloaded 的
//   node extract.mjs --limit 5        只转 5 条（先试水用这个）
//   node extract.mjs --id 7676...     指定一条
//   node extract.mjs --dry-run        只列计划和音频总时长，不调 API
//   node extract.mjs --force          已转过的也重转
//   node extract.mjs --clean-only     只清理过期 mp4，不转写
//   node extract.mjs --keep-days 0    临时改保留期（默认 7 天）
//   node extract.mjs --clean-only --clean-limit 1   小步试删
//   node extract.mjs --archive-only   只把已转写的 mp4 搬到外接盘，不转写
//   node extract.mjs --archive-to /Volumes/X/dir    临时指定归档目录
//   node extract.mjs --backup-only    只把转写稿备份到外接盘，不转写
//
// 退出码见 stage.mjs 的约定（0 正常 / 1 出错 / 3 已在跑 / 5 磁盘 / 6 缺配置）。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { makeCfg, DUST_HOME, CONF_FILE, expand } from './scripts/config.mjs';
import { claim, markTranscribed, markFailed, markMediaDeleted, cleanable,
         archivable, setMediaPath, db } from './scripts/ledger.mjs';
import { createStage, freeGB, EXIT } from './scripts/stage.mjs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN = has('--dry-run');
const CLEAN_ONLY = has('--clean-only');
const FORCE   = has('--force');
const ONLY_ID = valOf('--id');
const LIMIT   = Number(valOf('--limit') || 0);

const cfg = makeCfg();
const API_KEY     = cfg('DUST_DASHSCOPE_KEY', '');
const MODEL       = cfg('DUST_ASR_MODEL', 'qwen-audio-3.0-asr-flash');
const LANG        = cfg('DUST_ASR_LANG', 'zh');
const CONCURRENCY = Number(cfg('DUST_ASR_CONCURRENCY', 2));
const MAX_ATTEMPTS = Number(cfg('DUST_MAX_ATTEMPTS', 3));
const TEXT_DIR    = cfg('DUST_TEXT', join(DUST_HOME, 'text'));
const KEEP_DAYS   = Number(valOf('--keep-days') ?? cfg('DUST_MEDIA_KEEP_DAYS', 7));
// 一轮最多删多少条。首次放开保留期时用它小步试，别一把删几千个目录。
const CLEAN_LIMIT = Number(valOf('--clean-limit') || 1000);

// 归档：转写完的 mp4 搬到外接盘，从此不再被保留期清理。
// 留空 = 不启用，行为跟以前完全一样。
const MEDIA_DIR   = expand(cfg('DUST_MEDIA', join(DUST_HOME, 'media')));
const ARCHIVE_DIR = expand(valOf('--archive-to') || cfg('DUST_MEDIA_ARCHIVE', ''));
const ARCHIVE_ONLY = has('--archive-only');

// 转写稿备份到外接盘。跟归档共用挂载点判断，但**是复制不是移动**——
// 本地那份第三段每次提炼都要读，不能搬走。
const TEXT_BACKUP  = expand(valOf('--backup-to') || cfg('DUST_TEXT_BACKUP', ''));
const BACKUP_ONLY  = has('--backup-only');

// 领域热词。qwen3-asr 支持拿一段上下文去偏置识别，这是它相对
// fun-asr / paraformer 的主要优势——收藏夹的词汇面是稳定的
// （AI 工具名、游戏术语、摄影术语），喂进去就能显著少认错专名。
// 实测：不给热词认成 "cloud code"，给了就是 "Claude Code"。
// 词表会越攒越长，所以除了配置项还支持放在单独文件里。
const CTX_FILE = cfg('DUST_ASR_CONTEXT_FILE', join(DUST_HOME, 'asr-context.txt'));
const CONTEXT = cfg('DUST_ASR_CONTEXT', '') ||
  (existsSync(CTX_FILE) ? readFileSync(CTX_FILE, 'utf8').trim() : '');

// 单次请求的音频上限。实测边界：299 秒过，300 秒返回
// "The audio is too long"。audio_tokens 恰好 25/秒，即 7500 token 封顶。
// 留 10 秒余量，防止 mp3 帧对齐导致实际时长比切片参数多零点几秒。
const CHUNK_MAX = 290;
// 切片时最早可以在哪儿下刀。太早会切出一堆碎片，多花请求数。
const CHUNK_MIN = 150;

// 连续失败这么多条就整轮中止。无人值守时的止损闸——
// 余额耗尽或 key 失效会让每一条都失败，没有这道闸就会把剩下几千条挨个撞一遍。
const MAX_CONSECUTIVE_FAILS = Number(cfg('DUST_ASR_MAX_FAILS', 5));

const NOTIFY   = cfg('DUST_NOTIFY', '1') !== '0';
const KEEP_RUNS = Number(cfg('DUST_KEEP_RUNS', 30));

// 只有 --dry-run 是纯探查（不调 API、不写账本），可以不抢锁不留记录。
// --id 会真花钱，必须跟正常跑法一样受锁保护——否则它能绕过锁，
// 跟一个正在跑的整轮撞上同一条，白付两次。
const CASUAL = DRY_RUN;
const stage = createStage({
  name: 'extract', dustHome: DUST_HOME,
  notify: NOTIFY, keepRuns: KEEP_RUNS, record: !CASUAL,
});
const { log, die, notify } = stage;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtMB = b => b >= 1024 * 1024 * 1024
  ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒` : `${Math.round(s)}秒`;

// ── 音频处理 ──────────────────────────────────────────────────────

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number((r.stdout || '').trim()) || 0;
}

/**
 * 剥出音频。16kHz 单声道 32kbps mp3——ASR 模型内部就按 16k 单声道处理，
 * 给更高规格只是把上传变大。实测 9.6 分钟压出来 2.5 MB。
 */
function extractAudio(mp4, out) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', out],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 剥音频失败: ${(r.stderr || '').trim().slice(0, 200)}`);
  if (!existsSync(out) || statSync(out).size < 1024) throw new Error('剥出的音频为空');
}

/** 找出静音段的中点，作为候选下刀位置。 */
function silenceMidpoints(file) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file,
    '-af', 'silencedetect=noise=-32dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = (r.stderr || '') + (r.stdout || '');
  const mids = [];
  let start = null;
  for (const m of out.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === 'start') start = Number(m[2]);
    else if (start !== null) { mids.push((start + Number(m[2])) / 2); start = null; }
  }
  return mids.sort((a, b) => a - b);
}

/**
 * 把时长切成每段 < CHUNK_MAX 的区间。
 * 尽量把刀落在静音中点上，这样接缝处不会把一个词劈成两半；
 * 窗口内没有静音才硬切。
 */
function planChunks(dur, mids) {
  if (dur <= CHUNK_MAX) return [[0, dur]];
  const chunks = [];
  let start = 0;
  while (dur - start > CHUNK_MAX) {
    const lo = start + CHUNK_MIN, hi = start + CHUNK_MAX;
    const cand = mids.filter(t => t > lo && t <= hi);
    const cut = cand.length ? cand[cand.length - 1] : hi;
    chunks.push([start, cut]);
    start = cut;
  }
  chunks.push([start, dur]);
  return chunks;
}

function sliceAudio(src, out, start, end) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start),
    '-t', String(end - start), '-i', src, '-c', 'copy', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`切片失败: ${(r.stderr || '').trim().slice(0, 200)}`);
}

// ── ASR ──────────────────────────────────────────────────────────

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

// 同一个端点上的两族模型，请求和返回的形状都不一样。
// 隔在这里，换模型就只是改配置——paraformer 那次的教训是模型会过时，
// 下次再出新的不该动业务代码。
//
// 两族都走同步端点、都是 300 秒上限、热词都放 system 里，差别只有：
const DIALECTS = [
  {
    // qwen-audio-3.0 系（当前默认）。比 qwen3-asr 新一代，同价，
    // 且额外返回逐词时间戳——笔记里能标「这句在第几秒」。
    match: m => m.startsWith('qwen-audio-'),
    extraParams: { format: 'mp3' },          // 不传这个直接 UNSUPPORTED_FORMAT
    text: j => j.output?.text ?? '',
    seconds: j => j.usage?.duration ?? 0,
    words: j => {
      const s = j.output?.sentence;
      return (Array.isArray(s) ? s : [s]).flatMap(x => x?.words || []);
    },
  },
  {
    // qwen3-asr 系。没有时长戳，usage 字段名也不同。
    match: m => m.startsWith('qwen3-asr'),
    extraParams: {},
    text: j => j.output?.choices?.[0]?.message?.content?.[0]?.text ?? '',
    seconds: j => j.usage?.seconds ?? 0,
    words: () => [],
  },
];

const dialect = DIALECTS.find(d => d.match(MODEL)) || DIALECTS[0];

class PermanentError extends Error {}

/** 转写一个切片。返回 { text, seconds }。 */
async function asrOnce(file) {
  const b64 = readFileSync(file).toString('base64');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: {
        messages: [
          { role: 'system', content: [{ text: CONTEXT }] },
          { role: 'user', content: [{ audio: `data:audio/mp3;base64,${b64}` }] },
        ],
      },
      parameters: { ...dialect.extraParams, asr_options: { language: LANG, enable_itn: true } },
    }),
  });

  const body = await res.json().catch(() => ({}));

  // 「没识别到任何词」不是失败，是一个有效结论：这条没人声。
  // qwen3-asr 遇到这种情况返回 200 + 空文本，qwen-audio-3.0 却报 400。
  // 当成错误处理会有三个后果：白重试三次、状态错标成 failed，
  // 而且这类纯画面视频正是 OCR 增强要挑的目标（见 docs/待办-OCR增强.md），
  // 标成 failed 就再也进不了候选名单。
  if (res.status === 400 && /HAVE_NO_WORDS/i.test(`${body.code || ''} ${body.message || ''}`)) {
    return { text: '', seconds: 0, words: [] };
  }

  if (!res.ok) {
    const msg = `HTTP ${res.status} ${body.code || ''} ${body.message || ''}`.trim();
    // 其余 4xx 是请求本身的问题（参数错、音频超长、key 无效），重试无意义；
    // 429 例外——那是限流，等一等就好。
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentError(msg);
    throw new Error(msg);
  }

  return {
    text: String(dialect.text(body) ?? '').trim(),
    seconds: dialect.seconds(body) || 0,
    words: dialect.words(body) || [],
  };
}

/** 带退避重试。限流和 5xx 值得再试，参数错不值得。 */
async function asr(file, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await asrOnce(file);
    } catch (e) {
      if (e instanceof PermanentError) throw e;
      last = e;
      if (i < tries - 1) await sleep(2000 * 2 ** i);
    }
  }
  throw last;
}

// ── 单条流程 ──────────────────────────────────────────────────────

async function transcribeOne(item, tmpRoot) {
  const mp4 = item.media_path;
  if (!mp4 || !existsSync(mp4)) throw new PermanentError('媒体文件不存在（外接盘没挂载？）');
  if (item.has_audio === 0) throw new PermanentError('文件无音轨，需要重下');

  const work = join(tmpRoot, item.id);
  mkdirSync(work, { recursive: true });
  try {
    const audio = join(work, 'a.mp3');
    extractAudio(mp4, audio);
    const dur = probeDuration(audio);
    const chunks = planChunks(dur, dur > CHUNK_MAX ? silenceMidpoints(audio) : []);

    const parts = [];
    const words = [];
    let seconds = 0;
    for (const [i, [s, e]] of chunks.entries()) {
      let piece = audio;
      if (chunks.length > 1) {
        piece = join(work, `c${i}.mp3`);
        sliceAudio(audio, piece, s, e);
      }
      const r = await asr(piece);
      if (r.text) parts.push(r.text);
      // 切片的时间戳是相对片内的，得加回片头偏移，否则第二段会从 0 重新开始
      const off = Math.round(s * 1000);
      for (const w of r.words) {
        words.push({ t: (w.begin_time ?? 0) + off, e: (w.end_time ?? 0) + off, w: w.text || '' });
      }
      seconds += r.seconds || (e - s);
    }

    const text = parts.join('\n');
    mkdirSync(TEXT_DIR, { recursive: true });
    const textPath = join(TEXT_DIR, `${item.id}.txt`);
    // 转写稿保持纯文本：text_chars 才是诚实的字数，下游读它也不用剥格式
    writeFileSync(textPath, text, 'utf8');
    // 时间戳单独放边车文件。有了它，笔记里的每句话都能回指原片的秒数
    if (words.length) {
      writeFileSync(join(TEXT_DIR, `${item.id}.words.json`), JSON.stringify(words), 'utf8');
    }

    return { text, textPath, chars: text.length, chunks: chunks.length,
             seconds: Math.round(seconds), words: words.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── 归档到外接盘 ──────────────────────────────────────────────────

/**
 * 确认某个目录真的落在另一块挂载的盘上。
 *
 * **不能用 existsSync 判断「盘插没插」。** macOS 上外接盘没挂载时，
 * `mkdir -p /Volumes/T7/xxx` 会在**启动盘**上真的建出这个目录；程序会兴高采烈
 * 地把 mp4「移到外接盘」，实际全写进了内置盘，而等 T7 真插上时系统会把它挂到
 * `/Volumes/T7 1`，文件就永远留在那个假目录里。内置盘只剩 11 GB，这么塞会塞爆。
 *
 * 正确的判断是比设备号：往上找到第一个真实存在的祖先目录，
 * 它的 dev 必须跟 `/` 的不同——不同才说明那是另一块挂载的盘。
 *
 * @returns {string|null} 可用就返回归档根目录，否则 null
 */
function mountedDir(dir) {
  if (!dir) return null;
  const rootDev = statSync('/').dev;
  let probe = dir;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
  if (statSync(probe).dev === rootDev) return null;   // 就在启动盘上，说明盘没挂载
  mkdirSync(dir, { recursive: true });                // 到这一步才敢建目录
  return dir;
}

/**
 * 把已转写、还留在本地的 mp4 搬到外接盘。
 *
 * **每轮全量扫，不只搬本轮刚转的。** 外接盘拔了几天，插回来的那一轮会把
 * 这几天欠的一起补上——不会有视频因为「归档那天盘没插」而在 7 天后被删掉。
 *
 * 跨盘搬不是原子操作（exFAT 更没有原子重命名），所以是「复制 → 核对大小 → 删原件」。
 * 中途出任何岔子都只留在本地，宁可没搬走，不能搬丢。
 */
/**
 * 目录里的文件数和总字节，用来核对跨盘复制有没有丢东西。
 *
 * 跳过 macOS 的元数据伴生文件。exFAT 不支持扩展属性，所以 macOS 往上面写东西时
 * 会给每个文件额外配一个 `._xxx`（实测每个 4 KB）——它们是复制的副产品不是内容，
 * 算进来的话源和目标永远对不上。
 */
function dirStat(dir) {
  let files = 0, bytes = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.name.startsWith('._') || f.name === '.DS_Store') continue;
    if (f.isDirectory()) { const d = dirStat(join(dir, f.name)); files += d.files; bytes += d.bytes; }
    else { files++; bytes += statSync(join(dir, f.name)).size; }
  }
  return { files, bytes };
}

function archiveMedia({ dryRun }) {
  const root = mountedDir(ARCHIVE_DIR);
  if (!root) return { n: 0, bytes: 0, skipped: !!ARCHIVE_DIR };

  const rows = archivable(MEDIA_DIR);
  let n = 0, bytes = 0, failed = 0;
  for (const r of rows) {
    const src = dirname(r.media_path);
    const dst = join(root, basename(src));
    const dstFile = join(dst, basename(r.media_path));
    if (dryRun) { n++; bytes += r.media_bytes || 0; continue; }
    try {
      if (!existsSync(src)) continue;                 // 本地已经没了，跳过
      cpSync(src, dst, { recursive: true, force: true });

      // 核对**整个目录**（文件数 + 总字节），不是只看账本记的那个文件名。
      // 账本里的 media_path 可能本身就是错的——实测有一条记着 video.mp4、
      // 磁盘上却叫 ' .mp4'（早期版本留下的）。按记录去核对的话，这种条目
      // 永远搬不走；按目录核对才问的是「东西是不是完整到了对面」。
      const a = dirStat(src), b = dirStat(dst);
      if (a.files !== b.files || a.bytes !== b.bytes) {
        throw new Error(`复制后对不上（源 ${a.files} 个/${a.bytes} 字节，目标 ${b.files} 个/${b.bytes} 字节）`);
      }

      // 目标里究竟叫什么，以磁盘为准：账本记的名字在就用它，不在就认目录里
      // 唯一的那个视频文件，并把账本修正过来。磁盘是事实，账本跟着事实走。
      let finalPath = dstFile;
      if (!existsSync(finalPath)) {
        const vids = readdirSync(dst).filter(f => !f.startsWith('._') && /\.(mp4|mov|webm|m4v)$/i.test(f));
        if (vids.length !== 1) throw new Error(`目标目录里找不到唯一的视频文件（${vids.length} 个）`);
        finalPath = join(dst, vids[0]);
        log(`  · 顺带修正账本路径 ${r.id}：${basename(dstFile)} → ${vids[0]}`);
      }

      rmSync(src, { recursive: true, force: true });
      setMediaPath(r.id, finalPath);
      n++; bytes += r.media_bytes || 0;
    } catch (e) {
      failed++;
      log(`  ✗ 归档失败 ${r.id}: ${e.message}（原件保留在本地）`);
    }
  }
  return { n, bytes, failed, root };
}

// ── 转写稿备份 ────────────────────────────────────────────────────

/**
 * 把转写稿复制一份到外接盘。**是复制不是移动**——本地那份必须留着，
 * 第三段每次提炼都要读它。
 *
 * 为什么单独做这一遍：转写稿一年只有 35 MB，却是整条链路里唯一
 * **花钱买来、丢了要重新掏钱**的东西（全量重转约 ¥109）；
 * 而 mp4 一年 16.5 GB 却是可再生的（视频还在抖音上）。
 * 保护力度跟体积正好该反过来。
 *
 * **只增不删。** 本地删掉的，外接盘上那份不跟着删——跟着删就不叫备份了。
 * 一年 35 MB，留几个孤儿无所谓。
 *
 * 跟归档一样每轮全量扫：盘拔了几天，插回来的那一轮把欠的一起补上。
 */
function backupText({ dryRun }) {
  const root = mountedDir(TEXT_BACKUP);
  if (!root) return { n: 0, bytes: 0, skipped: !!TEXT_BACKUP };
  if (!existsSync(TEXT_DIR)) return { n: 0, bytes: 0 };

  let n = 0, bytes = 0, failed = 0, same = 0;
  for (const f of readdirSync(TEXT_DIR)) {
    if (f.startsWith('.')) continue;
    const src = join(TEXT_DIR, f), dst = join(root, f);
    let size;
    try { const st = statSync(src); if (!st.isFile()) continue; size = st.size; } catch { continue; }
    // 已有一份且大小一致就跳过。转写稿写一次就不再改，比大小够用
    if (existsSync(dst)) { try { if (statSync(dst).size === size) { same++; continue; } } catch {} }
    if (dryRun) { n++; bytes += size; continue; }
    try {
      cpSync(src, dst, { force: true });
      if (!existsSync(dst) || statSync(dst).size !== size) throw new Error('复制后大小对不上');
      n++; bytes += size;
    } catch (e) { failed++; log(`  ✗ 备份失败 ${f}: ${e.message}`); }
  }
  return { n, bytes, failed, same, root };
}

// ── 清理已转写的 mp4 ──────────────────────────────────────────────

/**
 * 删掉过了保留期的 mp4。
 *
 * 两条安全规则，都是「宁可少删」：
 *
 *   ① 转写稿必须真的在磁盘上。账本说转过了不算数——万一 text 目录被误删，
 *      不该跟着把视频也删了，那就真的什么都不剩了。
 *   ② 0 字的不删。那些是 ASR 什么也没听到的纯画面视频，
 *      对它们来说视频本身仍是唯一的内容载体，而且正是 OCR 增强要挑的目标
 *      （见 docs/待办-OCR增强.md）。删了等于把原料丢了。
 */
function cleanMedia({ keepDays, dryRun, limit = 1000 }) {
  // 只清理还在工作媒体目录里的；搬到外接盘的已经不归保留期管
  const rows = cleanable('douyin', { keepDays, limit, underPath: MEDIA_DIR });
  if (!rows.length) return { n: 0, bytes: 0, held: 0 };

  const done = [];
  let bytes = 0, held = 0;
  for (const r of rows) {
    const row = db().prepare('SELECT text_path, text_chars FROM items WHERE id = ?').get(r.id);

    if (!row?.text_path || !existsSync(row.text_path)) { held++; continue; }   // 规则 ①
    if (!row.text_chars) { held++; continue; }                                 // 规则 ②

    if (!existsSync(r.media_path)) { done.push(r.id); continue; }  // 文件已不在，补记一笔
    if (dryRun) { bytes += r.media_bytes || 0; done.push(r.id); continue; }
    try {
      rmSync(dirname(r.media_path), { recursive: true, force: true });
      bytes += r.media_bytes || 0;
      done.push(r.id);
    } catch (e) {
      log(`  ✗ 删除失败 ${r.id}: ${e.message}`);
    }
  }
  if (!dryRun && done.length) markMediaDeleted(done);
  return { n: done.length, bytes, held };
}

// ── 主流程 ────────────────────────────────────────────────────────

/** 跑一次转写稿备份并把结果说清楚。转写前后各调一次。 */
function runBackup() {
  if (!TEXT_BACKUP) return;
  const bk = backupText({ dryRun: DRY_RUN });
  if (bk.skipped) {
    log(`转写稿备份跳过：${TEXT_BACKUP} 不在已挂载的外接盘上（盘没插？）——下次插上会把欠的一起补`);
  } else if (bk.n) {
    log(`转写稿备份：${bk.n} 个文件 → ${bk.root}，${fmtMB(bk.bytes)}` +
      (bk.same ? `（另有 ${bk.same} 个已是最新）` : '') +
      (bk.failed ? `，${bk.failed} 个失败` : '') + (DRY_RUN ? '（DRY RUN，未真备份）' : ''));
  } else if (bk.same) {
    // 「没事可做」也要说一声。不说的话你分不清「备份跑了且是最新的」
    // 和「备份根本没跑」——而这两件事的后果差很远。
    log(`转写稿备份：${bk.same} 个文件都已是最新 → ${bk.root}`);
  }
}

async function main() {
  if (!API_KEY && !DRY_RUN && !CLEAN_ONLY) {
    die(EXIT.CONFIG, `未配置 DUST_DASHSCOPE_KEY。写进 ${CONF_FILE}：DUST_DASHSCOPE_KEY=sk-xxxx`);
  }
  if (!CASUAL) {
    stage.acquireLock();
    log(`dustoff 提取　run=${stage.runId}`);
  }

  // 归档必须跑在清理之前：先把能搬走的搬走，剩下的才轮到保留期判死刑。
  // 顺序反了的话，插盘那天正好有条目到了第 7 天，会被删在搬走之前。
  if (ARCHIVE_DIR) {
    const ar = archiveMedia({ dryRun: DRY_RUN });
    if (ar.skipped) log(`归档跳过：${ARCHIVE_DIR} 不在已挂载的外接盘上（盘没插？）——mp4 留在本地，仍走 ${KEEP_DAYS} 天保留期`);
    else if (ar.n) log(`归档 mp4：${ar.n} 条搬到 ${ar.root}，${fmtMB(ar.bytes)}` +
      (ar.failed ? `，${ar.failed} 条失败（原件保留）` : '') + (DRY_RUN ? '（DRY RUN，未真搬）' : ''));
    else log(`归档：没有待搬的（本地已转写的 mp4 都搬完了）`);
  }
  if (ARCHIVE_ONLY) return;

  // 备份要跑两次：这里一次（把之前欠的补上），转写完再一次（把本轮新产的带上）。
  // 只在结尾跑的话，本轮转写失败就连之前欠的也一起没备份成。
  runBackup();
  if (BACKUP_ONLY) return;

  // 先清理再转写：腾出来的空间本轮就能用上。
  // 放在转写前还有个好处——即使本轮转写失败，清理也已经做了。
  const cl = cleanMedia({ keepDays: KEEP_DAYS, dryRun: DRY_RUN, limit: CLEAN_LIMIT });
  if (cl.n || cl.held) {
    log(`清理 mp4：删 ${cl.n} 条释放 ${fmtMB(cl.bytes)}` +
      (cl.held ? `，保留 ${cl.held} 条（转写稿缺失或 0 字）` : '') +
      (DRY_RUN ? '（DRY RUN，未真删）' : ''));
  }
  if (CLEAN_ONLY) return;

  let items;
  if (ONLY_ID) {
    items = db().prepare('SELECT * FROM items WHERE id = ?').all(ONLY_ID);
    if (!items.length) die(EXIT.ERROR, `账本里没有 ${ONLY_ID}`);
    // 点名重转是要花钱的。已经转过的默认拦下来，避免手滑重复付费。
    if (items[0].status === 'transcribed' && !FORCE) {
      die(EXIT.ERROR, `${ONLY_ID} 已经转写过了（${items[0].text_chars} 字）。` +
        `确实要重转加 --force，会重新计费。`);
    }
  } else {
    const status = FORCE ? 'transcribed' : 'downloaded';
    items = claim(status, LIMIT || 10000, 'douyin', FORCE ? 1e9 : MAX_ATTEMPTS);
  }
  if (LIMIT) items = items.slice(0, LIMIT);

  if (!items.length) { log('没有待转写的条目。'); return; }

  log(`模型 ${MODEL}`);
  if (CONTEXT) log(`热词 ${CONTEXT.length} 字${existsSync(CTX_FILE) ? `（${CTX_FILE}）` : ''}`);
  else log('未配置热词——专名容易认错，建议写 ' + CTX_FILE);

  const totalDur = items.reduce((n, i) => n + (i.duration_s || 0), 0);
  log(`待转写 ${items.length} 条，视频总时长 ${fmtDur(totalDur)}`);
  const longOnes = items.filter(i => (i.duration_s || 0) > CHUNK_MAX);
  if (longOnes.length) log(`其中 ${longOnes.length} 条超过 ${CHUNK_MAX} 秒，需要切片`);

  if (DRY_RUN) {
    log('\n--dry-run，不调用 API。计划：');
    for (const i of items) {
      const d = i.duration_s || 0;
      const n = d > CHUNK_MAX ? Math.ceil(d / CHUNK_MAX) : 1;
      log(`  ${i.id}  ${String(fmtDur(d)).padStart(8)}  ${n} 次请求  ${String(i.title || '').slice(0, 30)}`);
    }
    log(`\n合计约 ${items.reduce((n, i) => n + ((i.duration_s || 0) > CHUNK_MAX ? Math.ceil(i.duration_s / CHUNK_MAX) : 1), 0)} 次请求，${fmtDur(totalDur)} 音频`);
    return;
  }

  // 剥音频要临时空间。10 分钟的视频压出来约 2.5 MB，并发几条也就十几 MB，
  // 但盘满时 ffmpeg 会写出个残缺文件然后一路错到 API，不如先拦住。
  const free = freeGB(tmpdir());
  if (free !== null && free < 1) die(EXIT.DISK, `临时目录所在盘仅剩 ${free.toFixed(1)} GB`);

  const tmpRoot = join(tmpdir(), `dustoff-asr-${process.pid}`);
  mkdirSync(tmpRoot, { recursive: true });

  const stat = { ok: 0, empty: 0, fail: 0, chars: 0, seconds: 0, reqs: 0 };
  const failures = [];
  let consecutiveFails = 0;
  let aborted = false;
  const queue = [...items];

  async function worker() {
    while (queue.length && !aborted) {
      const item = queue.shift();
      const label = `${item.id} ${String(item.title || '').slice(0, 24)}`;
      const t0 = Date.now();
      try {
        const r = await transcribeOne(item, tmpRoot);
        markTranscribed(item.id, {
          text_source: 'asr', text_chars: r.chars,
          text_path: r.textPath, audio_seconds: r.seconds,
        });
        consecutiveFails = 0;
        stat.ok++; stat.chars += r.chars; stat.seconds += r.seconds; stat.reqs += r.chunks;
        if (!r.chars) stat.empty++;
        const tag = r.chars ? `${r.chars} 字` : '0 字（纯画面？）';
        const wtag = r.words ? `，${r.words} 词时间戳` : '';
        log(`  ✓ ${label} — ${tag}${wtag}，${r.chunks} 次请求，${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        stat.fail++;
        failures.push({ id: item.id, title: item.title, error: e.message });
        // 永久性错误（文件不在、音频超长、参数错）重试没有意义，一次就放弃。
        // 尤其是「媒体文件不存在」——那多半是用户自己删的，撞三次只是噪音。
        const res = markFailed(item.id, e.message, 'douyin',
          e instanceof PermanentError ? 1 : MAX_ATTEMPTS);
        log(`  ✗ ${label} — ${e.message}${res.gaveUp ? '（已放弃）' : `（第 ${res.attempts} 次）`}`);
        if (++consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          aborted = true;
          log(`\n连续 ${consecutiveFails} 条失败，中止本轮。多半是 key 失效或余额耗尽，先查这两样。`);
        }
      }
    }
  }

  log('');
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  rmSync(tmpRoot, { recursive: true, force: true });

  log(`\n完成 ${stat.ok} 条 · 失败 ${stat.fail} 条 · 用时 ${fmtDur((Date.now() - t0) / 1000)}`);
  if (stat.ok) {
    log(`共 ${stat.chars.toLocaleString()} 字，平均 ${Math.round(stat.chars / stat.ok)} 字/条`);
    log(`计费音频 ${fmtDur(stat.seconds)}，${stat.reqs} 次请求`);
    log(`转写稿 → ${TEXT_DIR}`);
  }
  if (stat.empty) log(`其中 ${stat.empty} 条没转出字——多半是纯画面无人声，见 docs/待办-OCR增强.md`);

  // 本轮新产的转写稿也备份掉。转写稿是唯一花钱买来、不可再生的东西，
  // 不该让它裸奔到下一次运行。
  if (stat.ok) runBackup();

  if (!CASUAL) {
    // 留下现场：凌晨无人值守时这是唯一能回溯的东西
    try {
      // 注意别把 stat 摊平到顶层——stat.ok 是「成功几条」，
      // 跟「整轮是否正常结束」是两回事，撞名会把后者悄悄覆盖掉。
      stage.ensureDir();
      writeFileSync(join(stage.runDir, 'result.json'), JSON.stringify({
        ok: !aborted, model: MODEL, elapsed_s: Math.round((Date.now() - t0) / 1000),
        counts: stat, failures,
      }, null, 2));
    } catch {}
    const pruned = stage.pruneRuns();
    if (pruned) log(`清理了 ${pruned} 份超过 ${KEEP_RUNS} 天的运行记录`);
    log(`记录 ${stage.runDir}`);
  }

  // 失败要能被人看见。中止是硬故障，零散失败到一定比例也值得提醒。
  if (aborted) {
    notify('dustoff 转写中止', `连续 ${MAX_CONSECUTIVE_FAILS} 条失败，多半是 key 失效或余额不足`);
    process.exit(EXIT.ERROR);
  }
  if (stat.fail && stat.fail >= Math.max(3, (stat.ok + stat.fail) * 0.3)) {
    log(`⚠️ 失败率 ${(stat.fail / (stat.ok + stat.fail) * 100).toFixed(0)}%，超出正常范围`);
    notify('dustoff 转写失败偏多', `${stat.fail}/${stat.ok + stat.fail} 条失败，详见 ${stage.runDir}`);
  }
}

main().catch(e => { console.error(e); process.exit(EXIT.ERROR); });
