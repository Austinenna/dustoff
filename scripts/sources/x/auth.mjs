// X 官方接口授权：OAuth 2.0 授权码 + PKCE，只申请读书签所需的只读权限。
// 应用的 Client ID / Secret 只放在 dustoff.conf；令牌存在数据目录，不写日志、不回传网页。
// X 的刷新令牌一次性有效，每次刷新都要立刻保存新令牌，否则下次无法续期。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUST_HOME, makeCfg } from '../../config.mjs';
import { atomicWrite, localPath, requestSignal } from '../../policy.mjs';

export const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'];
export const CALLBACK_PATH = '/x/callback';
export const tokenFile = (home = DUST_HOME) => localPath(join(home, 'x', 'token.json'));
export const sessionFile = (home = DUST_HOME) => localPath(join(home, 'state', 'x-session.json'));

export class LoginError extends Error { constructor(message = 'X 授权已失效，请在控制台重新连接 X') { super(message); this.code = 4; } }

export function appConfig(cfg = makeCfg()) {
  return { clientId: cfg('DUST_X_CLIENT_ID', ''), clientSecret: cfg('DUST_X_CLIENT_SECRET', '') };
}
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const challengeOf = verifier => b64url(createHash('sha256').update(verifier).digest());

/** 生成一次授权请求。state 与 verifier 由调用方保存在服务端，回调时核对。 */
export function startAuthorization({ clientId, redirectUri }) {
  if (!clientId) throw new Error('尚未配置 DUST_X_CLIENT_ID，请先在 dustoff.conf 填写 X 应用的 Client ID');
  const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPES.join(' '),
    state, code_challenge: challengeOf(verifier), code_challenge_method: 'S256' }).toString();
  return { url: url.href, state, verifier, redirectUri };
}

async function tokenRequest(params, { clientId, clientSecret }, fetchImpl) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // 机密客户端（Web App）用 Basic 认证；未配置 Secret 时按公开客户端只带 client_id。
  if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  let res;
  try { res = await fetchImpl(TOKEN_URL, { method: 'POST', redirect: 'error', signal: requestSignal(), headers, body: new URLSearchParams({ ...params, client_id: clientId }).toString() }); }
  catch { throw new Error('连接 X 授权服务失败或超时'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const reason = String(body.error_description || body.error || `HTTP ${res.status}`).slice(0, 160);
    if (res.status === 400 || res.status === 401) throw new LoginError(`X 授权未通过：${reason}`);
    throw new Error(`X 授权服务出错：${reason}`);
  }
  const now = Math.floor(Date.now() / 1000);
  return { access_token: body.access_token, refresh_token: body.refresh_token || null, scope: body.scope || '', expires_at: now + (Number(body.expires_in) || 7200), obtained_at: now };
}

export const exchangeCode = ({ code, verifier, redirectUri, app = appConfig(), fetchImpl = fetch }) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, app, fetchImpl);

export function readToken(home = DUST_HOME) {
  const file = tokenFile(home);
  if (!existsSync(file)) return null;
  try { const t = JSON.parse(readFileSync(file, 'utf8')); return t?.access_token ? t : null; } catch { return null; }
}
export function saveToken(token, home = DUST_HOME) { atomicWrite(tokenFile(home), JSON.stringify(token) + '\n'); return token; }

export function recordSession(patch, home = DUST_HOME) {
  let old = {};
  try { old = JSON.parse(readFileSync(sessionFile(home), 'utf8')); } catch {}
  atomicWrite(sessionFile(home), JSON.stringify({ ...old, ...patch, last_check_at: Math.floor(Date.now() / 1000) }) + '\n');
}

/**
 * 返回可用的访问令牌；到期前 5 分钟或 force 时用刷新令牌续期并立即保存。
 * 调用方需持有流水线锁，避免两个进程同时用同一个一次性刷新令牌。
 */
export async function accessToken({ home = DUST_HOME, app = appConfig(), fetchImpl = fetch, force = false, now = () => Date.now() / 1000 } = {}) {
  const token = readToken(home);
  if (!token) throw new LoginError('尚未连接 X，请在控制台点击「连接 X」');
  if (!force && token.expires_at - 300 > now()) return token.access_token;
  if (!token.refresh_token) throw new LoginError();
  if (!app.clientId) throw new Error('尚未配置 DUST_X_CLIENT_ID');
  const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token }, app, fetchImpl);
  saveToken({ ...token, ...next, refresh_token: next.refresh_token || token.refresh_token }, home);
  return next.access_token;
}
