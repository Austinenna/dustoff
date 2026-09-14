#!/usr/bin/env node
// 独立采集复用同一个基线、队列、额度和空间保护；全量 init / 旧批次 resume 暂停。
import { main } from './run.mjs';
main([...process.argv.slice(2), '--download-only']).catch(e => { console.error(e.message); process.exitCode=1; });
