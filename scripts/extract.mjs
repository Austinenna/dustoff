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
//   node scripts/extract.mjs                 转所有 downloaded 的
//   node scripts/extract.mjs --limit 5        只转 5 条（先试水用这个）
//   node scripts/extract.mjs --id 7676...     指定一条
//   node scripts/extract.mjs --dry-run        只列计划和音频总时长，不调 API
//   node scripts/extract.mjs --force          已转过的也重转
//
// 退出码见 stage.mjs 的约定（0 正常 / 1 出错 / 3 已在跑 / 5 磁盘 / 6 缺配置）。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeCfg, DUST_HOME, CONF_FILE } from './config.mjs';
import { claim, markTranscribed, markFailed, db } from './ledger.mjs';
import { createStage, freeGB, EXIT } from './stage.mjs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN = has('--dry-run');
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

// --dry-run 和 --id 是探查/点名跑法，不建运行记录也不抢锁
const CASUAL = DRY_RUN || !!ONLY_ID;
const stage = createStage({
  name: 'extract', dustHome: DUST_HOME,
  notify: NOTIFY, keepRuns: KEEP_RUNS, record: !CASUAL,
});
const { log, die, notify } = stage;

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

// ── 主流程 ────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY && !DRY_RUN) {
    die(EXIT.CONFIG, `未配置 DUST_DASHSCOPE_KEY。写进 ${CONF_FILE}：DUST_DASHSCOPE_KEY=sk-xxxx`);
  }
  if (!CASUAL) {
    stage.acquireLock();
    log(`dustoff 提取　run=${stage.runId}`);
  }

  let items;
  if (ONLY_ID) {
    items = db().prepare('SELECT * FROM items WHERE id = ?').all(ONLY_ID);
    if (!items.length) die(EXIT.ERROR, `账本里没有 ${ONLY_ID}`);
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
