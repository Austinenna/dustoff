#!/usr/bin/env node
// dustoff / fetch.mjs
// 一条命令：抖音链接 -> 下载视频 -> 提取音频 -> whisper 转写文字稿。
// 复用 get_meta.mjs 取地址，再 shell out 到 curl / ffmpeg / whisper。
// 产出物落在 <cache>/<aweme_id>/，并把结果 JSON 打印到 stdout 供上层读取。
//
// 用法:
//   node fetch.mjs <抖音链接> [whisper模型=base]
// 环境变量:
//   DUST_MEDIA      缓存根目录（默认 ~/.dustoff/media）
//   DUST_MODEL      whisper 模型（默认 base；命令行第二参数优先）
//   DUST_KEEP_MP4=0 转写后删除 mp4（默认 1 保留）
//
// stdout 输出单行 JSON:
//   { ok, aweme_id, desc, author, create_time, duration_s, source_url,
//     dir, mp4, transcript_path, transcript }

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const input = process.argv[2];
const model = process.argv[3] || process.env.DUST_MODEL || 'base';
const mediaRoot = process.env.DUST_MEDIA || join(homedir(), '.dustoff', 'media');
const keepMp4 = process.env.DUST_KEEP_MP4 !== '0';

if (!input) { console.error('usage: node fetch.mjs <douyin url> [whisper-model]'); process.exit(2); }

const log = (...a) => console.error('>>', ...a);
const die = msg => { console.error('ERROR:', msg); process.exit(1); };

function which(bin) {
  const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
  return r.status === 0;
}
for (const bin of ['node', 'ffmpeg', 'whisper', 'curl']) {
  if (!which(bin)) die(`缺少依赖 '${bin}'`);
}

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? res({ out, err }) : rej(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)));
    p.on('error', rej);
  });
}

(async () => {
  // 1) 取元数据 + CDN 地址
  log('解析视频地址 ...');
  let meta;
  try {
    const { out } = await run('node', [join(__dirname, 'get_meta.mjs'), input]);
    meta = JSON.parse(out.trim().split('\n').pop());
  } catch (e) { die('取地址失败: ' + e.message); }
  if (!meta.ok) die('取地址返回异常');
  // 图集没有视频轨也没有音频轨，本脚本处理不了
  if (meta.is_gallery) die('这是图集（aweme_type=68），没有视频/音频轨，本脚本暂不支持');

  const dir = join(mediaRoot, meta.aweme_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const gearInfo = meta.gear
    ? `${meta.gear} ${meta.width}x${meta.height} 约${((meta.size_bytes||0)/1024/1024).toFixed(2)}MB（共${meta.gear_count}档，取最低）`
    : '无档位信息，回退 play_addr';
  log(`视频:《${meta.desc}》 / @${meta.author} / ${meta.duration_s}s -> ${dir}`);
  log(`下载档位: ${gearInfo}`);

  // 2) 下载（按备用地址逐个尝试）
  const mp4 = join(dir, 'video.mp4');
  if (!existsSync(mp4) || statSync(mp4).size < 10000) {
    log('下载视频 ...');
    let ok = false;
    for (const purl of meta.play_urls) {
      try {
        await run('curl', ['-sL', '--fail', '-H', `Referer: https://www.douyin.com/`,
          '-H', `User-Agent: ${UA}`, '-o', mp4, purl]);
        if (existsSync(mp4) && statSync(mp4).size > 10000) {
          const ft = spawnSync('file', ['-b', '--mime-type', mp4], { encoding: 'utf8' }).stdout.trim();
          if (ft.startsWith('video/')) { ok = true; break; }
        }
      } catch {}
    }
    if (!ok) {
      const exp = meta.url_expires_at;
      const hint = exp && exp * 1000 < Date.now()
        ? `地址已于 ${new Date(exp * 1000).toLocaleString()} 过期（CDN 签名有时效）`
        : '签名可能已过期或 CDN 不可用';
      die(`所有 CDN 地址下载失败：${hint}，请重跑本脚本重新取址`);
    }
  }
  const size = spawnSync('du', ['-h', mp4], { encoding: 'utf8' }).stdout.split('\t')[0];
  log(`已下载 video.mp4 (${size})`);

  // 3) 提取音频
  const wav = join(dir, 'audio.wav');
  if (!existsSync(wav) || statSync(wav).size < 1000) {
    log('提取音频 ...');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vn', '-ar', '16000', '-ac', '1', wav]);
  }

  // 4) Whisper 转写
  const txt = join(dir, 'transcript.txt');
  if (!existsSync(txt) || statSync(txt).size < 2) {
    log(`Whisper 转写 (模型: ${model}) ...`);
    await run('whisper', [wav, '--language', 'Chinese', '--model', model,
      '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False']);
    const auto = join(dir, 'audio.txt');
    if (existsSync(auto)) renameSync(auto, txt);
  }
  if (!existsSync(txt) || statSync(txt).size < 2) die('转写失败');
  const transcript = readFileSync(txt, 'utf8').trim();

  if (!keepMp4) { try { rmSync(mp4); } catch {} }

  log('完成。');
  console.log(JSON.stringify({
    ...meta, dir, mp4: keepMp4 ? mp4 : null,
    transcript_path: txt, transcript,
  }));
})().catch(e => die(e.message));
