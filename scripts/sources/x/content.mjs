// X 单条内容：推文图片（随原帖保存）与视频（保存用途取最高码率，笔记用途取最低码率转写）。
// 媒体地址只接受 X 自己的媒体域名。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA, SAVED_MEDIA, PauseError, atomicWrite, deadlineMs, localPath, requestSignal, storage, under, writeMedia } from '../../policy.mjs';
import { inspect } from '../../gallery.mjs';
import { platformInfo } from '../../platforms.mjs';

const MEDIA_HOST = /^(pbs|video)\.twimg\.com$/;
export function mediaUrl(value) {
  let u;
  try { u = new URL(value); } catch { return null; }
  return u.protocol === 'https:' && MEDIA_HOST.test(u.hostname) && !u.username && !u.password ? u : null;
}
/** 图片取原图尺寸。 */
export function photoUrl(value) {
  const u = mediaUrl(value);
  if (!u || u.hostname !== 'pbs.twimg.com') return null;
  u.searchParams.set('name', 'orig');
  return u.href;
}

async function fetchTo(url, path, { retain }) {
  storage(0, { retain });
  let res;
  try { res = await fetch(url, { redirect: 'error', signal: requestSignal(), headers: { 'User-Agent': 'Mozilla/5.0' } }); }
  catch (e) { if (e instanceof PauseError) throw e; throw new Error('X 媒体下载失败或超时（检查代理）'); }
  if (!res.ok) { await res.body?.cancel(); throw new Error(`X 媒体下载 HTTP ${res.status}`); }
  try { const size = Number(res.headers.get('content-length')); if (size > 0) storage(size, { retain }); }
  catch (e) { await res.body?.cancel(); throw e; }
  await writeMedia(res.body, path);
}

/**
 * 原帖图片随原帖保存到视频收藏目录，已完成且校验通过的不重下。
 * 返回 [{index, file, path, url, width, height, bytes}]。
 */
export async function savePhotos(item) {
  const photos = (item.media || []).filter(m => m.type === 'photo' && photoUrl(m.url));
  if (!photos.length) return [];
  const dir = localPath(join(SAVED_MEDIA, item.aweme_id, 'images')), receipt = join(dir, 'photos.json');
  if (!under(dir, SAVED_MEDIA)) throw new Error('图片位置不在收藏目录');
  let done = [];
  try { done = JSON.parse(readFileSync(receipt, 'utf8')); } catch {}
  const out = [];
  for (const [index, photo] of photos.entries()) {
    deadlineMs();
    const url = photoUrl(photo.url), old = done.find(d => d.index === index && d.url === url);
    if (old && /^\d{3}\.(jpg|png|webp|gif|avif)$/.test(old.file)) {
      try { const checked = inspect(join(dir, old.file)); if (checked.bytes === old.bytes) { out.push({ ...old, path: join(dir, old.file) }); continue; } } catch {}
    }
    mkdirSync(dir, { recursive: true });
    const part = join(dir, `${String(index + 1).padStart(3, '0')}.part`);
    try {
      await fetchTo(url, part, { retain: true });
      const checked = inspect(part), file = `${String(index + 1).padStart(3, '0')}.${checked.ext}`;
      renameSync(part, join(dir, file));
      out.push({ index, file, path: join(dir, file), url, width: checked.width, height: checked.height, bytes: checked.bytes });
    } catch (e) { rmSync(part, { force: true }); throw e instanceof PauseError ? e : new Error(`第 ${index + 1}/${photos.length} 张图片未保存：${e.message}`); }
  }
  atomicWrite(receipt, JSON.stringify(out.map(({ path, ...p }) => p)));
  return out;
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: deadlineMs(15000) });
  if (r.status !== 0) throw new Error('媒体校验失败');
  const data = JSON.parse(r.stdout), types = new Set((data.streams || []).map(s => s.codec_type));
  const duration = Number(data.format?.duration);
  if (!types.has('video') || !Number.isFinite(duration) || duration <= 0) throw new Error('视频文件无法校验');
  return { audio: types.has('audio'), duration };
}

/**
 * 下载推文里的第一段视频。note：最低码率到媒体缓存，供转写；video：最高码率到视频收藏目录。
 * 返回值可直接交给 importDownload。
 */
export async function downloadVideo(item, { purpose }) {
  const clip = (item.media || []).find(m => m.type !== 'photo');
  const url = mediaUrl(purpose === 'note' ? clip?.low || clip?.url : clip?.url);
  if (!url) throw new Error('推文没有可下载的视频地址');
  const retain = purpose !== 'note', root = retain ? SAVED_MEDIA : MEDIA;
  const dir = localPath(join(root, item.aweme_id)), out = join(dir, 'video.mp4');
  if (!under(out, root)) throw new Error('视频位置不在预算目录');
  const result = (p, extra) => ({ aweme_id: item.aweme_id, status: 'done', path: p, bytes: statSync(p).size, ...extra });
  if (existsSync(out)) { try { const p = probe(out); return result(out, { has_audio: p.audio, gear: 'cached', quality: retain ? 'high' : 'low' }); } catch { rmSync(out, { force: true }); } }
  mkdirSync(dir, { recursive: true });
  const part = join(dir, 'video.part');
  let checked;
  try { await fetchTo(url.href, part, { retain }); checked = probe(part); renameSync(part, out); }
  finally { rmSync(part, { force: true }); }
  if (retain) atomicWrite(join(dir, 'source.json'), JSON.stringify({ id: item.aweme_id, title: item.desc, author: item.author, username: item.username, source: platformInfo('x').url(item.aweme_id), text: item.text || item.desc, purpose: 'video', quality: 'high', width: clip.width, height: clip.height }, null, 2));
  return result(out, { has_audio: checked.audio, gear: retain ? 'mp4-best' : 'mp4-low', quality: retain ? 'high' : 'low' });
}
