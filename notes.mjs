#!/usr/bin/env node
// dustoff / notes.mjs
// 第三段：把转写稿提炼成知识库笔记。
//
// 严格 1 : 1 : 1 —— 一条视频 → 一份转写稿 → 一篇笔记。
// 不合并、不拆分、不做跨条目关联。去重、找关联、知识图谱是再往后一个阶段的事。
// 判断某个想法该不该进来，只问一句：它需要读第二条视频吗？需要就不属于第三段。
//
// 它跟 sync.mjs / extract.mjs 平级，不由谁调用——三段只通过账本对话。
// 格式定义见 docs/第三段-笔记规格.md，那份文档是这里 PROMPT 的来源。
//
// 用法:
//   node notes.mjs                    给所有 transcribed 的写笔记
//   node notes.mjs --limit 5          只写 5 篇（先试水用这个）
//   node notes.mjs --id 7676...       指定一条
//   node notes.mjs --dry-run          只列计划和预估花费，不调 API
//   node notes.mjs --force            已写过的重写
//   node notes.mjs --out DIR          写到别处且不碰账本（打磨 prompt 用，见下）
//   node notes.mjs --effort low       临时换档，跟默认档做 A/B 对照
//
// --out 是给「验证质量」那一步准备的：prompt 定稿前生成的笔记不该进知识库，
// 也不该把条目标成 extracted——否则改一版 prompt 就要手工清一次现场。
//
// 退出码见 stage.mjs 的约定（0 正常 / 1 出错 / 3 已在跑 / 6 缺配置）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, DUST_HOME, CONF_FILE, expand } from './scripts/config.mjs';
import { claim, markExtracted, markSkipped, markFailed, db } from './scripts/ledger.mjs';
import { createStage, EXIT } from './scripts/stage.mjs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN = has('--dry-run');
const FORCE   = has('--force');
const ONLY_ID = valOf('--id');
const LIMIT   = Number(valOf('--limit') || 0);
const OUT_DIR = valOf('--out');
const TRIAL   = !!OUT_DIR;          // 试跑：写文件但不碰账本

const cfg = makeCfg();
const API_KEY     = cfg('DUST_LLM_KEY', '');
const BASE        = cfg('DUST_LLM_BASE', 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
const MODEL       = cfg('DUST_LLM_MODEL', 'glm-5.3-flash');
const EFFORT      = valOf('--effort') || cfg('DUST_LLM_EFFORT', 'high');
const CONCURRENCY = Number(cfg('DUST_LLM_CONCURRENCY', 2));
const MAX_ATTEMPTS = Number(cfg('DUST_MAX_ATTEMPTS', 3));
const MAX_CONSECUTIVE_FAILS = Number(cfg('DUST_LLM_MAX_FAILS', 5));
const NOTES_DIR   = expand(OUT_DIR || cfg('DUST_NOTES', join(process.env.HOME, 'Documents', '抖音收藏')));
const NOTIFY      = cfg('DUST_NOTIFY', '1') !== '0';
const KEEP_RUNS   = Number(cfg('DUST_KEEP_RUNS', 30));

// 转写稿短到这个数以下就不送 LLM 了。这不是「不配」，是材料不够——
// 落 skipped + needs_ocr，等 OCR 补完画面文字再退回来重走。
const MIN_CHARS = Number(cfg('DUST_NOTE_MIN_CHARS', 50));

// 思考 token 计入 completion_tokens，也就计入 max_tokens。给小了模型会把
// 额度全花在思考上，正文一个字不剩，而且 HTTP 仍然是 200（实测 800 给出
// 798 个思考 token + 空 content）。给够，反正按实际用量计费。
const MAX_TOKENS = Number(cfg('DUST_LLM_MAX_TOKENS', 8000));

// 单价（元/百万 token），只用于 --dry-run 预估和跑完的账单提示。
const PRICE_IN  = Number(cfg('DUST_LLM_PRICE_IN', 0.8));
const PRICE_OUT = Number(cfg('DUST_LLM_PRICE_OUT', 2.8));

const CASUAL = DRY_RUN || TRIAL;
const stage = createStage({
  name: 'notes', dustHome: DUST_HOME,
  notify: NOTIFY, keepRuns: KEEP_RUNS, record: !CASUAL,
});
const { log, die, notify } = stage;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DECAY = ['none', 'slow', 'fast', 'event'];
const ymd = t => t ? new Date(t * 1000).toLocaleDateString('sv-SE') : '';   // sv-SE 就是 YYYY-MM-DD
const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒` : `${Math.round(s)}秒`;

class PermanentError extends Error {}

// ── 提炼指令 ──────────────────────────────────────────────────────
// 来源是 docs/第三段-笔记规格.md。那份文档是给人看的，这里是给模型看的，
// 改一处就要同步另一处——否则文档说的和实际跑的会悄悄分家。

const PROMPT = `你把抖音口播转写稿整理成个人知识库笔记，只输出 JSON。

## 怎么写

1. **重组，不复述。** 整理成结构化要点（核心观点 / 分论点 / 结论），
   而不是把转写稿断句排版。口语的重复、口头禅、寒暄一律去掉。
2. **保留有信息量的具体内容**——数字、人名、产品名、参数、金句。这些是笔记的价值所在。
3. **标题里的 hashtag 是专名的地面真相。** 转写稿里出现「万象棋」而标题有 #王者万象棋，
   按标题的写法写。转写稿里明显认错的专名，按标题和上下文改对。
4. **长度按信息密度定，不按视频时长定。** 一分钟的攻略可以比四分钟的泛泛而谈写得长。
   总体适中：不为凑长度注水，也别把有用的细节压掉。

## 几个判断

**材料够不够写一篇**（够写 = true）：判断的是事实，不是品味。
用户是主动收藏这条的，所以「题材不高级」不是拒绝的理由。
只有当这份转写稿实在撑不起一篇笔记时才填 false——比如通篇是口水、
或者关键信息根本没出现在语音里。填 false 时必须在「缺料说明」里讲清楚缺什么。

**引流内容**：判定标准是「推销物 ≠ 主题」。
讲 A 最后卖 B，那是引流：把它剔出正文，在「引流说明」里点名推销的是什么。
整条视频就在讲那个东西本身（比如一条介绍某款键盘的视频），
那么推销物就是主题，属于正文，不要剔。

**缺料说明**：只在画面上、语音里拿不到的东西（阵容码、仓库地址、型号、链接、
屏幕上的代码），在这里说明缺了什么。将来会对这些条目集中补 OCR。
没有缺的就留空字符串。

**分类**：一个词的名词短语，自己判断，不要硬套到某个预设列表里。
**时效**：none=不过期（原理、方法论、审美）· slow=年为单位（工具用法、职业建议）·
fast=月为单位（软件版本、游戏版本、排名）· event=绑死某个时间点（发布会、活动、新闻）。
**标签**：3-6 个关键词，等同论文的 keywords，给全文检索用。

## 输出格式

只输出这个 JSON，不要代码块围栏、不要任何解释：

{
  "够写": true,
  "缺料说明": "",
  "标题": "凝练的主题标题，不要抄原标题的标题党写法",
  "分类": "一个词",
  "时效": "none",
  "标签": ["关键词1", "关键词2"],
  "引流说明": "",
  "正文": "# 核心观点\\n...\\n\\n## 小标题\\n...\\n\\n## 结论\\n..."
}`;

// ── 调模型 ────────────────────────────────────────────────────────

async function askOnce(item, text) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // 必须显式传。漏掉不是「用默认档」，实测走的是 max——思考 token 从
      // 均值 28 涨到 1400 左右，而且是静默的：HTTP 200、结果照样对，只有账单变厚。
      // 注意参数名是 reasoning_effort，写成 thinking:{effort} 不报错但会被无视。
      reasoning_effort: EFFORT,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `标题：${item.title || '(无)'}\n作者：${item.author || '(无)'}\n时长：${fmtDur(item.duration_s || 0)}\n\n转写稿：\n${text}` },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body?.error?.code, msg = body?.error?.message || res.statusText;
    // 参数错、模型名错、内容被拦：重试多少次都是同样的结果
    if (res.status === 400 || res.status === 404) throw new PermanentError(`${code || res.status}: ${msg}`);
    throw new Error(`HTTP ${res.status} ${code || ''} ${msg}`.trim());
  }

  const msg = body.choices?.[0]?.message || {};
  const usage = body.usage || {};
  const think = usage.completion_tokens_details?.reasoning_tokens ?? 0;

  // 空 content 不是错误响应，是 200。不拦住的话会安静地写出一堆空笔记，
  // 还把条目标成 extracted——那种坏是最难发现的。
  if (!msg.content || !msg.content.trim()) {
    throw new Error(think >= MAX_TOKENS * 0.9
      ? `模型把 ${think} 个 token 全花在思考上，正文为空（调大 DUST_LLM_MAX_TOKENS）`
      : '模型返回空正文');
  }

  let note;
  try {
    // 交代过不要围栏，但万一它加了，剥掉比失败一次划算
    note = JSON.parse(msg.content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch (e) {
    throw new Error(`返回的不是合法 JSON: ${msg.content.slice(0, 120)}`);
  }
  return {
    note,
    usage: {
      in: usage.prompt_tokens || 0,
      out: usage.completion_tokens || 0,
      think,
      yuan: (usage.prompt_tokens || 0) * PRICE_IN / 1e6 + (usage.completion_tokens || 0) * PRICE_OUT / 1e6,
    },
  };
}

/** 带退避重试。限流和 5xx 值得再试，参数错不值得。 */
async function ask(item, text, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await askOnce(item, text); }
    catch (e) {
      if (e instanceof PermanentError) throw e;
      last = e;
      if (i < tries - 1) await sleep(2000 * 2 ** i);
    }
  }
  throw last;
}

// ── 落盘 ──────────────────────────────────────────────────────────

/**
 * 把标题压成文件名。
 *
 * 模型给的标题是「主标题：副标题」结构时，主标题就是最好的文件名——
 * 所以优先在第一个冒号/破折号处切，比硬截 30 字体面得多：
 *   AKKO 量子事件键帽：169 元的赛博工业风透光键帽  →  AKKO量子事件键帽
 * 切出来太短（少于 6 字）说明冒号在开头，那还是回退到硬截。
 */
function slug(s, max = 30) {
  let t = String(s || '')
    .replace(/[\/\\:*?"<>|#\n\r\t]/g, '')          // 路径非法字符
    .replace(/[：？！，、；·]/g, m => (m === '：' ? '\u0000' : ''))  // 冒号留个记号，其余全去
    .replace(/[「」『』（）【】《》〈〉""'']/g, '')       // 成对符号在文件名里只是噪音
    .replace(/\s+/g, '');
  const cut = t.indexOf('\u0000');
  if (cut >= 6) t = t.slice(0, cut);
  t = t.replace(/\u0000/g, '');
  return t.slice(0, max) || '无题';
}

function writeNote(item, note, { dir }) {
  // 日期用收藏日：人记得住「我什么时候存的」，记不住作者哪天发的。
  // collected_at 是从 listcollection 的 cursor 还原的估计值，取不到就退回
  // first_seen（扫到的那天），再取不到才用发布日。
  const collected = item.collected_at || item.first_seen || item.created_at;
  const base = `${ymd(collected)}-${slug(note.标题)}`;
  // 同一天撞名的加 id 后 6 位区分。宁可文件名难看，也不要静默覆盖掉一篇。
  let file = join(dir, `${base}.md`);
  if (existsSync(file)) file = join(dir, `${base}-${String(item.id).slice(-6)}.md`);

  const decay = DECAY.includes(note.时效) ? note.时效 : 'none';
  const tags = Array.isArray(note.标签) ? note.标签 : [];

  const fm = [
    '---',
    `标题: ${note.标题 || item.title || ''}`,
    '来源: 抖音',
    `作者: ${item.author || ''}`,
    `视频ID: ${item.id}`,
    `链接: https://www.douyin.com/video/${item.id}`,
    `发布日期: ${ymd(item.created_at)}`,
    `收藏日期: ${ymd(collected)}`,
    `下载日期: ${ymd(item.downloaded_at)}`,
    `收录日期: ${ymd(Math.floor(Date.now() / 1000))}`,
    `时长: ${fmtDur(item.duration_s || 0)}`,
    `分类: ${note.分类 || '未分类'}`,
    `时效: ${decay}`,
    `标签: [${tags.join(', ')}]`,
    '---',
    '',
  ].join('\n');

  // 脚注放在正文后面：它们是关于这篇笔记的元信息，不该插在内容中间打断阅读。
  const foot = [];
  if (note.引流说明) foot.push(`> ${note.引流说明}`);
  if (note.缺料说明) foot.push(`> ⚠️ ${note.缺料说明}`);

  const body = String(note.正文 || '').trim();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, fm + body + (foot.length ? '\n\n' + foot.join('\n>\n') + '\n' : '\n'), 'utf8');
  return { file, decay, tags };
}

// ── 单条流程 ──────────────────────────────────────────────────────

async function noteOne(item) {
  if (!item.text_path || !existsSync(item.text_path)) {
    throw new PermanentError('转写稿不在磁盘上');
  }
  const text = readFileSync(item.text_path, 'utf8').trim();

  // 硬门槛：太短的不送 LLM。免费挡掉一批，也省得让模型对着三句话硬凑。
  if (text.length < MIN_CHARS) {
    return { skipped: true, reason: 'need_ocr',
      why: `转写稿只有 ${text.length} 字，撑不起一篇笔记——关键信息多半在画面上` };
  }

  const { note, usage } = await ask(item, text);

  // 软判断：模型说材料不够。同样进 OCR 补料队列，不是扔掉。
  if (note.够写 === false) {
    return { skipped: true, reason: 'need_ocr', usage,
      why: note.缺料说明 || '模型判断材料撑不起一篇笔记' };
  }
  if (!String(note.正文 || '').trim()) throw new Error('模型没给正文');

  return { note, usage, needsOcr: !!String(note.缺料说明 || '').trim() };
}

// ── 主流程 ────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY && !DRY_RUN) {
    die(EXIT.CONFIG, `未配置 DUST_LLM_KEY。写进 ${CONF_FILE}：DUST_LLM_KEY=xxxx`);
  }
  if (!DECAY.length || !['low', 'high', 'max'].includes(EFFORT)) {
    // medium 是硬 400（错误码 1210「该模型始终思考」），在这儿拦住比撞一次快
    die(EXIT.CONFIG, `DUST_LLM_EFFORT 只能是 low / high / max，当前是「${EFFORT}」`);
  }
  if (!CASUAL) {
    stage.acquireLock();
    log(`dustoff 提炼　run=${stage.runId}`);
  }

  let items;
  if (ONLY_ID) {
    items = db().prepare('SELECT * FROM items WHERE id = ?').all(ONLY_ID);
    if (!items.length) die(EXIT.ERROR, `账本里没有 ${ONLY_ID}`);
    if (items[0].status === 'extracted' && !FORCE && !TRIAL) {
      die(EXIT.ERROR, `${ONLY_ID} 已经写过笔记了（${items[0].note_path}）。要重写加 --force。`);
    }
  } else {
    const status = FORCE ? 'extracted' : 'transcribed';
    items = claim(status, LIMIT || 10000, 'douyin', FORCE ? 1e9 : MAX_ATTEMPTS);
  }
  if (LIMIT) items = items.slice(0, LIMIT);
  if (!items.length) { log('没有待提炼的条目。'); return; }

  log(`模型 ${MODEL} · effort ${EFFORT}`);
  log(`待提炼 ${items.length} 条，转写稿共 ${items.reduce((n, i) => n + (i.text_chars || 0), 0).toLocaleString()} 字`);
  if (TRIAL) log(`试跑模式：笔记写到 ${NOTES_DIR}，不改账本`);
  else log(`笔记 → ${NOTES_DIR}`);

  if (DRY_RUN) {
    // 预估用实测系数：中文约 0.76 token/字，加上 PROMPT 约 500 token；
    // 输出实测 578~1857 token，取 900 估。只求量级对，别当账单看。
    let yuan = 0;
    log('\n--dry-run，不调用 API。计划：');
    for (const i of items) {
      const short = (i.text_chars || 0) < MIN_CHARS;
      const y = short ? 0 : ((i.text_chars || 0) * 0.76 + 500) * PRICE_IN / 1e6 + 900 * PRICE_OUT / 1e6;
      yuan += y;
      log(`  ${i.id}  ${String(i.text_chars || 0).padStart(5)} 字  ` +
        (short ? '跳过（材料不够，进 OCR 队列）' : `约 ¥${y.toFixed(4)}`) +
        `  ${String(i.title || '').replace(/\n/g, ' ').slice(0, 26)}`);
    }
    log(`\n合计预估 ¥${yuan.toFixed(3)}（单价 ¥${PRICE_IN}/¥${PRICE_OUT} 每百万 token）`);
    return;
  }

  const stat = { ok: 0, skip: 0, fail: 0, ocr: 0, in: 0, out: 0, think: 0, yuan: 0 };
  const failures = [];
  const cats = new Map();
  let consecutiveFails = 0, aborted = false;
  const queue = [...items];

  async function worker() {
    while (queue.length && !aborted) {
      const item = queue.shift();
      const label = `${item.id} ${String(item.title || '').replace(/\n/g, ' ').slice(0, 22)}`;
      const t0 = Date.now();
      try {
        const r = await noteOne(item);
        if (r.usage) {
          stat.in += r.usage.in; stat.out += r.usage.out;
          stat.think += r.usage.think; stat.yuan += r.usage.yuan;
        }
        if (r.skipped) {
          if (!TRIAL) markSkipped(item.id, r.reason, { needsOcr: true });
          stat.skip++; stat.ocr++;
          consecutiveFails = 0;
          log(`  ⊘ ${label} — ${r.why}`);
          continue;
        }
        const w = writeNote(item, r.note, { dir: NOTES_DIR });
        if (!TRIAL) {
          markExtracted(item.id, {
            text_source: item.text_source || 'asr', text_chars: item.text_chars,
            keyframes: item.keyframes, note_path: w.file,
            category: r.note.分类 || null, decay: w.decay, needs_ocr: r.needsOcr,
          });
        }
        if (r.needsOcr) stat.ocr++;
        cats.set(r.note.分类 || '未分类', (cats.get(r.note.分类 || '未分类') || 0) + 1);
        consecutiveFails = 0;
        stat.ok++;
        log(`  ✓ ${label} — 「${r.note.标题}」${r.note.分类}/${w.decay}` +
          `${r.needsOcr ? ' ⚠️缺料' : ''}，¥${r.usage.yuan.toFixed(4)}，${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        stat.fail++;
        failures.push({ id: item.id, title: item.title, error: e.message });
        if (!TRIAL) {
          markFailed(item.id, e.message, 'douyin', e instanceof PermanentError ? 1 : MAX_ATTEMPTS);
        }
        log(`  ✗ ${label} — ${e.message}`);
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

  log(`\n完成 ${stat.ok} 篇 · 跳过 ${stat.skip} 条 · 失败 ${stat.fail} 条 · 用时 ${fmtDur((Date.now() - t0) / 1000)}`);
  if (stat.ok || stat.skip) {
    log(`用量 入 ${stat.in.toLocaleString()} / 出 ${stat.out.toLocaleString()}（含思考 ${stat.think.toLocaleString()}）token，共 ¥${stat.yuan.toFixed(4)}`);
    if (stat.ok) log(`平均每篇 ¥${(stat.yuan / stat.ok).toFixed(4)}`);
  }
  if (cats.size) {
    log(`分类分布：${[...cats].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  if (stat.ocr) log(`${stat.ocr} 条标了 needs_ocr——关键信息在画面上，等 OCR 那一轮集中补`);
  if (TRIAL) log(`\n试跑，账本未改动。看完觉得行，去掉 --out 再正式跑一遍。`);

  if (!CASUAL) {
    try {
      stage.ensureDir();
      writeFileSync(join(stage.runDir, 'result.json'), JSON.stringify({
        ok: !aborted, model: MODEL, effort: EFFORT,
        elapsed_s: Math.round((Date.now() - t0) / 1000),
        counts: stat, categories: Object.fromEntries(cats), failures,
      }, null, 2));
    } catch {}
    const pruned = stage.pruneRuns();
    if (pruned) log(`清理了 ${pruned} 份超过 ${KEEP_RUNS} 天的运行记录`);
    log(`记录 ${stage.runDir}`);
  }
  if (stat.fail && !CASUAL) notify('dustoff 提炼', `${stat.fail} 条失败，${stat.ok} 篇成功`);
  if (aborted) process.exit(EXIT.ERROR);
}

main().catch(e => die(EXIT.ERROR, e.stack || e.message));
