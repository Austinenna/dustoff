#!/usr/bin/env node
// dustoff / timeline.mjs
// 把转写稿和逐词时间戳合成「分句 + 时间戳」的视图。
//
// 为什么要这一层：
//   转写产出两个文件——.txt 是纯文字（给人读、给 LLM 写笔记），
//   .words.json 是逐词时间戳（不可再生，丢了要重付 ASR 的钱）。
//   但逐词粒度对「跳回视频某处」这个用途太细了：没人需要知道
//   「第」字在第 240 毫秒。分句才是人和笔记实际引用的粒度。
//
//   刻意做成按需生成而不是转写时就写第三个文件——它是纯派生数据，
//   两个源文件在就能随时重算，没必要占一份存储和一次写盘。
//
// 用法:
//   node scripts/timeline.mjs <id>           打印到终端
//   node scripts/timeline.mjs <id> --save    存成 <id>.timeline.txt
//   node scripts/timeline.mjs <id> --json    输出 [{t, text}]，给下游程序用

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, DUST_HOME } from './config.mjs';

const argv = process.argv.slice(2);
const id = argv.find(a => !a.startsWith('--'));
const SAVE = argv.includes('--save');
const JSON_OUT = argv.includes('--json');

const TEXT_DIR = makeCfg()('DUST_TEXT', join(DUST_HOME, 'text'));

// 句子边界。逗号不算——按逗号切会碎成一地，反而不好引用。
const SENT_END = /[。！？!?\n]/;
// 对齐用：words 里存的是纯文字，标点只在 .txt 里，比对前得抹平
const PUNCT = /[，。！？；：、,.!?;:\s"'「」（）()《》]/g;

const mmss = ms => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** 把整段文字按句号切开，保留标点。 */
function splitSentences(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (SENT_END.test(ch)) { const t = buf.trim(); if (t) out.push(t); buf = ''; }
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

/**
 * 给每句配一个起始时间。
 * 办法是按「去掉标点后的字数」在 words 序列上走位——
 * 实测两边字数严丝合缝，所以这个对齐是精确的而不是估算的。
 */
export function timeline(text, words) {
  const rows = [];
  let wi = 0, carry = 0;      // carry: 当前 word 已被消费掉的字数
  for (const sent of splitSentences(text)) {
    const need = sent.replace(PUNCT, '').length;
    if (!need) continue;
    if (wi >= words.length) { rows.push({ t: null, text: sent }); continue; }
    const start = words[wi].t;
    let got = -carry;
    while (wi < words.length && got + words[wi].w.length <= need) {
      got += words[wi].w.length; wi++;
    }
    // 一个 word 跨了句子边界（模型把「常用的」这类词组当一个单位输出）：
    // 记下已消费的部分，下一句从这里接着走，别把整个词重复计一遍
    carry = need - got > 0 && wi < words.length ? need - got : 0;
    if (carry) got = need;
    rows.push({ t: start, text: sent });
  }
  return rows;
}

function main() {
  if (!id) {
    console.error('用法: node scripts/timeline.mjs <id> [--save|--json]');
    process.exit(1);
  }
  const txtPath = join(TEXT_DIR, `${id}.txt`);
  const wordsPath = join(TEXT_DIR, `${id}.words.json`);
  if (!existsSync(txtPath)) { console.error(`没有转写稿: ${txtPath}`); process.exit(1); }

  const text = readFileSync(txtPath, 'utf8');
  if (!existsSync(wordsPath)) {
    console.error(`没有时间戳: ${wordsPath}`);
    console.error('这条多半是用 qwen3-asr-flash 转的（那个模型不返回时间戳）。');
    console.error(`要补的话: node scripts/ledger.mjs requeue ${id} && node scripts/extract.mjs --id ${id}`);
    process.exit(1);
  }
  const rows = timeline(text, JSON.parse(readFileSync(wordsPath, 'utf8')));

  if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); return; }

  const out = rows.map(r => `[${r.t === null ? '--:--' : mmss(r.t)}] ${r.text}`).join('\n');
  if (SAVE) {
    const p = join(TEXT_DIR, `${id}.timeline.txt`);
    writeFileSync(p, out, 'utf8');
    console.log(`${rows.length} 句 → ${p}`);
  } else {
    console.log(out);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
