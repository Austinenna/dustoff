// 原稿与排版分离：模型只选片段边界；所有正文均从固定原稿按顺序复制。
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DUST_HOME } from './config.mjs';
import { atomicWrite, localPath } from './policy.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const HEADING = '\n## 完整转写稿\n\n';
const FOOTER = '\n\n---\n[完整转写稿](#完整转写稿)';
const punctuation = c => /[!-/:-@[-`{-~]/.test(c);
// CommonMark 的反斜线转义只处理 ASCII 标点；文字、空格、原有换行均不清洗。
// 因而原文中的 HTML、Markdown 语法和实体也会按文字显示，不依赖 HTML 渲染。
const escape = text => text.replace(/[!-~]/g, c => punctuation(c) ? `\\${c}` : c);
const unescape = text => text.replace(/\\([!-~])/g, (all, c) => punctuation(c) ? c : all);
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export const TRANSCRIPT_METADATA_DIR = join(DUST_HOME, 'transcript-meta');
// 每篇笔记独立保存，正式笔记与 --out 试写互不覆盖；技术文件不进入阅读目录。
export const transcriptMetadataPath = (note, { directory = TRANSCRIPT_METADATA_DIR } = {}) =>
  join(directory, `${digest(Buffer.from(localPath(note)))}.json`);

export function readTranscriptMetadata(note, { directory = TRANSCRIPT_METADATA_DIR } = {}) {
  const path = transcriptMetadataPath(note, { directory });
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  // 兼容尚未迁移的旧笔记，以及项目中保留的历史验证样本；不再生成旁置文件。
  const legacy = `${note}.transcript.json`;
  if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, 'utf8'));
  // 手动移动或改名后，用转写正文指纹找到原记录，无需用户搬运技术文件。
  if (!existsSync(note) || !existsSync(directory)) return null;
  let key;
  try { key = transcriptKey(readFileSync(note)); } catch { return null; }
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let metadata;
    try { metadata = JSON.parse(readFileSync(join(directory, name), 'utf8')); } catch { continue; }
    if (metadata.layouts?.[key]) return metadata;
  }
  return null;
}

function transcriptBlock(document) {
  const text = Buffer.isBuffer(document) ? decode(document) : String(document);
  const start = text.lastIndexOf(HEADING), end = text.lastIndexOf(FOOTER);
  if (text.indexOf(HEADING) !== start || text.indexOf(FOOTER) !== end) throw new Error('完整转写稿区域重复');
  if (start < 0 || end < start + HEADING.length) throw new Error('完整转写稿标题或页脚缺失');
  return text.slice(start + HEADING.length, end);
}

export const transcriptKey = document => digest(Buffer.from(transcriptBlock(document)));

export function prepareTranscript(bytes) {
  bytes = Buffer.from(bytes);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('转写稿 UTF-8 无法无损还原');
  const segments = [];
  let start = 0;
  const push = end => {
    if (end <= start) return;
    segments.push(Object.freeze({ id: `s${String(segments.length + 1).padStart(3, '0')}`, start, end, text: text.slice(start, end) }));
    start = end;
  };
  // 只在已有句末标点或换行之后提供边界；所有分隔符、空白都属于原片段。
  for (const match of text.matchAll(/[。！？!?；;]+[”’」』）】"']*[ \t]*|\.(?=\s|$)[ \t]*|(?:\r\n|\r|\n)+/gu)) {
    push(match.index + match[0].length);
  }
  push(text.length);
  if (segments.map(s => s.text).join('') !== text) throw new Error('转写稿分片未完整覆盖原文');
  return Object.freeze({ text, bytes: bytes.length, sha256: digest(bytes), segments: Object.freeze(segments) });
}

export function numberedTranscript(source) {
  return JSON.stringify(source.segments.map(({ id, text }) => ({ id, text })));
}

function paragraphOffsets(source, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      Object.keys(plan).length !== 1 || !Object.hasOwn(plan, 'paragraph_starts') || !Array.isArray(plan.paragraph_starts)) {
    throw new Error('转写排版必须仅包含 paragraph_starts 数组');
  }
  const indices = new Map(source.segments.map((s, i) => [s.id, i]));
  const offsets = [0];
  let previous = -1;
  for (const id of plan.paragraph_starts) {
    if (typeof id !== 'string' || !indices.has(id)) throw new Error('分段编号不在原稿中');
    const index = indices.get(id);
    if (index <= previous) throw new Error('分段编号重复或未按原文顺序排列');
    previous = index;
    // 第一段始终存在；允许模型显式列出第一个编号，但不能重复它。
    if (index > 0) offsets.push(source.segments[index].start);
  }
  return offsets;
}

export function formatTranscript(source, plan) {
  let offsets, mode = 'model', reason = null;
  try { offsets = paragraphOffsets(source, plan); }
  catch (error) { offsets = [0]; mode = 'original'; reason = error.message; }
  const paragraphs = offsets.map((start, i) => source.text.slice(start, offsets[i + 1] ?? source.text.length));
  const escaped = paragraphs.map(escape);
  const block = escaped.join('\n\n');
  const info = { version: 2, sha256: source.sha256, bytes: source.bytes, mode, reason,
    paragraphs: paragraphs.length, paragraph_bytes: escaped.map(text => Buffer.byteLength(text)), block_sha256: digest(Buffer.from(block)) };
  if (!restoreBlock(block, info).bytes.equals(Buffer.from(source.text))) throw new Error('排版转写稿不能无损恢复');
  return { block, info };
}

function restoreBlock(block, info) {
  if (!info || info.version !== 2 || !Array.isArray(info.paragraph_bytes) ||
      info.paragraph_bytes.length !== info.paragraphs || !info.paragraphs) throw new Error('缺少有效的独立转写校验记录');
  const serialized = Buffer.from(block);
  if (digest(serialized) !== info.block_sha256) throw new Error('转写段落已改变，SHA-256 不一致');
  const paragraphs = []; let offset = 0;
  for (const [i, length] of info.paragraph_bytes.entries()) {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > serialized.length) throw new Error('转写段落字节数无效');
    const escaped = decode(serialized.subarray(offset, offset + length)), raw = unescape(escaped);
    if (escape(raw) !== escaped) throw new Error('转写稿转义不是可逆的规范格式');
    paragraphs.push(raw);
    offset += length;
    if (i + 1 < info.paragraphs) {
      if (serialized.subarray(offset, offset + 2).toString() !== '\n\n') throw new Error('新增的段落分隔符不匹配');
      offset += 2;
    }
  }
  if (offset !== serialized.length) throw new Error('转写稿包含未覆盖的内容');
  const bytes = Buffer.from(paragraphs.join(''), 'utf8');
  if (paragraphs.length !== info.paragraphs || bytes.length !== info.bytes || digest(bytes) !== info.sha256) {
    throw new Error('转写稿段落数量、字节数或 SHA-256 不一致');
  }
  return { bytes, info };
}

/** 独立记录只描述长度和分隔符；恢复时不任意删除原有空白。 */
export function extractTranscript(document, info) {
  return restoreBlock(transcriptBlock(document), info);
}

export function verifyTranscript(document, original, info) {
  const result = extractTranscript(document, info);
  if (!result.bytes.equals(original)) throw new Error('文档内的转写稿与原始 TXT 不完全一致');
  return result.info;
}

/** 只移动程序的旧校验文件；校验新副本和源文件未变化之后才删除旧文件。 */
export function migrateTranscriptMetadata(note, original, { directory = TRANSCRIPT_METADATA_DIR } = {}) {
  note = localPath(note);
  original = localPath(original);
  const legacy = localPath(`${note}.transcript.json`);
  const target = localPath(transcriptMetadataPath(note, { directory }));
  const document = readFileSync(note), raw = readFileSync(original), key = transcriptKey(document);
  if (!existsSync(legacy)) {
    const metadata = JSON.parse(readFileSync(target, 'utf8'));
    verifyTranscript(document, raw, metadata.layouts?.[key]);
    return { migrated:false, verified:true, note, metadata:target };
  }
  const oldBytes = readFileSync(legacy);
  verifyTranscript(document, raw, JSON.parse(oldBytes).layouts?.[key]);
  const verify = bytes => verifyTranscript(document, raw, JSON.parse(bytes).layouts?.[key]);
  // 已有新记录时不覆盖它；能校验当前文档才允许清理旧副本。
  if (existsSync(target)) verify(readFileSync(target));
  else atomicWrite(target, oldBytes, { verify });
  verify(readFileSync(target));
  if (!readFileSync(note).equals(document) || !readFileSync(original).equals(raw) || !readFileSync(legacy).equals(oldBytes)) {
    throw new Error('迁移期间源文件发生变化，保留旧校验文件');
  }
  unlinkSync(legacy);
  return { migrated:true, verified:true, note, metadata:target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, note, original] = process.argv.slice(2);
    if (!['verify','migrate'].includes(command) || !note || !original) throw new Error('用法：node scripts/transcript.mjs verify|migrate 笔记.md 原稿.txt');
    if (command === 'migrate') {
      const { createStage } = await import('./stage.mjs');
      const stage = createStage({ name:'transcript-migrate', dustHome:DUST_HOME, record:false, notify:false });
      stage.acquireLock();
      try { console.log(JSON.stringify(migrateTranscriptMetadata(note, original), null, 2)); }
      finally { stage.releaseLock(); }
    } else {
      const document = readFileSync(note);
      const metadata = readTranscriptMetadata(note);
      console.log(JSON.stringify({ verified: true, ...verifyTranscript(document, readFileSync(original), metadata?.layouts?.[transcriptKey(document)]) }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
