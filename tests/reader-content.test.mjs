import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {splitNoteContent} from '../web/studio-view.mjs';
import {renderMarkdown} from '../web/markdown.mjs';

const appendix=(note,text)=>`${note}\n\n---\n## 完整转写稿\n\n${text}\n\n---\n[完整转写稿](#完整转写稿) · [原视频](https://example.com/video)\n`;

test('固定笔记按原分段拆出全文，笔记不再重复全文或留下失效页脚',()=>{
  const document=readFileSync(new URL('./fixtures/note.md',import.meta.url),'utf8');
  const {note,formatted}=splitNoteContent(document);
  const start=document.indexOf('\n\n---\n## 完整转写稿\n\n');
  assert.equal(note,document.slice(0,start));
  assert.equal(formatted,document.slice(start+'\n\n---\n## 完整转写稿\n\n'.length,document.lastIndexOf('\n\n---\n')));
  assert.equal(formatted.split('\n\n').length,7);
  assert.doesNotMatch(note,/完整转写稿/);
  assert.ok(note.includes('⚠️'));
  assert.equal(renderMarkdown(formatted),renderMarkdown(document).split('<h2 id="完整转写稿">完整转写稿</h2>\n')[1].split('\n<hr>')[0]);
});

test('普通标题和正文中的分隔线不会被当作转写边界，转义与空白原样保留',()=>{
  const note='# 笔记\n\n## 完整转写稿\n\n这里是在解释该名称。\n\n---\n\n结论。';
  const formatted='第一段\\*原文\\*  \n下一行\n\n第二段 \\<script\\>  \\[链接\\]。';
  assert.deepEqual(splitNoteContent(appendix(note,formatted)),{note,formatted});
  assert.deepEqual(splitNoteContent(appendix(note,formatted).replaceAll('\n','\r\n')),{note:note.replaceAll('\n','\r\n'),formatted:formatted.replaceAll('\n','\r\n')});
});

test('没有排版产物时保持笔记完整并返回缺失状态，不伪造格式化原稿',()=>{
  for(const note of ['', '# 旧笔记\n\n正文。', '# 笔记\n\n---\n## 完整转写稿\n\n手写内容，没有程序页脚。']){
    assert.deepEqual(splitNoteContent(note),{note,formatted:null});
  }
});
