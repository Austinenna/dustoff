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
//
// 说明: play_urls 内含签名且有时效（约数小时），拿到后应尽快下载，不要隔天复用。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickLowestGear, isGallery, expiryOf } from './lib.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME = process.env.DUST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.DUST_CDP_PORT || 9333);

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
    const r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA } });
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
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
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
    pending.set(mid, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  return { send, on: fn => listeners.push(fn) };
}

let chrome, profile;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  try { profile && rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

(async () => {
  const videoUrl = await resolveVideoUrl(input);

  profile = mkdtempSync(join(tmpdir(), 'dy-cdp-'));
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

  let detailReqId = null;
  on(m => {
    if (m.method === 'Network.responseReceived' &&
        m.params.response.url.includes('aweme/v1/web/aweme/detail')) {
      detailReqId = m.params.requestId;
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
  if (!body) throw new Error('未截获 aweme/detail 响应（视频可能已删除/私密，或页面结构变化）');

  const j = JSON.parse(body);
  const a = j.aweme_detail;
  if (!a) throw new Error('响应内无 aweme_detail');
  const v = a.video || {};
  // 只要内容不要原件，所以默认给最低码率档（实测 0.73MB vs play_addr 2.39MB）。
  // play_urls_hq 保留原来的 play_addr，需要高清时可以用。
  const gallery = isGallery(a);
  const gear = gallery ? null : pickLowestGear(a);
  const hq = (v.play_addr && v.play_addr.url_list) || [];
  const out = {
    ok: true,
    aweme_id: a.aweme_id,
    aweme_type: a.aweme_type ?? null,
    is_gallery: gallery,
    desc: a.desc || '',
    author: (a.author && a.author.nickname) || '',
    create_time: a.create_time || null,
    duration_s: Math.round((v.duration || 0) / 1000),
    // 默认下载用的地址 = 最低档；拿不到档位时自动回退到 play_addr
    play_urls: gear && gear.urls.length ? gear.urls : hq,
    play_urls_hq: hq,
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
  console.log(JSON.stringify(out));
  ws.close(); cleanup(); process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); cleanup(); process.exit(1); });
