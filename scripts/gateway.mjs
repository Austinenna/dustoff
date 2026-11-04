// AI 网关：调用标记、预算拒绝与费用查询。费用由网关按单价估算，不是厂商账单。
import { makeCfg } from './config.mjs';
import { PauseError } from './policy.mjs';

// 网关地址默认取用途模型的地址；用途、转写、笔记三处共用同一个网关项目。
export function gatewayConfig(cfg = makeCfg()) {
  return {
    base: cfg('DUST_GATEWAY_BASE', cfg('DUST_ROUTER_BASE', 'http://127.0.0.1:8317/v1')),
    key: cfg('DUST_GATEWAY_KEY', cfg('DUST_ROUTER_KEY', '')),
  };
}

// 网关只收 1–128 个字母、数字和 ._:-，格式不对整次请求会被 400 拒绝，所以先整理。
export function tagValue(value) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 128);
  return /[A-Za-z0-9]/.test(text) ? text : '';
}

const originOf = url => { try { return new URL(url).origin; } catch { return null; } };

/** 只给网关本身加标记；直连厂商时不带，避免把作品 ID 发给第三方。 */
export function usageTags(endpoint, { category, task } = {}, config = gatewayConfig()) {
  const origin = originOf(endpoint);
  if (!origin || origin !== originOf(config.base)) return {};
  const headers = {}, c = tagValue(category), t = tagValue(task);
  if (c) headers['X-Gateway-Category'] = c;
  if (t) headers['X-Gateway-Task-ID'] = t;
  return headers;
}

// 预算用完时整轮暂停：重试和换下一条都只会再被拒绝，等作者提高预算或下月恢复。
export class BudgetError extends PauseError {}
export function budgetError(status, body) {
  if (status !== 402) return null;
  return new BudgetError(`AI 网关：${body?.error?.message || '本月预算已用完，已拒绝本次请求'}`);
}

export function usageEndpoint(base) {
  const url = new URL(base);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('网关地址须为 HTTPS 或本机 HTTP 地址，不能含凭据或参数');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/usage';
  return url.href;
}

const PARAMS = ['period', 'from', 'to', 'group_by', 'category', 'task', 'model', 'request_id', 'limit'];
export async function fetchUsage(params = {}, { config = gatewayConfig(), fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!config.key) throw new Error('未配置网关项目 Token（DUST_ROUTER_KEY）');
  const url = new URL(usageEndpoint(config.base));
  for (const key of PARAMS) if (params[key] !== undefined && params[key] !== '') url.searchParams.set(key, String(params[key]));
  let res;
  try { res = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${config.key}` } }); }
  catch { throw new Error('网关用量接口连接失败或超时'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`网关用量接口 HTTP ${res.status}${body?.error?.message ? `：${body.error.message}` : ''}`);
  return body;
}

// 控制台只需要这些字段；未定价、用量未知、用量不完整的次数单独保留，不能当成 0。
const totals = t => ({
  requests: t?.requests || 0, cost: t?.cost || 0,
  unpriced: t?.unpriced || 0, usage_unknown: t?.usage_unknown || 0, usage_partial: t?.usage_partial || 0,
});
export async function costSummary(options) {
  const [month, today] = await Promise.all([
    fetchUsage({ period: 'month', group_by: 'category' }, options),
    fetchUsage({ period: 'today' }, options),
  ]);
  return {
    currency: month.currency || 'CNY',
    month: { ...totals(month.total), groups: (month.groups || []).map(g => ({ key: g.key, label: g.label, ...totals(g) })) },
    today: totals(today.total),
    budget: month.budget || null,
  };
}
export async function itemCost(id, options) {
  const task = tagValue(id);
  if (!task) throw new Error('作品 ID 无效');
  const data = await fetchUsage({ period: 'all', task, group_by: 'category' }, options);
  return { currency: data.currency || 'CNY', ...totals(data.total), groups: (data.groups || []).map(g => ({ key: g.key, label: g.label, ...totals(g) })) };
}
