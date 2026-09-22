import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../scripts/console-store.mjs';

test('转写设置保存网关连接，保留旧凭据并始终隐藏有效密钥', t => {
  const home = mkdtempSync(join(tmpdir(), 'dustoff-asr-settings-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'dustoff.conf');
  writeFileSync(file, '# 保留配置注释\nDUST_DASHSCOPE_KEY=fixture-vendor-secret\n');
  const store = createStore(home);
  const field = (settings, key) => settings.fields.find(f => f.key === key);
  const initial = store.settings();
  assert.equal(field(initial, 'DUST_ASR_KEY').configured, true);
  assert.equal(field(initial, 'DUST_ASR_KEY').value, '');
  const noKey = store.saveSettings({ revision: initial.revision, values: {
    DUST_ASR_BASE: 'http://127.0.0.1:8317/v1/asr/transcriptions', DUST_ASR_MODEL: 'qwen-asr',
  } });
  assert.equal(field(noKey, 'DUST_ASR_KEY').configured, false);
  const saved = store.saveSettings({ revision: noKey.revision, values: { DUST_ASR_KEY: 'fixture-gateway-secret' } });
  assert.equal(field(saved, 'DUST_ASR_KEY').configured, true);
  assert.equal(field(saved, 'DUST_ASR_KEY').value, '');
  assert.ok(!JSON.stringify(saved).includes('fixture-gateway-secret'));
  const retained = store.saveSettings({ revision: saved.revision, values: { DUST_ASR_KEY: '' } });
  assert.equal(field(retained, 'DUST_ASR_KEY').configured, true);
  assert.match(readFileSync(file, 'utf8'), /DUST_DASHSCOPE_KEY=fixture-vendor-secret/);
  assert.match(readFileSync(file, 'utf8'), /DUST_ASR_KEY=fixture-gateway-secret/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(store.redact('fixture-gateway-secret'), '[已隐藏密钥]');
  writeFileSync(file, 'DUST_ASR_BASE=invalid-url\nDUST_ASR_KEY=fixture-gateway-secret\n');
  assert.equal(field(store.settings(), 'DUST_ASR_BASE').value, 'invalid-url');
  assert.equal(field(store.settings(), 'DUST_ASR_KEY').value, '');
});
