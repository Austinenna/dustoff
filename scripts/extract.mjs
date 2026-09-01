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
// 用法:
//   node scripts/extract.mjs                 转所有 downloaded 的
//   node scripts/extract.mjs --limit 5        只转 5 条（先试水用这个）
//   node scripts/extract.mjs --id 7676...     指定一条
//   node scripts/extract.mjs --dry-run        只列计划和音频总时长，不调 API
//   node scripts/extract.mjs --force          已转过的也重转
//
// 退出码: 0 正常 / 1 出错 / 6 未配置 API key

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeCfg, DUST_HOME, CONF_FILE } from './config.mjs';
import { claim, markTranscribed, markFailed, db } from './ledger.mjs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN = has('--dry-run');
const FORCE   = has('--force');
const ONLY_ID = valOf('--id');
const LIMIT   = Number(valOf('--limit') || 0);

const cfg = makeCfg();
const API_KEY     = cfg('DUST_DASHSCOPE_KEY', '');
const MODEL       = cfg('DUST_ASR_MODEL', 'qwen3-asr-flash');
const LANG        = cfg('DUST_ASR_LANG', 'zh');
const CONCURRENCY = Number(cfg('DUST_ASR_CONCURRENCY', 2));
const MAX_ATTEMPTS = Number(cfg('DUST_MAX_ATTEMPTS', 3));
const TEXT_DIR    = cfg('DUST_TEXT', join(DUST_HOME, 'text'));

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

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
      parameters: { asr_options: { language: LANG, enable_itn: true } },
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = `HTTP ${res.status} ${body.code || ''} ${body.message || ''}`.trim();
    // 4xx 是请求本身的问题（参数错、音频超长、key 无效），重试无意义；
    // 429 例外——那是限流，等一等就好。
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentError(msg);
    throw new Error(msg);
  }

  const text = body.output?.choices?.[0]?.message?.content?.[0]?.text ?? '';
  return { text: String(text).trim(), seconds: body.usage?.seconds ?? 0 };
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
    let seconds = 0;
    for (const [i, [s, e]] of chunks.entries()) {
      let piece = audio;
      if (chunks.length > 1) {
        piece = join(work, `c${i}.mp3`);
        sliceAudio(audio, piece, s, e);
      }
      const r = await asr(piece);
      if (r.text) parts.push(r.text);
      seconds += r.seconds || (e - s);
    }

    const text = parts.join('\n');
    mkdirSync(TEXT_DIR, { recursive: true });
    const textPath = join(TEXT_DIR, `${item.id}.txt`);
    writeFileSync(textPath, text, 'utf8');

    return { text, textPath, chars: text.length, chunks: chunks.length, seconds: Math.round(seconds) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── 主流程 ────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY && !DRY_RUN) {
    console.error('未配置 DUST_DASHSCOPE_KEY。');
    console.error(`把它写进 ${CONF_FILE}：DUST_DASHSCOPE_KEY=sk-xxxx`);
    process.exit(6);
  }

  let items;
  if (ONLY_ID) {
    items = db().prepare('SELECT * FROM items WHERE id = ?').all(ONLY_ID);
    if (!items.length) { console.error(`账本里没有 ${ONLY_ID}`); process.exit(1); }
  } else {
    const status = FORCE ? 'transcribed' : 'downloaded';
    items = claim(status, LIMIT || 10000, 'douyin', FORCE ? 1e9 : MAX_ATTEMPTS);
  }
  if (LIMIT) items = items.slice(0, LIMIT);

  if (!items.length) { log('没有待转写的条目。'); return; }

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

  const tmpRoot = join(tmpdir(), `dustoff-asr-${process.pid}`);
  mkdirSync(tmpRoot, { recursive: true });

  const stat = { ok: 0, empty: 0, fail: 0, chars: 0, seconds: 0, reqs: 0 };
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
        log(`  ✓ ${label} — ${tag}，${r.chunks} 次请求，${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        stat.fail++;
        const res = markFailed(item.id, e.message, 'douyin', MAX_ATTEMPTS);
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
  if (aborted) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
