import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetError, costSummary, fetchUsage, gatewayConfig, itemCost, tagValue, usageEndpoint, usageTags } from '../scripts/gateway.mjs';
import { classifyItem } from '../scripts/routing.mjs';
import { asrOnce, PermanentError } from '../scripts/asr-client.mjs';
import { PauseError } from '../scripts/policy.mjs';

const gateway = { base: 'http://127.0.0.1:8317/v1', key: 'fixture-project-token' };
const budget = { error: { type: 'budget_exceeded', message: '项目「dustoff」本月预算 ¥30 已用完（已用 ¥30.12），网关已拒绝本次请求。', monthly_budget: 30, month_spent: 30.12 } };

test('网关地址默认取用途模型地址，可单独覆盖', () => {
  const cfg = values => (key, fallback) => values[key] || fallback;
  assert.deepEqual(gatewayConfig(cfg({ DUST_ROUTER_BASE: 'https://gw.example.invalid/v1', DUST_ROUTER_KEY: 'k1' })), { base: 'https://gw.example.invalid/v1', key: 'k1' });
  assert.deepEqual(gatewayConfig(cfg({ DUST_ROUTER_KEY: 'k1', DUST_GATEWAY_BASE: 'https://other.invalid/v1', DUST_GATEWAY_KEY: 'k2' })), { base: 'https://other.invalid/v1', key: 'k2' });
});

test('标记值整理成网关接受的格式，只发给网关本身', () => {
  assert.equal(tagValue('BV1xx411c7mD'), 'BV1xx411c7mD');
  assert.equal(tagValue('note 12/34'), 'note_12_34');
  assert.equal(tagValue('a'.repeat(200)).length, 128);
  assert.equal(tagValue('///'), '');
  assert.equal(tagValue(undefined), '');
  assert.deepEqual(usageTags('http://127.0.0.1:8317/v1/chat/completions', { category: 'note', task: '7600000000000000001' }, gateway),
    { 'X-Gateway-Category': 'note', 'X-Gateway-Task-ID': '7600000000000000001' });
  assert.deepEqual(usageTags('http://127.0.0.1:8317/v1/asr/transcriptions', { category: 'asr' }, gateway), { 'X-Gateway-Category': 'asr' });
  assert.deepEqual(usageTags('https://open.bigmodel.cn/api/paas/v4/chat/completions', { category: 'note', task: 'x1' }, gateway), {});
});

test('用途请求带标记；402 预算用完整轮暂停并显示网关说明', async () => {
  let headers;
  await classifyItem({ id: 'BV1test00001', desc: '跳舞' }, { config: { ...gateway, model: 'glm' }, gateway, fetchImpl: async (url, options) => {
    headers = options.headers;
    return Response.json({ choices: [{ message: { content: '{"purpose":"video","reason":"舞蹈"}' } }] });
  } });
  assert.equal(headers['X-Gateway-Category'], 'router');
  assert.equal(headers['X-Gateway-Task-ID'], 'BV1test00001');
  await assert.rejects(() => classifyItem({ id: '1' }, { config: { ...gateway, model: 'glm' }, gateway, fetchImpl: async () => Response.json(budget, { status: 402 }) }),
    e => e instanceof BudgetError && e instanceof PauseError && !e.scope && e.message.includes('本月预算 ¥30 已用完'));
});

test('转写 402 不标成永久失败', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dustoff-gw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.mp3'); writeFileSync(file, 'fixture');
  let headers;
  t.mock.method(globalThis, 'fetch', async (url, options) => { headers = options.headers; return Response.json(budget, { status: 402 }); });
  await assert.rejects(() => asrOnce(file, { endpoint: 'http://127.0.0.1:8317/v1/asr/transcriptions', key: 'fixture-project-token', model: 'qwen-asr', lang: 'zh', task: '7600000000000000001', gateway }),
    e => e instanceof BudgetError && !(e instanceof PermanentError));
  assert.equal(headers['X-Gateway-Category'], 'asr');
  assert.equal(headers['X-Gateway-Task-ID'], '7600000000000000001');
});

test('费用查询：本月按用途、今天合计、单条作品，保留未计价次数', async () => {
  assert.equal(usageEndpoint('http://127.0.0.1:8317/v1/'), 'http://127.0.0.1:8317/v1/usage');
  assert.equal(usageEndpoint('https://gw.example.invalid/v1/chat/completions'), 'https://gw.example.invalid/v1/usage');
  assert.throws(() => usageEndpoint('http://remote.invalid/v1'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), auth: options.headers.Authorization });
    const q = new URL(url).searchParams;
    if (q.get('period') === 'today') return Response.json({ currency: 'CNY', total: { requests: 2, cost: 0.03 } });
    return Response.json({ currency: 'CNY', total: { requests: 5, cost: 1.2, unpriced: 1, usage_unknown: 0, usage_partial: 2 },
      groups: [{ key: 'note', label: 'note', requests: 3, cost: 1.1 }, { key: '', label: '未标记', requests: 2, cost: 0.1, unpriced: 1 }],
      budget: { monthly_budget: null, month_spent: 1.2, remaining: null, exceeded: false } });
  };
  const summary = await costSummary({ config: gateway, fetchImpl });
  assert.equal(summary.month.cost, 1.2);
  assert.equal(summary.month.unpriced, 1);
  assert.equal(summary.month.usage_partial, 2);
  assert.equal(summary.today.cost, 0.03);
  assert.equal(summary.budget.monthly_budget, null);
  assert.equal(summary.month.groups[1].unpriced, 1);
  assert.ok(calls.every(c => c.auth === 'Bearer fixture-project-token'));
  calls.length = 0;
  await itemCost('BV1test00001', { config: gateway, fetchImpl });
  assert.equal(calls[0].url.searchParams.get('task'), 'BV1test00001');
  assert.equal(calls[0].url.searchParams.get('period'), 'all');
  await assert.rejects(() => fetchUsage({}, { config: { ...gateway, key: '' }, fetchImpl }), /未配置网关项目 Token/);
  await assert.rejects(() => fetchUsage({}, { config: gateway, fetchImpl: async () => Response.json({ error: { message: '无权限' } }, { status: 403 }) }), /HTTP 403：无权限/);
});
