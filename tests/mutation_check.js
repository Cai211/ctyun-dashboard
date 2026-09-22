#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 * 变异验证（Mutation Check）—— 证明"回归测试网真的能抓到回归"
 * ============================================================================
 * 一个永远不会变红的测试网等于没有测试网。
 *
 * 本脚本把历史上真实发生过的结构性缺陷逐条"重新种回去"（变异），
 * 然后在隔离的临时副本上运行 tests/regression.test.js：
 *   - 若测试网变红（退出码非 0）→ 说明该缺陷确实被守住了，判为 PASS；
 *   - 若测试网仍然全绿 → 说明测试网对该缺陷是瞎的，判为 FAIL（必须补断言）。
 *
 * 原仓库文件全程只读，所有变异只发生在临时副本目录内，结束后删除。
 * 用法：node tests/mutation_check.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const SRC_FILES = [
  'server.js',
  'app/tasks/scheduler.js',
  'app/tasks/native_tasks.js',
  'app/ydpc/ydpc_client.js',
];

/**
 * 每个变异：把 file 中的 from 替换为 to（replaceAll 可选），
 * 期望 regression.test.js 因此变红。
 */
const MUTATIONS = [
  {
    id: 'M1',
    name: '暗线A/字段漂移：把 sign 的映射改回错误的 features.sign',
    file: 'server.js',
    from: "sign: 'autoSign'",
    to: "sign: 'sign'",
    replaceAll: false,
  },
  {
    id: 'M2',
    name: '暗线A/原始直读：保活闸门退回 d.keepaliveEnabled === false',
    file: 'server.js',
    from: "if (!this.resolveTask('keepAlive', d).enabled) continue; // 统一入口：账号级/(该机)独立保活开关",
    to: "if (d.keepaliveEnabled === false) continue;",
    replaceAll: false,
  },
  {
    id: 'M3',
    name: '暗线A/调度器直读：打卡闸门退回 acc.features?.autoSign !== false',
    file: 'app/tasks/scheduler.js',
    from: "this.taskGate(acc, 'sign')",
    to: 'acc.features?.autoSign !== false',
    replaceAll: true,
  },
  {
    id: 'M4',
    name: '调度器死锁(#32)：把 isRunning 复位改名，脱离 finally 约束',
    file: 'app/tasks/scheduler.js',
    from: 'this.isRunning = false;',
    to: 'this.isRunningResetByMutation = false;',
    replaceAll: true,
  },
  {
    id: 'M5',
    name: 'AI对话卡死(#35)：移除主动超时 AbortSignal.timeout',
    file: 'app/tasks/native_tasks.js',
    from: 'AbortSignal.timeout(',
    to: 'noActiveTimeoutSignal(',
    replaceAll: true,
  },
  {
    id: 'M6',
    name: '暗线C/虚报成功：把打卡待确认态 pendingVerify 改名（模拟未确认即报完成）',
    file: 'app/tasks/native_tasks.js',
    from: 'pendingVerify',
    to: 'pendConfirmState',
    replaceAll: true,
  },
  {
    id: 'M7',
    name: '底层开机引擎复活：重新创建 app/ydpc/boot_engine.js',
    createFiles: [
      {
        path: 'app/ydpc/boot_engine.js',
        content:
          "// mutation: 重新种回被删除的底层开机引擎\n" +
          "function bootYdpcVmUnified() { return 'sc-boot'; }\n" +
          'module.exports = { bootYdpcVmUnified };\n',
      },
    ],
  },
  {
    id: 'M8',
    name: '底层开机引擎复活：把 boot_engine 引用重新注入 ydpc_client.js',
    file: 'app/ydpc/ydpc_client.js',
    from: "const { SohoClient } = require('./soho_client');",
    to:
      "const { SohoClient } = require('./soho_client');\n" +
      "const { bootYdpcVmUnified } = require('./boot_engine');",
    replaceAll: false,
  },
];

// ---------------------------------------------------------------------------

function copyFile(srcRel, baseDir) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(baseDir, srcRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

function freshSandbox() {
  const dir = path.join(ROOT, 'analysis', '_mutation_tmp');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of SRC_FILES) copyFile(f, dir);
  return dir;
}

function runRegression(sandboxDir) {
  const r = spawnSync(NODE, [path.join(ROOT, 'tests', 'regression.test.js')], {
    encoding: 'utf8',
    env: { ...process.env, CTYUN_TEST_ROOT: sandboxDir },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function firstFailingAssertion(output) {
  const m = output.match(/^\s*FAIL\s+(.+)$/m);
  return m ? m[1].trim() : '(未匹配到 FAIL 行)';
}

// ---------------------------------------------------------------------------

const results = [];
let broken = 0;

for (const mut of MUTATIONS) {
  const sandbox = freshSandbox();

  // 可选：向沙箱"新增"文件（用于验证"该文件必须不存在"类断言）
  if (Array.isArray(mut.createFiles)) {
    for (const cf of mut.createFiles) {
      const dst = path.join(sandbox, cf.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, cf.content, 'utf8');
    }
  }

  let changed = false;
  if (mut.file && mut.from && mut.to) {
    const target = path.join(sandbox, mut.file);
    const before = fs.readFileSync(target, 'utf8');
    const after = mut.replaceAll ? before.split(mut.from).join(mut.to) : before.replace(mut.from, mut.to);
    changed = after !== before;
    if (changed) fs.writeFileSync(target, after, 'utf8');
  } else if (Array.isArray(mut.createFiles) && mut.createFiles.length > 0) {
    changed = true;
  }

  if (!changed) {
    broken++;
    results.push(`  BROKEN ${mut.id}  ${mut.name}\n         变异未生效：未找到目标文本 ${JSON.stringify(mut.from)}`);
    continue;
  }

  const { code, out } = runRegression(sandbox);
  const caught = code !== 0;

  if (caught) {
    results.push(`  PASS   ${mut.id}  ${mut.name}\n         被捕获 → ${firstFailingAssertion(out)}`);
  } else {
    broken++;
    results.push(`  FAIL   ${mut.id}  ${mut.name}\n         测试网未捕获该回归（测试网存在盲区，需补断言）`);
  }
}

// 清理临时副本
fs.rmSync(path.join(ROOT, 'analysis', '_mutation_tmp'), { recursive: true, force: true });

// 自检：确认清理后原仓库仍全绿
const base = runRegression(ROOT);
const baseGreen = base.code === 0;

console.log('变异验证报告 (Mutation Check)');
console.log('='.repeat(64));
console.log(results.join('\n'));
console.log('='.repeat(64));
console.log(`变异共 ${MUTATIONS.length} 项：被测试网捕获 ${MUTATIONS.length - broken} 项，漏网 ${broken} 项`);
console.log(`原仓库基线回归测试：${baseGreen ? '全绿 (exit=0)' : '异常 (exit=' + base.code + ')'}`);

if (broken > 0 || !baseGreen) {
  console.error('\n变异验证未通过：测试网存在盲区或原仓库基线不绿。');
  process.exit(1);
}

console.log('\n变异验证通过：所有历史缺陷模式重种后均被测试网捕获。');
