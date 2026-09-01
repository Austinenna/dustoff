// dustoff / session_guard.mjs
// 登录态守卫：按「自然日」节流地检查 sessionid 到期时间，必要时告警。
//
// 为什么要节流：
//   定时任务一天可能触发很多次（分批扫描、重试、手动跑）。检查本身虽然便宜，
//   但没必要一天做 100 遍，告警更不能弹 100 次。所以按本地自然日记一个戳，
//   同一天内只真正评估一次，后续调用直接复用当天结果。
//
// 检查放在哪：
//   只有 get_collection.mjs 会开 Chrome，而且它本来就要查一次登录态，
//   顺手读 sessionid 的 expires 字段几乎零成本，不需要额外的 CDP 调用。
//   download.mjs 全程不开浏览器，因此不做也不该做这个检查。
//
// 三件事对应三个方案：
//   A 标记文件  ~/.dustoff/NEEDS_LOGIN     —— 不会丢，下次会话一眼可见
//   B 系统通知  osascript display notification —— 当场有声提醒
//   D 到期历史  state.history[]           —— 用来观察 sessionid 会不会自动续期，
//                                            若会自动续期，告警本身就可以撤掉

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.DUST_HOME || join(homedir(), '.dustoff');
const STATE_DIR = join(ROOT, 'state');
const STATE_FILE = join(STATE_DIR, 'session.json');
const FLAG_FILE = join(ROOT, 'NEEDS_LOGIN');

const WARN_DAYS = Number(process.env.DUST_WARN_DAYS || 7);   // 剩余不足几天开始预警
const NOTIFY = process.env.DUST_NOTIFY !== '0';              // 设 0 可关掉系统通知
const HISTORY_CAP = 120;

const localDate = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function load() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { history: [] }; }
}

function save(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** macOS 系统通知（方案 B）。非 macOS 或关掉通知时静默跳过。 */
function notify(title, message, subtitle = '') {
  if (!NOTIFY || process.platform !== 'darwin') return;
  const esc = s => String(s).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');
  const parts = [`display notification "${esc(message)}"`, `with title "${esc(title)}"`];
  if (subtitle) parts.push(`subtitle "${esc(subtitle)}"`);
  parts.push('sound name "Basso"');
  try { spawnSync('osascript', ['-e', parts.join(' ')], { timeout: 5000 }); } catch {}
}

/** 写/清 标记文件（方案 A）。 */
function writeFlag(lines) {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(FLAG_FILE, lines.join('\n') + '\n');
}
function clearFlag() { try { if (existsSync(FLAG_FILE)) rmSync(FLAG_FILE); } catch {} }

/**
 * 主入口。在 get_collection.mjs 拿到 cookie 之后调用一次。
 *
 * @param {object} opts
 * @param {boolean} opts.loggedIn        是否检测到 sessionid
 * @param {number|null} opts.expiresAt   sessionid 的到期 unix 秒（拿不到传 null）
 * @param {boolean} [opts.force]         忽略当日节流，强制评估
 * @returns {{checked:boolean, days_left:number|null, level:string, reason:string}}
 *          level: ok | warn | expired | unknown
 */
export function guardSession({ loggedIn, expiresAt, force = false } = {}) {
  const state = load();
  const today = localDate();
  const now = Math.floor(Date.now() / 1000);

  // 登录已经断了：这是硬故障，不受当日节流限制，标记文件每次都刷新（幂等且便宜），
  // 但系统通知一天只弹一次，避免定时任务反复触发时刷屏。
  if (!loggedIn) {
    const firstToday = state.last_alert_date !== today;
    writeFlag([
      '# dustoff 需要重新登录',
      `检测时间: ${new Date().toLocaleString()}`,
      '原因: 未检测到 sessionid，登录态已失效',
      '',
      '修复方式（在终端执行，用手机扫码）:',
      '  node ~/Documents/dustoff/scripts/login.mjs',
      '',
      '扫码成功后本文件可以删除。',
    ]);
    if (firstToday) {
      notify('dustoff 登录已失效', '收藏夹同步已停止，需要重新扫码登录', '运行 login.mjs');
      state.last_alert_date = today;
    }
    state.last_check_date = today;
    state.last_check_at = now;
    state.logged_in = false;
    save(state);
    return { checked: true, days_left: null, level: 'expired', reason: '未检测到 sessionid' };
  }

  // 已登录：同一自然日内只评估一次
  if (!force && state.last_check_date === today) {
    return {
      checked: false,
      days_left: state.days_left ?? null,
      level: state.level || 'ok',
      reason: `今日已检查过（${today}），复用结果`,
    };
  }

  let daysLeft = null, level = 'unknown', reason = '';
  if (expiresAt && expiresAt > 0) {
    daysLeft = (expiresAt - now) / 86400;
    if (daysLeft <= 0) { level = 'expired'; reason = 'sessionid 已过期'; }
    else if (daysLeft < WARN_DAYS) { level = 'warn'; reason = `sessionid 剩余 ${daysLeft.toFixed(1)} 天`; }
    else { level = 'ok'; reason = `sessionid 剩余 ${daysLeft.toFixed(1)} 天`; }
  } else {
    level = 'unknown'; reason = 'sessionid 是会话级 cookie，读不到到期时间';
  }

  // 方案 D：记一条到期时间历史。若后续观察到 expires 会自动往后推，
  // 说明日常访问本身就在续期，那这套告警可以直接撤掉。
  state.history = (state.history || []).filter(h => h.date !== today);
  state.history.push({ date: today, checked_at: now, expires_at: expiresAt ?? null, days_left: daysLeft });
  if (state.history.length > HISTORY_CAP) state.history = state.history.slice(-HISTORY_CAP);

  // 看看到期时间是不是在自动延长（至少两条记录才有意义）
  let renewing = null;
  const withExp = state.history.filter(h => h.expires_at);
  if (withExp.length >= 2) {
    const first = withExp[0].expires_at, last = withExp[withExp.length - 1].expires_at;
    renewing = last > first + 3600;    // 往后推了 1 小时以上就算在续期
  }
  state.auto_renewing = renewing;

  if (level === 'warn' || level === 'expired') {
    const firstToday = state.last_alert_date !== today;
    writeFlag([
      '# dustoff 登录态即将过期',
      `检测时间: ${new Date().toLocaleString()}`,
      `sessionid 到期: ${expiresAt ? new Date(expiresAt * 1000).toLocaleString() : '未知'}`,
      `剩余: ${daysLeft !== null ? daysLeft.toFixed(1) + ' 天' : '未知'}`,
      '',
      '建议在过期前重新扫码（在终端执行）:',
      '  node ~/Documents/dustoff/scripts/login.mjs',
      '',
      '扫码成功后本文件可以删除。',
    ]);
    if (firstToday) {
      notify('dustoff 登录即将过期',
        `sessionid 剩余 ${daysLeft !== null ? daysLeft.toFixed(1) : '?'} 天，建议尽快重新扫码`,
        '运行 login.mjs');
      state.last_alert_date = today;
    }
  } else if (level === 'ok') {
    clearFlag();     // 恢复正常就把标记清掉，避免留着过期的告警误导人
  }

  state.last_check_date = today;
  state.last_check_at = now;
  state.logged_in = true;
  state.expires_at = expiresAt ?? null;
  state.days_left = daysLeft;
  state.level = level;
  save(state);

  return { checked: true, days_left: daysLeft, level, reason, auto_renewing: renewing };
}

/** 供外部查看当前状态（比如我在会话开始时看一眼）。 */
export function sessionState() {
  const s = load();
  return { ...s, flag_present: existsSync(FLAG_FILE), flag_file: FLAG_FILE, state_file: STATE_FILE };
}

export const paths = { ROOT, STATE_DIR, STATE_FILE, FLAG_FILE };
