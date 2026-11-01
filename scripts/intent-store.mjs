// 运行期间记下的用户决定（只负责读写文件，不改账本）。执行见 intents.mjs。
// 每条操作一个文件，写入与消费互不覆盖；同一作品同类操作只保留最新一条。
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DUST_HOME } from './config.mjs';
import { atomicWrite, localPath } from './policy.mjs';
import { validItemId } from './platforms.mjs';

export const INTENT_ACTIONS = ['purpose', 'discard', 'quality'];
const dirOf = home => localPath(join(home, 'console', 'intents'));

export function listIntents(home = DUST_HOME) {
  let names;
  try { names = readdirSync(dirOf(home)).filter(n => /^\d+-[0-9a-f]{8}\.json$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    try { out.push({ ...JSON.parse(readFileSync(join(dirOf(home), name), 'utf8')), file: name }); } catch { /* 正被消费或写入未完成 */ }
  }
  return out.filter(i => validItemId(i.id) && INTENT_ACTIONS.includes(i.action));
}
export function addIntent({ id, action, value = null }, home = DUST_HOME) {
  if (!validItemId(id) || !INTENT_ACTIONS.includes(action)) throw new Error('待生效操作无效');
  for (const old of listIntents(home)) if (old.id === id && (old.action === action || action === 'discard' || old.action === 'discard')) rmSync(join(dirOf(home), old.file), { force: true });
  mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  const at = Date.now();
  atomicWrite(join(dirOf(home), `${at}-${randomBytes(4).toString('hex')}.json`), JSON.stringify({ id, action, value, at }));
  return { deferred: true };
}
/** 作品 ID → 待生效操作列表，供控制台展示和运行时跳过。 */
export function intentsById(home = DUST_HOME) {
  const map = new Map();
  for (const i of listIntents(home)) map.set(i.id, [...(map.get(i.id) || []), { action: i.action, value: i.value, at: i.at }]);
  return map;
}
