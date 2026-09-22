import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DASHSCOPE_ENDPOINT, readAsrConfig, asrOnce, PermanentError } from '../scripts/asr-client.mjs';

const gateway = 'http://127.0.0.1:8317/v1/asr/transcriptions';
const options = { endpoint: gateway, key: 'fixture-project-token', model: 'qwen-asr', lang: 'zh' };
const cfg = values => (key, fallback) => values[key] || fallback;

function audioFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dustoff-asr-'));
  const file = join(dir, 'fixture.mp3');
  const bytes = Buffer.from('fixture-audio-not-a-real-recording');
  writeFileSync(file, bytes);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file, bytes };
}

test('未配置网关时保留百炼直连、原密钥和模型默认值', () => {
  assert.deepEqual(readAsrConfig(cfg({ DUST_DASHSCOPE_KEY: 'fixture-vendor-key' })), {
    endpoint: DASHSCOPE_ENDPOINT,
    key: 'fixture-vendor-key',
    model: 'qwen-audio-3.0-asr-flash',
    lang: 'zh',
  });
  assert.equal(readAsrConfig(cfg({
    DUST_ASR_KEY: 'fixture-specific-key',
    DUST_DASHSCOPE_KEY: 'fixture-old-key',
  })).key, 'fixture-specific-key');
});

test('网关使用独立端点、项目凭证和模型别名，不回退百炼凭证', () => {
  assert.deepEqual(readAsrConfig(cfg({
    DUST_ASR_BASE: gateway,
    DUST_ASR_KEY: 'fixture-project-token',
    DUST_DASHSCOPE_KEY: 'fixture-vendor-key',
    DUST_ASR_MODEL: 'qwen-asr',
    DUST_ASR_LANG: 'en',
  })), { ...options, lang: 'en' });
  for (const endpoint of [gateway, 'https://asr.example.invalid/transcribe']) {
    const result = readAsrConfig(cfg({ DUST_ASR_BASE: endpoint, DUST_DASHSCOPE_KEY: 'fixture-vendor-key' }));
    assert.equal(result.key, '', '非百炼端点不得继承旧厂商凭证');
  }
});

test('转写端点拒绝远程明文地址和 URL 中的凭据', () => {
  for (const endpoint of [
    'http://asr.example.invalid/transcribe',
    'https://user:secret@asr.example.invalid/transcribe',
    'https://asr.example.invalid/transcribe?token=secret',
  ]) assert.throws(() => readAsrConfig(cfg({ DUST_ASR_BASE: endpoint })));
});

test('没有项目凭证时在发送音频前明确失败', async t => {
  const { file } = audioFixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('不得发起请求'); });
  await assert.rejects(asrOnce(file, { ...options, key: '' }), PermanentError);
  assert.equal(calls, 0);
});

test('网关发送原生 JSON、项目凭证、音频及热词，保留逐词时间戳', async t => {
  const { file, bytes } = audioFixture(t);
  const controller = new AbortController();
  const words = [{ text: '你好', begin_time: 0, end_time: 340 }, { text: '世界', begin_time: 350, end_time: 690 }];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    calls.push({ url, request });
    return Response.json({ output: { text: '  你好世界。  ', sentence: [{ words: words.slice(0, 1) }, { words: words.slice(1) }] }, usage: { duration: 1.5 } });
  });
  const result = await asrOnce(file, { ...options, context: 'Dustoff、TypeScript', signal: controller.signal });
  assert.deepEqual(result, { text: '你好世界。', seconds: 1.5, words });
  assert.equal(calls.length, 1);
  const { url, request } = calls[0];
  assert.equal(url, gateway);
  assert.equal(request.method, 'POST');
  assert.equal(request.signal, controller.signal);
  const headers = new Headers(request.headers);
  assert.equal(headers.get('authorization'), 'Bearer fixture-project-token');
  assert.equal(headers.get('content-type'), 'application/json');
  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: 'qwen-asr',
    input: { messages: [
      { role: 'system', content: [{ text: 'Dustoff、TypeScript' }] },
      { role: 'user', content: [{ audio: `data:audio/mp3;base64,${bytes.toString('base64')}` }] },
    ] },
    parameters: { format: 'mp3', asr_options: { language: 'zh', enable_itn: true } },
  });
});

test('模型别名不影响新旧转写响应解析，兼容单个 sentence 和旧 seconds', async t => {
  const { file } = audioFixture(t);
  const word = { text: '单句', begin_time: 0, end_time: 230 };
  const responses = [
    { output: { text: '单句', sentence: { words: [word] } }, usage: { duration: 0.3 } },
    { output: { choices: [{ message: { content: [{ text: '  旧模型转写  ' }] } }] }, usage: { seconds: 4.75 } },
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
  assert.deepEqual(await asrOnce(file, options), { text: '单句', seconds: 0.3, words: [word] });
  assert.deepEqual(await asrOnce(file, options), { text: '旧模型转写', seconds: 4.75, words: [] });
});

test('空转写及百炼无人声错误都是有效空结果', async t => {
  const { file } = audioFixture(t);
  const responses = [
    Response.json({ output: { text: '' }, usage: { duration: 2.5 } }),
    Response.json({ output: { choices: [{ message: { content: [{ text: '' }] } }] }, usage: { seconds: 3 } }),
    Response.json({ code: 'ASR_RESPONSE_HAVE_NO_WORDS', message: 'no words', usage: { duration: 0 } }, { status: 400 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  assert.deepEqual(await asrOnce(file, options), { text: '', seconds: 2.5, words: [] });
  assert.deepEqual(await asrOnce(file, options), { text: '', seconds: 3, words: [] });
  assert.deepEqual(await asrOnce(file, options), { text: '', seconds: 0, words: [] });
});

test('网关认证和授权错误不重试，保留网关错误说明', async t => {
  const { file } = audioFixture(t);
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: '项目未获授权', type: 'gateway_error' } }, { status }));
  for (status of [401, 403]) {
    await assert.rejects(asrOnce(file, options), error => {
      assert.ok(error instanceof PermanentError);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /项目未获授权/);
      return true;
    });
  }
});

test('上游回显凭证时错误说明不会泄露项目 Token', async t => {
  const { file } = audioFixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: { message: `拒绝 ${options.key}，再次检查 ${options.key}` },
  }, { status: 401 }));
  await assert.rejects(asrOnce(file, options), error => {
    assert.ok(error instanceof PermanentError);
    assert.ok(!error.message.includes(options.key));
    assert.match(error.message, /拒绝/);
    return true;
  });
});

test('限流及服务端故障保留为可重试错误', async t => {
  const { file } = audioFixture(t);
  let status = 429;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: '暂时不可用', type: 'gateway_error' } }, { status }));
  for (status of [429, 500, 502, 503, 504]) {
    await assert.rejects(asrOnce(file, options), error => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof PermanentError));
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  }
});

test('不完整或无效成功响应不能冒充空转写', async t => {
  const { file } = audioFixture(t);
  const responses = [
    Response.json({}),
    Response.json({ output: {} }),
    Response.json({ output: { text: 123 } }),
    Response.json({ output: { choices: [] } }),
    new Response('not json', { status: 200 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (let i = 0; i < 5; i++) await assert.rejects(asrOnce(file, options), /ASR.*转写|ASR.*响应/);
});
