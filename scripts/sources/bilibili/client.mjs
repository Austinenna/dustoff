// B 站 Web 接口：带登录 Cookie 直连，限速、WBI 签名、风控时只暂停 B 站。
// Cookie 只在本机数据目录保存，不写日志、不回传网页。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUST_HOME, makeCfg } from '../../config.mjs';
import { PauseError, atomicWrite, localPath, requestSignal } from '../../policy.mjs';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const REFERER = 'https://www.bilibili.com/';
export const API = 'https://api.bilibili.com';
export const cookieFile = (home = DUST_HOME) => localPath(join(home, 'bilibili', 'cookies.json'));
export const sessionFile = (home = DUST_HOME) => localPath(join(home, 'state', 'bilibili-session.json'));

export class LoginError extends Error { constructor(message = 'B站登录已失效，请在控制台重新扫码') { super(message); this.code = 4; } }
/** 风控或限流：本轮暂停 B 站的全部处理，其他平台继续。 */
export class PlatformPause extends PauseError { constructor(message) { super(message); this.scope = 'platform'; this.platform = 'bilibili'; } }

export const isBiliCookie = c => /(^|\.)bilibili\.com$/i.test(c?.domain || '');
export function readCookies(home = DUST_HOME) {
  const file = cookieFile(home);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(data) ? data.filter(isBiliCookie) : [];
}
export function saveCookies(cookies, home = DUST_HOME) {
  const kept = cookies.filter(isBiliCookie).map(c => ({ name:c.name, value:c.value, domain:c.domain, path:c.path || '/', expires:c.expires > 0 ? c.expires : null, secure:!!c.secure, httpOnly:!!c.httpOnly }));
  atomicWrite(cookieFile(home), JSON.stringify(kept) + '\n');
  return kept;
}
const alive = (c, now) => !c.expires || c.expires < 0 || c.expires > now;
export function biliSession(cookies, now = Date.now() / 1000) {
  const sess = cookies.find(c => isBiliCookie(c) && c.name === 'SESSDATA' && c.value && alive(c, now));
  const mid = cookies.find(c => isBiliCookie(c) && c.name === 'DedeUserID' && /^\d+$/.test(c.value || ''))?.value || null;
  return { loggedIn: !!sess && !!mid, expiresAt: sess?.expires > 0 ? Math.floor(sess.expires) : null, mid };
}
export function cookieHeader(cookies, now = Date.now() / 1000) {
  return cookies.filter(c => isBiliCookie(c) && c.value && alive(c, now) && /^[\w-]+$/.test(c.name) && !/[;\r\n]/.test(c.value))
    .map(c => `${c.name}=${c.value}`).join('; ');
}

// ── WBI 签名（公开算法，见 bilibili-API-collect docs/misc/sign/wbi.md）──
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export const mixinKey = (img, sub) => MIXIN.map(i => (img + sub)[i]).join('').slice(0, 32);
const keyOf = url => String(url || '').split('/').pop().split('.')[0];
export function signWbi(params, { img, sub }, wts = Math.floor(Date.now() / 1000)) {
  const all = { ...params, wts };
  const query = Object.keys(all).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixinKey(img, sub)).digest('hex')}`;
}

const delay = ms => new Promise(r => setTimeout(r, ms));
export function createClient({ cookies = readCookies(), fetchImpl = fetch, interval = Number(makeCfg()('DUST_BILI_INTERVAL_MS', 1500)), sleep = delay, now = Date.now } = {}) {
  let last = 0, wbi = null;
  const cookie = cookieHeader(cookies);
  async function request(url, { raw = false } = {}) {
    const wait = last + interval - now();
    if (wait > 0) await sleep(wait);
    last = now();
    let res;
    try {
      res = await fetchImpl(url, { redirect:'error', signal:requestSignal(), headers:{ 'User-Agent':UA, Referer:REFERER, ...(cookie ? { Cookie:cookie } : {}) } });
    } catch (e) { if (e instanceof PauseError) throw e; throw new Error('B站接口连接失败或超时'); }
    if (res.status === 412 || res.status === 429) { await res.body?.cancel(); throw new PlatformPause(`B站请求被限流（HTTP ${res.status}），本轮暂停 B站`); }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`B站接口 HTTP ${res.status}`); }
    if (raw) return res;
    let body;
    try { body = await res.json(); } catch { throw new Error('B站接口返回格式无效'); }
    if (body.code === -101) throw new LoginError();
    if (body.code === -352 || body.code === -412 || body.code === -509) throw new PlatformPause(`B站请求触发风控（${body.code}），本轮暂停 B站`);
    if (body.code !== 0) { const e = new Error(`B站接口 ${body.code}：${String(body.message || '').slice(0, 80)}`); e.biliCode = body.code; throw e; }
    return body.data;
  }
  async function keys() {
    if (wbi) return wbi;
    const res = await request(`${API}/x/web-interface/nav`, { raw:true });
    const body = await res.json().catch(() => ({}));
    const img = keyOf(body?.data?.wbi_img?.img_url), sub = keyOf(body?.data?.wbi_img?.sub_url);
    if (!/^[0-9a-f]{32}$/.test(img) || !/^[0-9a-f]{32}$/.test(sub)) throw new Error('未取得 B站签名参数');
    return wbi = { img, sub, nav: body.data };
  }
  return {
    get: (path, params = {}) => request(`${API}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`),
    getWbi: async (path, params = {}) => request(`${API}${path}?${signWbi(params, await keys())}`),
    /** 当前 Cookie 对应的账号；未登录时抛 LoginError。 */
    nav: async () => { const { nav } = await keys(); if (!nav?.isLogin) throw new LoginError(); return { mid: String(nav.mid), name: nav.uname || '' }; },
    fetchRaw: url => request(url, { raw:true }),
    loggedIn: biliSession(cookies).loggedIn,
  };
}
