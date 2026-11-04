#!/usr/bin/env node
// dustoff / get_meta.mjs
// 零依赖（Node>=21 自带 WebSocket）：启动系统 headless Chrome，用 CDP 截获抖音
// 页面自己发出的 aweme/detail 响应体，输出视频元数据 + 真实 CDN 直链（JSON 一行）。
//
// 用法:
//   node get_meta.mjs <抖音视频链接|分享短链>
// 输出 (stdout, 单行 JSON):
//   { ok, aweme_id, aweme_type, is_gallery, desc, author, create_time, duration_s,
//     play_urls:[最低码率档], play_urls_hq:[原 play_addr], gear, size_bytes,
//     url_expires_at, cover }
// 失败时 stderr 打印 "ERROR: ..." 且退出码非 0。
//   作品已失效（删除/不可见）：stdout 输出 { ok:false, unavailable:true, message }，退出码 0。
//   详情接口返回空内容（被风控拦截）：退出码 7，调用方本轮暂停抖音、不计这条的失败次数。
//
// 说明: play_urls 内含签名且有时效（约数小时），拿到后应尽快下载，不要隔天复用。
// 使用扫描收藏的同一份登录资料：不带登录的临时浏览器会被风控拦下（详情接口返回空内容）。
// 调用方持有流水线锁，与扫描、扫码登录串行，不会同时占用这份资料。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestSignal, localPath } from './policy.mjs';
import { DUST_HOME, makeCfg } from './config.mjs';
import { galleryImages, videoOptions, pickGear, isGallery, expiryOf, articleOf } from './lib.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME = process.env.DUST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.DUST_CDP_PORT || 9333);
const LOGIN_PROFILE = localPath(makeCfg()('DUST_PROFILE', join(DUST_HOME, 'chrome-profile')));
const BLOCKED_EXIT = 7;
class Blocked extends Error {}

const input = process.argv[2];
if (!input) { console.error('usage: node get_meta.mjs <douyin url>'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) 解析出 douyin.com 正式视频页 URL（支持 v.douyin.com 短链）
async function resolveVideoUrl(raw) {
  let url = raw.trim();
  // 直接含 aweme_id 的情况
  let m = url.match(/(?:video|note)\/(\d{15,})/) || url.match(/aweme_id=(\d{15,})/) || url.match(/modal_id=(\d{15,})/);
  if (m) return `https://www.douyin.com/video/${m[1]}`;
  // 短链 / 其他：跟随重定向找 id
  try {
    const r = await fetch(url, { signal: requestSignal(), method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA } });
    const finalUrl = r.url || url;
    m = finalUrl.match(/(?:video|note)\/(\d{15,})/) || finalUrl.match(/\/(\d{15,})/);
    if (m) return `https://www.douyin.com/video/${m[1]}`;
    const txt = await r.text();
    m = txt.match(/(?:aweme_id|video\/|itemId["']?\s*[:=]\s*["']?)(\d{15,})/);
    if (m) return `https://www.douyin.com/video/${m[1]}`;
  } catch {}
  // 兜底：原样交给浏览器
  return url;
}

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: requestSignal() });
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome CDP 未就绪（检查 Chrome 路径 / 端口占用）');
}

function cdp(ws) {
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach(fn => fn(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('CDP 请求超时')); }, 15000);
    pending.set(mid, m => { clearTimeout(timer); m.error ? rej(new Error(m.error.message)) : res(m.result); });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  return { send, on: fn => listeners.push(fn) };
}

let chrome, profile, tempProfile = false;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  // 只删自己建的临时资料，登录资料保留。
  try { tempProfile && profile && rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

/**
 * 把 JSON 写到 stdout，**等真正冲刷完**再退出。
 *
 * 不能写成 console.log(...) + process.exit()：stdout 是管道时写入是异步的，
 * 超过管道缓冲区（macOS 64 KB）的部分会排队，而 process.exit() 立刻终止进程，
 * 排队的部分直接丢弃——结果就是一个正好 65536 字节、被腰斩的 JSON。
 *
 * 这个坑只在被父进程用管道接收时才出现：直接跑到终端（TTY）或
 * shell 重定向到文件都是同步写，看不出问题。所以它潜伏到
 * sync.mjs 第一次接管扫描输出时才暴露。
 */
function emit(obj, code = 0, done = null) {
  process.stdout.write(JSON.stringify(obj) + '\n', () => { if (done) done(); process.exit(code); });
}


(async () => {
  const videoUrl = await resolveVideoUrl(input);

  if (existsSync(LOGIN_PROFILE)) profile = LOGIN_PROFILE;
  else { profile = mkdtempSync(join(tmpdir(), 'dy-cdp-')); tempProfile = true; console.error('提示：未找到登录资料，用临时浏览器读取，可能被风控拦截'); }
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--mute-audio', `--user-agent=${UA}`,
  ], { stdio: 'ignore' });

  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const { send, on } = cdp(ws);

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Network.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  let detailReqId = null, detailStatus = null;
  on(m => {
    if (m.method === 'Network.responseReceived' &&
        m.params.response.url.includes('aweme/v1/web/aweme/detail')) {
      detailReqId = m.params.requestId; detailStatus = m.params.response.status;
    }
  });

  await send('Page.navigate', { url: videoUrl }, sessionId);

  let body = null;
  for (let i = 0; i < 45; i++) {
    await sleep(400);
    if (detailReqId) {
      try {
        const r = await send('Network.getResponseBody', { requestId: detailReqId }, sessionId);
        if (r.body && r.body.length > 10) { body = r.body; break; }
      } catch {}
    }
  }
  // 有详情请求却始终拿不到内容：被风控拦下（实测不带登录时 HTTP 200、内容为空）。
  if (!body) throw detailReqId ? new Blocked(`详情接口返回空内容（HTTP ${detailStatus}），疑似被风控拦截`) : new Blocked('页面没有发出详情请求，疑似被风控拦截或页面结构变化');

  let j;
  try { j = JSON.parse(body); } catch { throw new Error('详情接口返回的不是 JSON'); }
  const a = j.aweme_detail;
  // 作品被删除或设为不可见时，接口正常返回但没有作品内容，附带过滤说明。
  if (!a || a.status?.is_delete) {
    const reason = j.filter_detail?.detail_msg || j.filter_detail?.filter_reason || j.status_msg || (a?.status?.is_delete ? '作品已删除' : '接口未返回作品内容');
    emit({ ok: false, unavailable: true, message: String(reason).slice(0, 200), status_code: j.status_code ?? null }, 0, () => { ws.close(); cleanup(); });
    return;
  }
  const v = a.video || {};
  // 只要内容不要原件，所以默认给最低码率档（实测 0.73MB vs play_addr 2.39MB）。
  // play_urls_hq 保留原来的 play_addr，需要高清时可以用。
  const gallery = isGallery(a);
  const gear = gallery ? null : pickGear(a, { requireAudio: true });
  const hq = (v.play_addr && v.play_addr.url_list) || [];
  const out = {
    ok: true,
    aweme_id: a.aweme_id,
    aweme_type: a.aweme_type ?? null,
    is_gallery: gallery,
    images: gallery ? galleryImages(a) : [],
    video_options: gallery ? null : videoOptions(a),
    desc: a.desc || '',
    author: (a.author && a.author.nickname) || '',
    create_time: a.create_time || null,
    duration_s: v.duration ? v.duration / 1000 : null,
    // 默认下载用的地址 = 最低档；拿不到档位时自动回退到 play_addr
    play_urls: gear && gear.urls.length ? gear.urls : hq,
    play_urls_hq: hq, play_urls_fallback: hq,
    gear: gear ? gear.gear : null,
    gear_source: gear ? gear.source : null,
    gear_count: gear ? gear.gear_count : 0,
    width: gear ? gear.width : null,
    height: gear ? gear.height : null,
    size_bytes: gear ? gear.size : null,
    url_expires_at: gear ? expiryOf(gear.urls.length ? gear.urls : hq) : expiryOf(hq),
    cover: (v.cover && v.cover.url_list && v.cover.url_list[0]) || null,
    source_url: videoUrl,
  };
  // 文章类作品按文字帖处理：带上正文，不当作视频下载。
  const article = articleOf(a);
  if (article) Object.assign(out, { media_type: 'post', is_article: true, article_title: article.title, article_markdown: article.markdown, duration_s: null });
  emit(out, 0, () => { ws.close(); cleanup(); });
})().catch(e => { console.error('ERROR:', e.message); cleanup(); process.exit(e instanceof Blocked ? BLOCKED_EXIT : 1); });
