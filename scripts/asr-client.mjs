// 同步 DashScope ASR；网关保留原生请求和响应，只替换地址、模型别名与凭据。
import { readFileSync } from 'node:fs';
import { makeCfg } from './config.mjs';

export const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export class PermanentError extends Error {}

export function readAsrConfig(cfg = makeCfg()) {
  const url = new URL(cfg('DUST_ASR_BASE', DASHSCOPE_ENDPOINT));
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('转写接口须为 HTTPS 或本机 HTTP 地址，不能含凭据或参数');
  }
  const endpoint = url.href.replace(/\/+$/, '');
  return {
    endpoint,
    // 旧百炼 Key 仅用于原官方地址，不能随接口切换发送到网关或其他服务。
    key: cfg('DUST_ASR_KEY', endpoint === DASHSCOPE_ENDPOINT ? cfg('DUST_DASHSCOPE_KEY', '') : ''),
    model: cfg('DUST_ASR_MODEL', 'qwen-audio-3.0-asr-flash'),
    lang: cfg('DUST_ASR_LANG', 'zh'),
  };
}

export async function asrOnce(file, { endpoint, key, model, lang, context = '', signal }) {
  if (!key) throw new PermanentError('未配置 DUST_ASR_KEY（百炼直连也可使用 DUST_DASHSCOPE_KEY）');
  const res = await fetch(endpoint, {
    signal,
    redirect: 'error',
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { messages: [
        { role: 'system', content: [{ text: context }] },
        { role: 'user', content: [{ audio: `data:audio/mp3;base64,${readFileSync(file).toString('base64')}` }] },
      ] },
      parameters: {
        ...(model.startsWith('qwen3-asr') ? {} : { format: 'mp3' }),
        asr_options: { language: lang, enable_itn: true },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && /HAVE_NO_WORDS/i.test(`${body?.code || ''} ${body?.message || ''}`)) {
    return { text: '', seconds: 0, words: [] };
  }
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${body?.code || ''} ${body?.error?.message || body?.message || ''}`.trim().split(key).join('[已隐藏密钥]');
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentError(msg);
    throw new Error(msg);
  }
  // 按响应结构识别，网关别名不必包含真实上游模型的前缀。
  const text = body?.output?.text ?? body?.output?.choices?.[0]?.message?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('ASR 响应缺少转写结果');
  const sentences = body.output.sentence;
  return {
    text: text.trim(),
    seconds: body.usage?.duration ?? body.usage?.seconds ?? 0,
    words: (Array.isArray(sentences) ? sentences : [sentences]).flatMap(s => s?.words || []),
  };
}
