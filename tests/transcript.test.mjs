// 使用虚构固定样本与公开源码验证文本完整性；不读取生产资料、不调用模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTranscript, numberedTranscript, formatTranscript, verifyTranscript, transcriptMetadataPath, transcriptKey, readTranscriptMetadata, migrateTranscriptMetadata } from '../scripts/transcript.mjs';
import { atomicWrite } from '../scripts/policy.mjs';
import { writeNote } from '../notes.mjs';

const real = readFileSync(new URL('./fixtures/transcript.txt', import.meta.url));
const source = prepareTranscript(real);
const document = block => `# 笔记\n\n## 完整转写稿\n\n${block}\n\n---\n[完整转写稿](#完整转写稿)\n`;

test('固定原稿每一个可选分段位置，都能逐字节还原完整原文', () => {
  const numbered = JSON.parse(numberedTranscript(source));
  assert.equal(numbered.map(s => s.text).join(''), source.text);
  for (const { id } of source.segments) {
    const { block, info } = formatTranscript(source, { paragraph_starts: [id] });
    assert.equal(info.mode, 'model');
    assert.equal(verifyTranscript(document(block), real, info).sha256, source.sha256);
  }
  const all = formatTranscript(source, { paragraph_starts: source.segments.map(s => s.id) });
  assert.equal(verifyTranscript(document(all.block), real, all.info).paragraphs, source.segments.length);
  assert.ok(!all.block.includes('<p '));
  assert.ok(!all.block.includes('<!--'));
  assert.ok(!all.block.includes('sha256'));
});

test('现成 Markdown 和源码中的空白、转义、HTML、表情与代码符号保持原样', () => {
  for (const path of ['./fixtures/note.md', '../README.md', '../scripts/transcript.mjs']) {
    const bytes = readFileSync(new URL(path, import.meta.url));
    const raw = prepareTranscript(bytes);
    const result = formatTranscript(raw, { paragraph_starts: raw.segments.map(s => s.id) });
    verifyTranscript(document(result.block), bytes, result.info);
  }
});

test('对固定原稿进行无效分段指令故障注入，全部回退且不损失原稿', () => {
  const [a, b] = source.segments;
  const bad = [undefined, null, [], {}, { paragraph_starts: '全部' },
    { paragraph_starts: ['不存在的编号'] }, { paragraph_starts: [a.id, a.id] },
    { paragraph_starts: [b.id, a.id] }, { paragraph_starts: [1] },
    { paragraph_starts: [], text: '不允许模型提供原文' }];
  for (const plan of bad) {
    const result = formatTranscript(source, plan);
    assert.equal(result.info.mode, 'original');
    assert.ok(result.info.reason);
    assert.equal(verifyTranscript(document(result.block), real, result.info).paragraphs, 1);
  }
});

test('实际序列化内容少一个字、被重复或发生顺序变化都会被拒绝', () => {
  const { block, info } = formatTranscript(source, { paragraph_starts: [source.segments[5].id] });
  const first = source.text[0];
  verifyTranscript(document(block), real, info);
  assert.throws(() => verifyTranscript(document(block.replace(first, '')), real, info), /SHA-256/);
  assert.throws(() => verifyTranscript(document(block.replace(first, first + first)), real, info), /SHA-256/);
  const ps = block.split('\n\n');
  assert.equal(ps.length, 2);
  assert.throws(() => verifyTranscript(document([...ps].reverse().join('\n\n')), real, info), /SHA-256/);
  assert.throws(() => verifyTranscript(document(block) + '\n' + document(block), real, info), /重复/);
});

test('已落盘临时笔记校验失败时保留旧文件，并清除本次临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dustoff-transcript-'));
  try {
    const file = join(dir, 'note.md');
    const { block, info } = formatTranscript(source, { paragraph_starts: [] });
    const content = document(block);
    writeFileSync(file, content);
    const damaged = document(block.replace(source.text[0], ''));
    assert.throws(() => atomicWrite(file, damaged, { verify: saved => verifyTranscript(saved, real, info) }), /SHA-256/);
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.deepEqual(readdirSync(dir), ['note.md']);
    atomicWrite(file, content, { verify: saved => verifyTranscript(saved, real, info) });
    verifyTranscript(readFileSync(file), real, info);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('实际笔记与独立校验文件保留新旧版本，失败时两者均不被破坏', () => {
  const model = JSON.parse(readFileSync(new URL('./fixtures/model.json', import.meta.url), 'utf8'));
  const originalPath = new URL('./fixtures/transcript.txt', import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'dustoff-note-metadata-'));
  const metadataDir = mkdtempSync(join(tmpdir(), 'dustoff-internal-metadata-'));
  try {
    const item = { id: '1234567890123456789', title: model.标题, text_path: fileURLToPath(originalPath), note_path: join(dir, 'note.md') };
    const render = starts => writeNote(item, { ...model, 转写排版: { paragraph_starts: starts } }, { dir, metadataDir });
    const a = render(model.转写排版.paragraph_starts);
    const oldDocument = readFileSync(a.file);
    const b = render(model.转写排版.paragraph_starts.slice(0, 3));
    const metadataPath = transcriptMetadataPath(b.file, { directory:metadataDir });
    assert.deepEqual(readdirSync(dir), ['note.md']);
    assert.ok(!metadataPath.startsWith(dir + '/'));
    let metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(Object.keys(metadata.layouts).length, 2);
    // 更新中或中断时，只要旧 Markdown 仍在，它的校验记录就仍然可用。
    verifyTranscript(oldDocument, real, metadata.layouts[transcriptKey(oldDocument)]);
    const newDocument = readFileSync(b.file);
    verifyTranscript(newDocument, real, metadata.layouts[transcriptKey(newDocument)]);
    render(model.转写排版.paragraph_starts.slice(0, 1));
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(Object.keys(metadata.layouts).length, 2);
    const beforeNote = readFileSync(b.file), beforeMetadata = readFileSync(metadataPath);
    assert.throws(() => writeNote(item, { ...model, 正文: model.正文 + '\n## 完整转写稿\n\n重复区域' }, { dir, metadataDir }), /重复/);
    assert.ok(readFileSync(b.file).equals(beforeNote));
    assert.ok(readFileSync(metadataPath).equals(beforeMetadata));
    assert.ok(readFileSync(originalPath).equals(real));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(metadataDir, { recursive:true, force:true }); }
});

test('固定旧校验文件迁移、重复迁移和笔记改名均保持校验能力，损坏目标不删除旧副本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dustoff-migrate-metadata-'));
  try {
    const note = join(dir,'旧笔记.md'), original = join(dir,'original.txt'), directory = join(dir,'internal');
    const fixture = new URL('./fixtures/note.md', import.meta.url);
    const bytes = readFileSync(fixture);
    const metadata = readFileSync(new URL(fixture.href + '.transcript.json'));
    writeFileSync(note,bytes); writeFileSync(original,real); writeFileSync(`${note}.transcript.json`,metadata);
    assert.ok(readTranscriptMetadata(note,{ directory }));
    const moved = migrateTranscriptMetadata(note,original,{ directory });
    assert.equal(moved.migrated,true);
    assert.equal(existsSync(`${note}.transcript.json`),false);
    assert.ok(readFileSync(note).equals(bytes));
    assert.ok(readFileSync(original).equals(real));
    assert.equal(migrateTranscriptMetadata(note,original,{ directory }).migrated,false);
    const renamed = join(dir,'改名后的笔记.md');
    renameSync(note,renamed);
    const found = readTranscriptMetadata(renamed,{ directory });
    verifyTranscript(readFileSync(renamed),real,found.layouts[transcriptKey(bytes)]);
    assert.notEqual(transcriptMetadataPath(note,{ directory }),transcriptMetadataPath(renamed,{ directory }));
    writeFileSync(`${renamed}.transcript.json`,metadata);
    const target = transcriptMetadataPath(renamed,{ directory });
    writeFileSync(target,JSON.stringify({ version:2,layouts:{} }));
    assert.throws(() => migrateTranscriptMetadata(renamed,original,{ directory }), /缺少有效/);
    assert.ok(readFileSync(`${renamed}.transcript.json`).equals(metadata));
    rmSync(target);
    // 真实文件系统写入失败：目标路径已被目录占用，必须保留旧校验文件。
    mkdirSync(target);
    assert.throws(() => migrateTranscriptMetadata(renamed,original,{ directory }));
    assert.ok(readFileSync(`${renamed}.transcript.json`).equals(metadata));
  } finally { rmSync(dir,{ recursive:true,force:true }); }
});
