// X API v2 只读客户端：自动续期令牌，限流或额度用尽时只暂停 X。
import { DUST_HOME, makeCfg } from '../../config.mjs';
import { PauseError, requestSignal } from '../../policy.mjs';
import { LoginError, accessToken, appConfig } from './auth.mjs';

export const API = 'https://api.x.com/2';
/** 限流、额度用尽或接口拒绝服务：本轮暂停 X 的全部处理，其他平台继续。 */
export class PlatformPause extends PauseError { constructor(message) { super(message); this.scope = 'platform'; this.platform = 'x'; } }

// 书签条目需要的字段：正文（含长帖）、X 长文（Articles）全文、作者、媒体、链接、引用推文。
export const TWEET_PARAMS = Object.freeze({
  'tweet.fields': 'created_at,author_id,attachments,entities,note_tweet,article,conversation_id,referenced_tweets,lang',
  expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
  'media.fields': 'type,url,preview_image_url,duration_ms,variants,width,height,alt_text',
  'user.fields': 'username,name',
});

const delay = ms => new Promise(r => setTimeout(r, ms));
export function createClient({ home = DUST_HOME, app = appConfig(), fetchImpl = fetch, interval = Number(makeCfg()('DUST_X_INTERVAL_MS', 1000)), sleep = delay, now = Date.now } = {}) {
  let last = 0;
  async function request(path, params = {}, retried = false) {
    const wait = last + interval - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const token = await accessToken({ home, app, fetchImpl, force: retried });
    const url = `${API}${path}${Object.keys(params).length ? '?' + new URLSearchParams(params) : ''}`;
    let res;
    try { res = await fetchImpl(url, { redirect: 'error', signal: requestSignal(), headers: { Authorization: `Bearer ${token}` } }); }
    catch (e) { if (e instanceof PauseError) throw e; throw new Error('X 接口连接失败或超时（检查代理）'); }
    if (res.status === 401) { await res.body?.cancel(); if (!retried) return request(path, params, true); throw new LoginError(); }
    if (res.status === 429) { await res.body?.cancel(); throw new PlatformPause('X 接口被限流（HTTP 429），本轮暂停 X'); }
    const body = await res.json().catch(() => null);
    if (res.status === 402 || (res.status === 403 && /credit|enroll|plan|access level/i.test(JSON.stringify(body || {}))))
      throw new PlatformPause(`X 接口拒绝服务（HTTP ${res.status}）：${detail(body)}；请检查开发者控制台额度与应用设置`);
    if (!res.ok) throw new Error(`X 接口 HTTP ${res.status}：${detail(body)}`);
    if (!body) throw new Error('X 接口返回格式无效');
    // 整体失败时 data 为空且带 errors；部分失败（如个别引用推文已删除）照常返回 data。
    if (!body.data && body.errors?.length && !body.meta) throw new Error(`X 接口：${detail(body)}`);
    return body;
  }
  return {
    get: request,
    me: async () => { const b = await request('/users/me', { 'user.fields': 'username,name' }); return { id: String(b.data.id), username: b.data.username || '', name: b.data.name || '' }; },
    bookmarks: (userId, { max = 100, cursor } = {}) => request(`/users/${encodeURIComponent(userId)}/bookmarks`, { max_results: String(max), ...(cursor ? { pagination_token: cursor } : {}), ...TWEET_PARAMS }),
  };
}
const detail = body => String(body?.detail || body?.title || body?.errors?.[0]?.detail || body?.errors?.[0]?.message || '未知错误').slice(0, 160);
export { LoginError };
