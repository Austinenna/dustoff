// dustoff / config.mjs
// 配置解析。原先内联在 sync.mjs 里，第二段（提取）也要读同一份配置
// （API key 就在里面），所以抽出来共用，避免两处各写一个解析器而后跑偏。
//
// 优先级：命令行 > 环境变量 > ~/.dustoff/dustoff.conf > 脚本内置默认。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function expand(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|\/)/, homedir()).replace(/\$HOME/g, homedir());
}

export const DUST_HOME = expand(process.env.DUST_HOME || join(homedir(), '.dustoff'));
export const CONF_FILE = join(DUST_HOME, 'dustoff.conf');

/** 极简 KEY=VALUE 解析。值不加引号，# 起始为注释。 */
export function loadConf(file = CONF_FILE) {
  const conf = {};
  if (!existsSync(file)) return conf;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const hash = v.indexOf(' #');            // 行尾注释
    if (hash >= 0) v = v.slice(0, hash).trim();
    if (k) conf[k] = expand(v);
  }
  return conf;
}

/**
 * 造一个取值函数。initMode 为真时优先用 <KEY>_INIT，
 * 这样首次全量和日常增量两套值可以并存在同一个配置文件里。
 */
export function makeCfg({ initMode = false, conf = loadConf() } = {}) {
  return function cfg(key, fallback) {
    if (initMode) {
      const v = process.env[`${key}_INIT`] ?? conf[`${key}_INIT`];
      if (v !== undefined && v !== '') return expand(v);
    }
    const v = process.env[key] ?? conf[key];
    return v !== undefined && v !== '' ? expand(v) : fallback;
  };
}
