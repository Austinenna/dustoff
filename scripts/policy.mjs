// 当前运行策略：本地、小批量。旧配置只能收紧上限，不能绕过已确认的限制。
import { existsSync, lstatSync, readlinkSync, statfsSync, readdirSync, mkdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { makeCfg, DUST_HOME } from './config.mjs';
const cfg = makeCfg();
export const GiB = 1024 ** 3;
function positive(key, fallback) {
  const n = Number(cfg(key, fallback));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`配置 ${key} 必须为正数`);
  return n;
}
export const POLICY = Object.freeze({
  scan: Math.max(1, Math.min(100, Math.floor(positive('DUST_SCAN_COUNT', 100)))),
  daily: Math.max(1, Math.min(50, Math.floor(positive('DUST_DAILY_LIMIT', 50)))),
  seconds: Math.min(600, positive('DUST_MAX_DURATION_MIN', 10) * 60),
  bytes: Math.min(1, positive('DUST_MEDIA_MAX_GB', 1)) * GiB,
  free: Math.max(10, positive('DUST_MIN_FREE_GB', 10)) * GiB,
  requestMs: positive('DUST_REQUEST_TIMEOUT_S', 180) * 1000,
  runMs: positive('DUST_RUN_TIMEOUT_S', 7200) * 1000,
  external: false,
});
export class PauseError extends Error { constructor(message) { super(message); this.code = 5; } }
// 不触碰 /Volumes；同时拦住指向它的符号链接。其他符号链接逐级解析，避免路径绕过。
export function localPath(input, depth = 0) {
  const p = resolve(input);
  if (depth > 20 || p === '/Volumes' || p.startsWith('/Volumes/')) throw new PauseError('外接盘功能已停用，请使用本地路径');
  let part = sep;
  const bits = p.split(sep).filter(Boolean);
  for (let i = 0; i < bits.length; i++) {
    part = join(part, bits[i]);
    let st;
    try { st = lstatSync(part); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) return localPath(resolve(dirname(part), readlinkSync(part), ...bits.slice(i + 1)), depth + 1);
  }
  return p;
}
export const MEDIA = localPath(cfg('DUST_MEDIA', join(DUST_HOME, 'media')));
export const TEMP = localPath(join(DUST_HOME, 'tmp-media'));
export function under(path, root) { const p = resolve(path), r = resolve(root); return p.startsWith(r + sep); }
export function treeBytes(path) {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new PauseError('媒体目录中存在符号链接，暂停处理');
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}
export function storage(extra = 0) {
  let probe = localPath(MEDIA);
  while (!existsSync(probe)) probe = dirname(probe);
  const fs = statfsSync(probe);
  const available = Number(fs.bavail) * Number(fs.bsize);
  const used = treeBytes(MEDIA) + (under(TEMP, MEDIA) ? 0 : treeBytes(TEMP));
  if (used + extra > POLICY.bytes || (extra === 0 && used >= POLICY.bytes)) throw new PauseError('本地媒体达到 1 GiB 上限');
  if (available - extra < POLICY.free) throw new PauseError('本机剩余空间低于 10 GiB');
  return { used, available, remaining: Math.min(POLICY.bytes - used, available - POLICY.free) };
}
export function deadlineMs(cap = POLICY.requestMs) {
  const remaining = Number(process.env.DUST_DEADLINE_MS || (Date.now() + POLICY.runMs)) - Date.now();
  if (remaining <= 0) throw new PauseError('本轮达到执行时间上限');
  return Math.max(1, Math.min(cap, remaining));
}
export function requestSignal() { return AbortSignal.timeout(deadlineMs()); }
export function atomicWrite(path, text) {
  path = localPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    const bytes = Buffer.from(text); let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
}
// 每块在写入前核实真实总占用，远端未提供 Content-Length 也不能超预算落盘。
export async function writeMedia(stream, path) {
  path = localPath(path);
  if (!under(path, MEDIA) && !under(path, TEMP)) throw new PauseError('媒体写入位置不在预算目录中');
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w', 0o600);
  try {
    for await (const chunk of stream) {
      deadlineMs(); storage(chunk.length);
      let at = 0;
      while (at < chunk.length) at += writeSync(fd, chunk, at, chunk.length - at);
    }
    fsyncSync(fd);
  } catch (e) { rmSync(path, { force: true }); throw e; }
  finally { closeSync(fd); }
}
export function mediaDecision(item) {
  if (item.is_gallery || item.media_type === 'gallery') return 'gallery';
  const seconds = Number(item.duration_s);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown_duration';
  return seconds > POLICY.seconds ? 'too_long' : null;
}
