// 运行期间的用户决定：控制台先记成“待生效操作”，持锁的一方（运行收尾、下一轮开始或空闲的控制台）再执行。
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DUST_HOME } from './config.mjs';
import { localPath } from './policy.mjs';
import { setPurpose, discardItem, setVideoQuality } from './daily.mjs';
import { listIntents } from './intent-store.mjs';
export { INTENT_ACTIONS, listIntents, addIntent, intentsById } from './intent-store.mjs';

/** 调用方必须持有流水线锁。按记录顺序执行，失败的写日志后丢弃，不阻塞其他操作。 */
export function applyIntents(home = DUST_HOME, { log = () => {} } = {}) {
  const result = { applied: 0, failed: [] };
  for (const intent of listIntents(home)) {
    try {
      if (intent.action === 'purpose') setPurpose(intent.id, intent.value);
      else if (intent.action === 'discard') discardItem(intent.id);
      else setVideoQuality(intent.id, intent.value);
      result.applied++; log(`已执行运行期间记下的操作：${intent.id} ${intent.action}${intent.value !== null ? ` ${intent.value}` : ''}`);
    } catch (e) { result.failed.push({ id: intent.id, error: e.message }); log(`运行期间记下的操作未执行 ${intent.id}：${e.message}`); }
    rmSync(localPath(join(home, 'console', 'intents', intent.file)), { force: true });
  }
  return result;
}
