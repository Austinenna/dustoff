#!/usr/bin/env node
// dustoff / download.mjs
// 批量下载器：吃 get_collection.mjs 的输出，直接下载，不再逐条起 Chrome。
//
// 为什么不用 get_meta.mjs：
//   listcollection 接口的响应里已经带了 play_addr 和 12 档 bit_rate，
//   get_collection.mjs 现在会一并提取。批量场景下再对每条视频跑一次
//   get_meta.mjs（起 Chrome + CDP，实测 5.4-6.3s/条）纯属浪费——
//   5000 条就是约 8 小时的白白开销。单条链接场景仍然走 fetch.mjs。
//
// 下的是哪一档：bit_rate 里码率最低的那档，不是默认的 play_addr。
//   实测同一条视频 play_addr 2.39MB(1080p) vs 最低档 0.73MB(720p)，
//   音频轨相同、画面做字幕 OCR 也够。只要内容不要原件，没有下 1080p 的理由。
//
// 用法:
//   node get_collection.mjs 200 > coll.json
//   node download.mjs coll.json [并发数=3]
//   cat coll.json | node download.mjs -            # 也可以从 stdin 读
//
// 环境变量:
//   DUST_MEDIA     缓存根目录（默认 ~/.dustoff/media）
//   DUST_LIMIT     最多下载多少条（默认全部）
//   DUST_MAX_DURATION_MIN  超过多少分钟就不下（默认 10，设 0 不限）
//   DUST_DRY_RUN=1 只报计划，不真的下载
//
// stdout 输出单行 JSON 汇总；进度打在 stderr。

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isExpired, expiryOf, fmtMB } from './lib.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIN_VALID_BYTES = 10000;

const src = process.argv[2];
const concurrency = Math.max(1, Number(process.argv[3] || 3));
const mediaRoot = process.env.DUST_MEDIA || join(homedir(), '.dustoff', 'media');
const limit = Number(process.env.DUST_LIMIT || 0) || Infinity;
// 时长上限。收藏里时长极度长尾：中位 58 秒，但最长有 841 分钟的全集解说。
// 超长的多是合集/解说/全片，做知识笔记价值低却吃掉大量体积——
// 实测阈值取 10 分钟只拦下 4.6% 的条目，却省掉约 12.6 GB。
// 拦下的不丢弃，计入汇总，想要的可以单独捞。
const maxDurationS = (Number(process.env.DUST_MAX_DURATION_MIN ?? 10) || 0) * 60;
// 下载后校验音轨。后半段用 ASR 提取内容，没有音轨这一条就等于白下。
// 实测最低码率档有 58% 是纯视频流，所以这个校验不是可选项。
const requireAudio = process.env.DUST_REQUIRE_AUDIO !== '0';
const dryRun = process.env.DUST_DRY_RUN === '1';

const log = (...a) => console.error('>>', ...a);
const die = msg => { console.error('ERROR:', msg); process.exit(1); };

if (!src) die('usage: node download.mjs <collection.json|-> [并发数=3]');

function which(bin) {
  return spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).status === 0;
}
for (const bin of ['curl', 'file']) if (!which(bin)) die(`缺少依赖 '${bin}'`);

function readInput() {
  const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  const j = JSON.parse(raw.trim().split('\n').filter(Boolean).pop());
  if (!j.items) die('输入 JSON 里没有 items，确认是 get_collection.mjs 的输出');
  return j;
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? res() : rej(new Error(`${cmd} exit ${code}: ${err.slice(-200)}`)));
    p.on('error', rej);
  });
}

/** 探测文件里有没有音轨。 */
function hasAudio(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return !!(r.stdout || '').trim();
  } catch { return false; }
}

/** 按给定地址列表逐个尝试下载，三关校验（大小 / MIME / 可选音轨）。 */
async function tryUrls(urls, mp4, { needAudio }) {
  const errors = [];
  for (const url of urls) {
    try {
      await run('curl', ['-sL', '--fail', '--max-time', '180',
        '-H', 'Referer: https://www.douyin.com/', '-H', `User-Agent: ${UA}`, '-o', mp4, url]);
      if (!(existsSync(mp4) && statSync(mp4).size > MIN_VALID_BYTES)) { errors.push('文件过小'); continue; }
      const mime = spawnSync('file', ['-b', '--mime-type', mp4], { encoding: 'utf8' }).stdout.trim();
      if (!mime.startsWith('video/')) { errors.push(`MIME 不是视频: ${mime}`); continue; }
      if (needAudio && !hasAudio(mp4)) { errors.push('无音轨'); return { ok: false, noAudio: true, errors }; }
      return { ok: true, errors };
    } catch (e) { errors.push(e.message.slice(0, 80)); }
  }
  return { ok: false, errors };
}

/** 下一条。返回 { aweme_id, status, ... }
 *  status: done | cached | skipped_gallery | skipped_too_long | skipped_no_url
 *          | skipped_expired | failed */
async function downloadOne(item) {
  const id = item.aweme_id;
  const base = { aweme_id: id, desc: (item.desc || '').slice(0, 40), author: item.author };

  if (item.is_gallery) return { ...base, status: 'skipped_gallery' };

  const dir = join(mediaRoot, id);
  const mp4 = join(dir, 'video.mp4');

  // 断点续：已经下好且体积合理就跳过。
  // 注意也要报音轨状态——早期版本下的文件可能是纯视频，上层据此决定要不要重下。
  if (existsSync(mp4) && statSync(mp4).size > MIN_VALID_BYTES) {
    return { ...base, status: 'cached', bytes: statSync(mp4).size, path: mp4,
             has_audio: requireAudio ? hasAudio(mp4) : null };
  }

  // 时长上限。放在 cached 之后：已经下好的就如实报 cached，
  // 不因为事后调低阈值就把既成事实说成「太长」。
  // 没有时长信息的（duration 为 0/null）一律放行，不猜。
  if (maxDurationS > 0 && item.duration_s && item.duration_s > maxDurationS) {
    return { ...base, status: 'skipped_too_long', duration_s: item.duration_s };
  }

  const urls = item.play_urls || [];
  if (!urls.length) return { ...base, status: 'skipped_no_url' };

  // CDN 地址带签名有时效（实测 3~24 小时不等）；过期了下也是 403，直接跳过并提示重扫
  if (isExpired(urls)) {
    return { ...base, status: 'skipped_expired', expired_at: expiryOf(urls) };
  }

  if (dryRun) return { ...base, status: 'would_download', bytes: item.size_bytes };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(item, null, 2));

  // ① 先试选中的档位（多 CDN 逐个 fallback）
  let r = await tryUrls(urls, mp4, { needAudio: requireAudio });
  if (r.ok) {
    return { ...base, status: 'done', bytes: statSync(mp4).size, gear: item.gear,
             path: mp4, has_audio: requireAudio ? true : null };
  }

  // ② 选中的档位没音轨 → 回落到 play_addr。
  //    网页播放器用的就是它，必然带音轨，代价是体积大 2.5-3.3 倍。
  const fb = item.play_urls_fallback || [];
  if (r.noAudio && fb.length) {
    const r2 = await tryUrls(fb, mp4, { needAudio: true });
    if (r2.ok) {
      return { ...base, status: 'done', bytes: statSync(mp4).size, gear: 'play_addr(音轨回落)',
               path: mp4, has_audio: true, fell_back: true };
    }
    r.errors.push(...r2.errors);
  }

  return { ...base, status: 'failed', tried: urls.length + fb.length, errors: r.errors.slice(0, 3) };
}

(async () => {
  const data = readInput();
  let items = data.items;

  // 先报计划，别让人稀里糊涂启动一个几千条的任务
  const galleries = items.filter(i => i.is_gallery).length;
  const videos = items.filter(i => !i.is_gallery);
  const tooLong = videos.filter(i => maxDurationS > 0 && i.duration_s && i.duration_s > maxDurationS);
  const noUrl = videos.filter(i => !(i.play_urls || []).length).length;
  const expired = videos.filter(i => (i.play_urls || []).length && isExpired(i.play_urls)).length;
  const willDownload = videos.filter(i => !(maxDurationS > 0 && i.duration_s && i.duration_s > maxDurationS));
  const totalBytes = willDownload.reduce((s, i) => s + (i.size_bytes || 0), 0);

  const age = data.fetched_at ? Math.floor(Date.now() / 1000) - data.fetched_at : null;
  log(`输入 ${items.length} 条` + (age !== null ? `（扫描于 ${Math.floor(age / 60)} 分钟前）` : ''));
  log(`  视频 ${videos.length} · 图集 ${galleries}（跳过）· 无地址 ${noUrl} · 地址已过期 ${expired}`);
  if (tooLong.length) {
    const cut = tooLong.reduce((s, i) => s + (i.size_bytes || 0), 0);
    log(`  超过 ${maxDurationS / 60} 分钟被拦下 ${tooLong.length} 条（省 ${fmtMB(cut)}），最长的几条：`);
    for (const i of tooLong.sort((a, b) => b.duration_s - a.duration_s).slice(0, 3)) {
      log(`     ${(i.duration_s / 60).toFixed(0)} 分钟  @${i.author}  ${(i.desc || '').slice(0, 30)}`);
    }
  }
  log(`  预计下载量 ${fmtMB(totalBytes)}，并发 ${concurrency}${dryRun ? ' · 【DRY RUN】' : ''}`);
  if (expired > 0) {
    log(`  ⚠️ ${expired} 条地址已过期（CDN 签名有时效，实测 3~24 小时不等），需要重跑 get_collection.mjs 拿新地址`);
  }

  if (items.length > limit) { items = items.slice(0, limit); log(`  受 DUST_LIMIT 限制，只处理前 ${limit} 条`); }

  // 简单 worker pool
  const results = [];
  let idx = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < items.length) {
      const item = items[idx++];
      const r = await downloadOne(item);
      results.push(r);
      done++;
      if (done % 10 === 0 || done === items.length) {
        const el = (Date.now() - t0) / 1000;
        log(`  [${done}/${items.length}] ${el.toFixed(0)}s  ${r.status}  ${r.desc || ''}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const by = {};
  for (const r of results) by[r.status] = (by[r.status] || 0) + 1;
  const bytes = results.reduce((s, r) => s + (r.bytes || 0), 0);
  const elapsed = (Date.now() - t0) / 1000;

  const fellBack = results.filter(r => r.fell_back).length;
  const silent = results.filter(r => r.has_audio === false).length;
  if (fellBack) log(`   ${fellBack} 条因所选档位无音轨，已回落 play_addr 重下`);
  if (silent) log(`   ⚠️ ${silent} 条缓存文件没有音轨（早期版本下的），ASR 用不了，需重下`);
  log(`完成，用时 ${elapsed.toFixed(0)}s，落盘 ${fmtMB(bytes)}`);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) log(`   ${k}: ${v}`);
  if (by.failed) log(`   ⚠️ ${by.failed} 条全部 CDN 地址都失败，详见输出 JSON 的 errors 字段`);

  console.log(JSON.stringify({
    ok: true,
    cache_root: mediaRoot,
    elapsed_s: Math.round(elapsed),
    bytes,
    summary: by,
    results,
  }));
})().catch(e => die(e.message));
