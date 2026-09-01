#!/usr/bin/env node
// dustoff / login.mjs
// 一次性：打开有头 Chrome（使用固定 profile 目录）让你扫码登录抖音，
// 检测到登录态（sessionid cookie）后自动确认并退出。登录态留在 profile 里，
// 之后 get_collection.mjs 复用同一 profile 即可带着你的身份访问收藏夹。
//
// 用法:  node login.mjs
// 环境变量:
//   DUST_PROFILE  持久化 profile 目录（默认 ~/.dustoff/chrome-profile）
//   DUST_CHROME   Chrome 路径

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CHROME = process.env.DUST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = process.env.DUST_PROFILE || join(homedir(), '.dustoff', 'chrome-profile');
const PORT = Number(process.env.DUST_CDP_PORT || 9334);
const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  'https://www.douyin.com/',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGTERM'); } catch {} };
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome CDP 未就绪');
}

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdp(ws);

  console.error('>> 已打开 Chrome。请在弹出的窗口里点「登录」并用抖音 App 扫码。');
  console.error('>> 登录成功后本脚本会自动检测并退出（最长等待 5 分钟）...');

  let lastErr = null;
  for (let i = 0; i < 150; i++) {           // 150 * 2s = 5min
    await sleep(2000);
    try {
      // Network.getCookies 是页面级方法，浏览器级连接上不存在（CDP 报 -32601）。
      // 浏览器级要用 Storage.getCookies，它返回所有域的 cookie，需自行按域过滤。
      const { cookies } = await send('Storage.getCookies', {});
      const hasSession = cookies.some(c =>
        /(^|\.)douyin\.com$/.test(c.domain.replace(/^\./, '.')) &&
        /^sessionid(_ss)?$/.test(c.name) && c.value);
      if (hasSession) {
        console.error('\n>> ✅ 检测到登录态，已保存到 profile：' + PROFILE);
        console.error('>> 你可以关闭那个 Chrome 窗口了。收藏夹自动同步已就绪。');
        cleanup();
        await sleep(500);
        process.exit(0);
      }
    } catch (e) {
      // 不要静默吞错：同一条错误只提示一次，避免刷屏但也不至于让人干等 5 分钟
      const msg = String(e && e.message || e);
      if (msg !== lastErr) { lastErr = msg; console.error('>> ⚠️ 登录态检测出错（仍在重试）: ' + msg); }
    }
  }
  console.error('\n>> ⏰ 等待超时（5 分钟内未检测到登录）。可重跑本脚本再试。');
  cleanup();
  process.exit(1);
})().catch(e => { console.error('ERROR:', e.message); cleanup(); process.exit(1); });
