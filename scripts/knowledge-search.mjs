// 全文搜索用到的纯函数：把笔记切成段、把文字切成可以比对的词、把搜索词拼成 FTS5 查询、截取命中的片段。
// 不碰数据库；建索引和查询在 knowledge-store.mjs。

// 切段或切词的规则改了就加一，全部内容会重新进索引。
export const INDEX_VERSION = '1';
// 一段最多这么多字：太长的段话题多，排序不准，命中后也不好定位。
const CHUNK_MAX = 1200;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const TAIL = /\r?\n\r?\n---\r?\n## (完整转写稿|原帖)\r?\n/g;
// 词和词之间允许隔着标点、空白，和 FTS5 的短语匹配一致。
const GAP = '[^\\p{L}\\p{N}]*';

/**
 * 写进全文索引前的切词：中日韩文字按单字切，英文和数字留给 FTS5 按整词切。
 * 在生产全部笔记上比过词典分词和三字一组：按单字切漏得最少，两个字的词和新词都搜得到。
 */
export function cutText(text) {
  return String(text ?? '').normalize('NFKC').replace(CJK, ' $& ');
}
const tokensOf = text => cutText(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const quote = tokens => `"${tokens.join(' ')}"`;
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function markOf(tokens, prefix = false) {
  const ascii = t => /^[a-z0-9]+$/.test(t);
  // 英文词要整词命中：搜 rag 不标 LightRAG 里的 rag。
  return (ascii(tokens[0]) ? '(?<![a-z0-9])' : '') + tokens.map(escapeRe).join(GAP) + (prefix ? '[a-z0-9]*' : ascii(tokens.at(-1)) ? '(?![a-z0-9])' : '');
}

function split(text) {
  const out = [];
  let rest = text;
  while (rest.length > CHUNK_MAX) {
    // 尽量在句子或段落结束的地方断开。
    let cut = -1;
    for (const m of rest.slice(0, CHUNK_MAX).matchAll(/[。！？!?；;\n]/g)) if (m.index >= CHUNK_MAX * 0.5) cut = m.index + 1;
    if (cut < 0) cut = CHUNK_MAX;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
function sections(text, tier, fallback = '') {
  const out = [];
  // 去掉本机图片路径，免得把路径当内容。
  for (const part of text.replace(/ · 本地：`[^`\n]*`/g, '').split(/^(?=#{1,2} )/m)) {
    const head = part.match(/^#{1,2} +([^\r\n]*)\r?\n?/), body = (head ? part.slice(head[0].length) : part).trim();
    if (!body) continue;
    for (const piece of split(body)) out.push({ tier, heading: head ? head[1].trim() : fallback, text: piece });
  }
  return out;
}
/**
 * 把一篇笔记切成段：模型或作者写的正文是 body，末尾附带的转写稿或原帖是 source。
 * 按一、二级标题分节，一节太长再按句子切开。
 */
export function chunkNote(source) {
  const text = String(source).replace(/^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const tail = [...text.matchAll(TAIL)].at(-1);
  if (!tail) return sections(text, 'body');
  const rest = text.slice(tail.index + tail[0].length).replace(/\r?\n\r?\n---\r?\n\[完整转写稿\]\(#完整转写稿\)[^\r\n]*\s*$/, '');
  return [...sections(text.slice(0, tail.index), 'body'), ...sections(rest, 'source', tail[1])];
}
/** 没有整理成笔记的文字稿：整篇算 source。 */
export function chunkText(source) { return sections(String(source), 'source'); }
/** 综述页切成段：开头的说明一段，每个分节一段。 */
export function chunkPage(page) {
  const join = points => points.map(p => p.text).join('\n');
  return [
    { heading: '', text: page.intro || '' },
    ...page.sections.map(s => ({ heading: s.title || '', text: join(s.points) })),
    { heading: '不同笔记说法不一样的地方', text: join(page.disputes) },
    { heading: '可能已经过期', text: join(page.stale) },
  ].filter(c => c.text.trim()).map(c => ({ tier: 'page', ...c }));
}

/**
 * 把用户输入拆成搜索词：用空白分开，每个词在原文里要连着出现。
 * 返回 [{ text, tokens, fts, mark }]：fts 是这个词的 FTS5 查询，mark 是在原文里标出它的正则。
 * 英文词结尾按前缀匹配（搜 agent 也命中 agents），整词命中的仍排在前面。
 */
export function searchTerms(input) {
  const seen = new Set(), out = [];
  for (const raw of String(input ?? '').trim().split(/\s+/).slice(0, 8)) {
    const tokens = tokensOf(raw).slice(0, 40), key = tokens.join(' ');
    if (!tokens.length || seen.has(key)) continue;
    seen.add(key);
    const prefix = /^[a-z0-9]{3,}$/.test(tokens.at(-1));
    out.push({ text: raw.normalize('NFKC'), tokens, fts: prefix ? `(${quote(tokens)} OR ${quote(tokens)} *)` : quote(tokens), mark: markOf(tokens, prefix) });
  }
  return out;
}
const WORDS = new Intl.Segmenter('zh', { granularity: 'word' });
/**
 * 没有哪一篇包含全部搜索词时放宽：把搜索词按词典拆成更小的词，返回要补进查询的那些（两个字以上，和原来的词不重复）。
 * 这样整句话当搜索词（「失眠怎么改善」）也能找到讲到其中关键词的笔记。
 * 词典只用在搜索词上，索引仍然按单字切，所以拆得不准也只是少补几个词，不会漏掉原本能搜到的内容。
 */
export function looseTerms(terms) {
  const seen = new Set(terms.map(t => t.tokens.join(' '))), out = [];
  const add = word => {
    const tokens = tokensOf(word), key = tokens.join(' ');
    if (key.length < 2 || seen.has(key) || STOP.has(word)) return;
    seen.add(key); out.push({ text: word, tokens, fts: quote(tokens), mark: markOf(tokens) });
  };
  for (const { text } of terms) {
    // 词典不认识的词（人名、游戏里的名字）会被拆成一个个单字；连着的单字合起来当一个词。
    let single = '';
    for (const part of [...WORDS.segment(text), { segment: '' }]) {
      const one = part.isWordLike && [...part.segment].length === 1 && tokensOf(part.segment).length === 1 && !/^[a-z0-9]$/i.test(part.segment);
      if (one) { single += part.segment; continue; }
      if (single) { add(single); single = ''; }
      if (part.isWordLike) add(part.segment);
    }
  }
  return out;
}
// 提问时常带的虚词，哪篇笔记里都有，补进查询只会带出不相干的内容。
const STOP = new Set(['怎么', '怎样', '如何', '什么', '为什么', '哪些', '哪个', '多少', '怎么办', '可以', '是否', '有没有', '一个', '这个', '那个']);
export function markRegex(marks) { return new RegExp(marks.join('|'), 'giu'); }

/**
 * 截取命中处前后的一小段。返回字符串数组，奇数位是命中的词，偶数位是其余文字：
 * ['…前面的字', '命中', '中间', '命中', '后面…']。原文里找不到命中的词时，返回这一段的开头。
 */
export function snippet(text, marks, { before = 24, width = 96 } = {}) {
  const flat = String(text).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`>|]+|^#+ /gm, ' ').replace(/\s+/g, ' ').trim();
  const re = markRegex(marks), first = re.exec(flat);
  const start = first ? Math.max(0, first.index - before) : 0, end = Math.min(flat.length, start + width), part = flat.slice(start, end);
  const out = [start > 0 ? '…' : ''];
  let pos = 0;
  for (const m of part.matchAll(markRegex(marks))) {
    if (!m[0]) continue;
    out[out.length - 1] += part.slice(pos, m.index);
    out.push(m[0], ''); pos = m.index + m[0].length;
  }
  out[out.length - 1] += part.slice(pos) + (end < flat.length ? '…' : '');
  return out;
}
