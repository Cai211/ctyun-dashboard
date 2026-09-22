#!/usr/bin/env node
'use strict';

/**
 * 静态语法检查：对参与运行的核心 JS 文件执行 `node --check`。
 * 为什么独立成脚本：不依赖 shell 的 && 连接与平台差异，Windows/Linux 行为一致，
 * 可直接被 CI 与本地 `npm run check` 复用。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'server.js',
  'app/tasks/native_tasks.js',
  'app/tasks/scheduler.js',
  'app/ydpc/ydpc_client.js',
  'app/static/app.js',
];

let failed = 0;

for (const f of FILES) {
  const abs = path.join(ROOT, f);
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`  ok    ${f}`);
  } else {
    failed++;
    console.error(`  FAIL  ${f}`);
    console.error((r.stderr || r.stdout || '').trim());
  }
}

if (failed > 0) {
  console.error(`\n语法检查未通过：${failed} 个文件存在语法错误。`);
  process.exit(1);
}

console.log(`\n语法检查通过：${FILES.length} 个文件全部正常。`);
