#!/usr/bin/env node
// 旧 Whisper 单条入口不具备统一账本和容量保护，当前阶段暂停。
console.error('旧单条 Whisper 入口已停用。请使用 node run.mjs --limit 1 验证真实新增，或 node extract.mjs / notes.mjs 续跑已入队条目。');
process.exitCode = 6;
