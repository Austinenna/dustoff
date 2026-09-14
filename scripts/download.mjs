#!/usr/bin/env node
// 下载使用流式写入：每块落盘前检查容量，临时文件验证通过后才成为 video.mp4。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MEDIA, POLICY, mediaDecision, storage, writeMedia, requestSignal, deadlineMs, PauseError, localPath } from './policy.mjs';
import { isExpired } from './lib.mjs';
const UA = 'Mozilla/5.0';
function validate(file) {
  if (!existsSync(file) || statSync(file).size <= 10000) throw new Error('视频文件过小');
  const mime = spawnSync('file', ['-b', '--mime-type', file], { encoding: 'utf8', timeout: deadlineMs(15000) });
  if (mime.status !== 0 || !mime.stdout.trim().startsWith('video/')) throw new Error('文件不是视频');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: deadlineMs(15000) });
  if (probe.status !== 0) throw new Error('视频校验失败');
  const data = JSON.parse(probe.stdout);
  if (!data.streams?.some(s => s.codec_type === 'audio')) throw new Error('视频没有音轨');
  const dur = Number(data.format?.duration);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('无法验证视频时长');
  if (dur > POLICY.seconds) { const e = new Error('视频实际时长超过上限'); e.tooLong = true; throw e; }
}
export async function downloadOne(item) {
  if (!/^\d+$/.test(String(item.aweme_id))) throw new Error('作品 ID 不合法');
  const decision = mediaDecision(item);
  if (decision === 'unknown_duration') throw new Error('缺少可靠时长，等待元数据刷新');
  if (decision) return { aweme_id: item.aweme_id, status: `skipped_${decision}` };
  const dir = localPath(join(MEDIA, item.aweme_id)), mp4 = join(dir, 'video.mp4');
  const part = join(dir, 'video.mp4.part');
  const result = status => ({ aweme_id: item.aweme_id, status, path: mp4, bytes: statSync(mp4).size, has_audio: true, gear: item.gear });
  if (existsSync(mp4)) {
    try { validate(mp4); return result('cached'); }
    catch (e) { rmSync(mp4, { force: true }); if (e.tooLong) return { aweme_id: item.aweme_id, status: 'skipped_too_long' }; }
  }
  const urls = [...new Set([...(item.play_urls || []), ...(item.play_urls_fallback || [])])];
  if (!urls.length || isExpired(urls)) throw new Error('下载地址缺失或过期，需要刷新');
  let last;
  for (const url of urls) {
    try {
      storage();
      if (!/^https?:\/\//.test(url)) throw new Error('下载地址协议不支持');
      const response = await fetch(url, { signal: requestSignal(), headers: { Referer: 'https://www.douyin.com/', 'User-Agent': UA } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`下载 HTTP ${response.status}`); }
      try {
        const size = Number(response.headers.get('content-length'));
        if (size > 0) storage(size);
      } catch (e) { await response.body?.cancel(); throw e; }
      await writeMedia(response.body, part);
      validate(part);
      renameSync(part, mp4);
      return result('done');
    } catch (e) {
      rmSync(part, { force: true });
      if (e instanceof PauseError) throw e;
      if (e.tooLong) return { aweme_id: item.aweme_id, status: 'skipped_too_long' };
      last = e;
    }
  }
  throw last || new Error('没有可用下载地址');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.error('独立批量下载入口已停用。请使用 node run.mjs --download-only，以保留基线、每日额度及空间保护。');
  process.exitCode = 6;
}
