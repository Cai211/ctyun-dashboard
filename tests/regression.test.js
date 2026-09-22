#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 * 结构性回归测试网 (Regression Net) —— ctyun-dashboard
 * ============================================================================
 * 目的：让"修好 A 却弄坏 B"在机械层面变成不可能。
 *
 * 背景：本项目历史上"签到 / 1 小时挂机 / AI 对话"三类问题反复复发，根因不是某一处
 * 写错，而是四类结构性缺陷被反复重新引入：
 *   暗线 A：开关语义分散读取（keepaliveEnabled / taskEnabled / autoSign / cloudHang 相互渗透）
 *   暗线 B：无客户端在场证据就盲目重连（45 秒顶人 → 被官方客户端踢下线）
 *   暗线 C：用固定时间窗"猜"异步结果（打卡认领窗口结束即当成功）
 *   暗线 D：丢弃错误证据（catch(e){} 静默吞掉 fetch failed / 数据读取失败）
 *
 * 本文件把这些结构性约束固化为可执行断言：任何人再次写出上述模式，`npm test` 立刻变红。
 *
 * 断言分两类：
 *   1) 静态结构断言 —— 直接读源码文本，断言"危险模式不存在 / 安全模式存在"；
 *   2) 行为断言 —— 从 server.js 抽取权威开关解析函数 resolveTaskEnabled 后真实调用，
 *      验证语义正确（尤其是 sign -> autoSign 的字段映射，见 #43）。
 *
 * 零依赖，直接 `node tests/regression.test.js`。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = process.env.CTYUN_TEST_ROOT
  ? path.resolve(process.env.CTYUN_TEST_ROOT)
  : path.resolve(__dirname, '..');
// 统一换行符为 LF：源码在 Windows 下是 CRLF，若不正则化，所有跨行正则（如 finally 块、
// 代码块抽取）都会因 \r 静默失配 —— 这是测试网自身最容易踩的坑。
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const server = read('server.js');
const scheduler = read('app/tasks/scheduler.js');
const native = read('app/tasks/native_tasks.js');

let passed = 0;
let failed = 0;
const lines = [];

function group(title) {
  lines.push(`\n${title}`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    lines.push(`  ok    ${name}`);
  } catch (e) {
    failed++;
    const msg = String(e && e.message ? e.message : e).split('\n').join('\n        ');
    lines.push(`  FAIL  ${name}`);
    lines.push(`        ${msg}`);
  }
}

/** 断言源码中不存在某模式（去掉注释后再匹配，避免注释里的反例说明误报）
 *  顺序很关键：必须先剥行注释，再剥块注释。
 *  因为源码里存在 `app/tasks/` 后跟星号的这种写法，它写在行注释中，却包含块注释的起始符号。
 *  若先剥块注释，就会从该起始符号一路吞到很远处的下一个块注释结束符，连带删掉真实代码。 */
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, '$1')  // 行注释（避开 http:// 之类）
    .replace(/\/\*[\s\S]*?\*\//g, '');   // 块注释
}

const serverCode = stripComments(server);
const schedulerCode = stripComments(scheduler);
const nativeCode = stripComments(native);

// ============================================================================
// 组 1 · 暗线 A：开关语义必须只有单一权威入口
// ============================================================================
group('组 1 · 开关语义单一入口（暗线 A）');

test('server.js 定义 TASK_FEATURE_KEY 且把 sign 映射到 autoSign（#43 字段漂移）', () => {
  assert.ok(/TASK_FEATURE_KEY/.test(serverCode), '未找到 TASK_FEATURE_KEY');
  assert.ok(
    /TASK_FEATURE_KEY\s*=\s*\{[^}]*sign:\s*'autoSign'[^}]*\}/.test(serverCode),
    "TASK_FEATURE_KEY 必须包含 sign: 'autoSign'，否则账号级打卡开关读取到 undefined 而失效"
  );
});

test('server.js 暴露 resolveTask 统一入口', () => {
  assert.ok(/resolveTask\s*\(\s*taskType/.test(serverCode), '缺少 CtYunClient.resolveTask');
  assert.ok(/function\s+resolveTaskEnabled\s*\(/.test(serverCode), '缺少 resolveTaskEnabled');
});

test('server.js 不得再出现挂机/保活执行闸门的原始字段直读', () => {
  const bad = [
    /if\s*\(\s*d\.keepaliveEnabled\s*===\s*false\s*\)\s*continue/,
    /if\s*\(\s*\w+\.taskEnabled\s*===\s*false\s*\)\s*continue/,
  ];
  for (const re of bad) {
    assert.ok(!re.test(serverCode), `检测到原始字段直读闸门：${re}`);
  }
});

test('scheduler.js 不得就地读取 acc.features 的任务开关', () => {
  const bad = [
    /acc\.features\?\.autoSign\s*!==\s*false/,
    /acc\.features\?\.aiChat\s*!==\s*false/,
    /acc\.features\?\.cloudHang\s*!==\s*false/,
    /acc\.features\?\.keepAlive\s*!==\s*false/,
    /\bf\.autoSign\s*!==\s*false/,
    /\bf\.aiChat\s*!==\s*false/,
    /\bf\.cloudHang\s*!==\s*false/,
  ];
  for (const re of bad) {
    assert.ok(!re.test(schedulerCode), `调度器仍在直读开关字段：${re}`);
  }
});

test('scheduler.js 提供 taskGate 统一入口，且兜底映射与 server.js 一致（sign -> autoSign）', () => {
  assert.ok(/taskGate\s*\(/.test(schedulerCode), '缺少 scheduler.taskGate');
  assert.ok(
    /taskType\s*===\s*'sign'\s*\?\s*'autoSign'\s*:\s*taskType/.test(schedulerCode),
    'scheduler.taskGate 兜底映射必须 sign -> autoSign'
  );
});

// ============================================================================
// 组 2 · 暗线 B：不得在无证据情况下重连 / 顶人
// ============================================================================
group('组 2 · 挂机不得盲重连（暗线 B）');

test('server.js 存在 "Unverified Channel Close" 证据缺失标记', () => {
  assert.ok(
    /Unverified Channel Close/.test(server),
    '缺少"通道关闭但无客户端在场证据"的显式标记，退化为 unknow 重连'
  );
});

test('server.js 的挂机中断判定必须返回 unverified 分支（不对称判定）', () => {
  assert.ok(/diagnoseHangInterruption/.test(serverCode), '缺少 diagnoseHangInterruption');
  assert.ok(/unverified/.test(serverCode), '缺少 unverified 判定结果');
});

test('server.js 存在重连预算上限字段（防止无限重连顶人）', () => {
  assert.ok(/hangReconnectCount/.test(serverCode), '缺少 hangReconnectCount 重连预算');
  assert.ok(/hangUnverifiedStreak/.test(serverCode), '缺少 hangUnverifiedStreak 退避计数');
});

// ============================================================================
// 组 3 · 暗线 C：打卡不得用固定窗口"猜"成功
// ============================================================================
group('组 3 · 打卡判定必须以官方确认（暗线 C）');

test('server.js 提供跨分钟复检机制 scheduleSignVerify / isSignTaskDone', () => {
  assert.ok(/scheduleSignVerify/.test(serverCode), '缺少 scheduleSignVerify');
  assert.ok(/isSignTaskDone/.test(serverCode), '缺少 isSignTaskDone');
});

test('native_tasks.js 打卡存在 pendingVerify 待确认态', () => {
  assert.ok(/pendingVerify/.test(nativeCode), '缺少 pendingVerify 待官方确认态');
});

test('native_tasks.js 所有"待确认"返回必须同时显式声明 isCompleted:false', () => {
  const returns = nativeCode.match(/return\s*\{[^}]*pendingVerify\s*:\s*true[^}]*\}/g) || [];
  assert.ok(returns.length > 0, '未找到任何"待官方确认 (pendingVerify: true)"的返回语句');
  for (const r of returns) {
    assert.ok(
      /isCompleted\s*:\s*false/.test(r),
      `"待确认"返回未显式声明 isCompleted:false，存在被解读为成功的风险：${r}`
    );
  }
});

test('native_tasks.js 不得出现"未确认却报成功"的返回（pendingVerify 与 isCompleted:true 并存）', () => {
  const returns = nativeCode.match(/return\s*\{[^}]*\}/g) || [];
  const bad = returns.filter(r => /pendingVerify\s*:\s*true/.test(r) && /isCompleted\s*:\s*true/.test(r));
  assert.strictEqual(
    bad.length, 0,
    `发现 ${bad.length} 处"待官方确认"与"已完成"同时上报的返回值（互斥语义被破坏）：\n${bad.join('\n')}`
  );
});

test('native_tasks.js 硬编码 isCompleted: true 的返回点须恰好 3 处（新增即需显式确认）', () => {
  const hits = nativeCode.match(/isCompleted\s*:\s*true/g) || [];
  assert.strictEqual(
    hits.length,
    3,
    `硬编码 isCompleted: true 出现 ${hits.length} 次，预期 3 次` +
      `（① 官方已完成前置校验 ② 官方已确认达成 ③ 移动云无需挂机）。` +
      `若确为新增的合法确认分支，请同步更新本断言，避免"虚报成功"被静默引入。`
  );
});

// ============================================================================
// 组 4 · 暗线 D：不得丢弃错误证据
// ============================================================================
group('组 4 · 错误证据不得被吞掉（暗线 D）');

test('server.js refreshOfficialTasks 返回可区分可信度的结果 { ok }', () => {
  assert.ok(
    /refreshOfficialTasks\s*\(/.test(serverCode),
    '缺少 refreshOfficialTasks'
  );
  assert.ok(
    /async\s+refreshOfficialTasks\s*\([^)]*\)\s*\{[\s\S]{0,6000}?ok:\s*false/.test(serverCode),
    'refreshOfficialTasks 未返回 { ok: false, reason }，调用方无法区分"未达成"与"没取到数据"'
  );
});

test('native_tasks.js 网络请求必须带主动超时（#35 串行队列卡死）', () => {
  assert.ok(/netFetch/.test(nativeCode), '缺少 netFetch 统一请求封装');
  assert.ok(
    /signal\s*=\s*AbortSignal\.timeout\s*\(/.test(nativeCode),
    'netFetch 未把 AbortSignal.timeout 赋给 signal（仅有 typeof 守卫不算真正的主动超时）'
  );
  assert.ok(
    /fetch\s*\([^)]*signal\s*\?\s*\{[^}]*signal\s*\}\s*:\s*options\s*\)/.test(nativeCode),
    'signal 没有被传入 fetch 请求，超时设置不会真正生效，AI 对话仍可能永久挂起'
  );
});

// ============================================================================
// 组 5 · 调度器不得静默死锁（#32）与虚报（#34）
// ============================================================================
group('组 5 · 调度器健壮性（#32 / #34）');

test('scheduler.js runAllAccounts 必须用 try/finally 复位 isRunning', () => {
  assert.ok(
    /async\s+runAllAccounts\s*\([\s\S]*?\}\s*finally\s*\{\s*this\.isRunning\s*=\s*false;\s*\}/.test(schedulerCode),
    'isRunning 未在 finally 中复位：任一步骤抛错将导致调度器永久死锁'
  );
});

test('scheduler.js 不得存在 "已达成/已达成" 死代码虚报', () => {
  assert.ok(
    !/['"]已达成['"]\s*:\s*['"]已达成['"]/.test(schedulerCode),
    "存在 `? '已达成' : '已达成'` 死代码：无论结果如何都上报已达成"
  );
});

// ============================================================================
// 组 6 · 行为断言：真实执行权威开关解析函数
// ============================================================================
group('组 6 · resolveTaskEnabled 行为验证（抽取源码真实执行）');

function loadResolveTaskEnabled() {
  const m = server.match(/const TASK_CN_NAME[\s\S]*?\n\}\n/);
  assert.ok(m, '无法从 server.js 抽取 resolveTaskEnabled 代码块');
  const code = m[0];
  assert.ok(/function\s+resolveTaskEnabled/.test(code), '抽取到的代码块不含 resolveTaskEnabled');
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\nreturn { resolveTaskEnabled, TASK_FEATURE_KEY };`)();
}

let resolveTaskEnabled = null;
try {
  resolveTaskEnabled = loadResolveTaskEnabled().resolveTaskEnabled;
  lines.push('  ok    成功抽取并加载 resolveTaskEnabled');
  passed++;
} catch (e) {
  failed++;
  lines.push(`  FAIL  抽取 resolveTaskEnabled 失败: ${e.message}`);
}

if (typeof resolveTaskEnabled === 'function') {
  const acc = (features, extra = {}) => ({ enabled: true, features, ...extra });

  test('打卡：账号级 autoSign=false 必须判定为关闭（#43 核心回归）', () => {
    const r = resolveTaskEnabled(acc({ keepAlive: true, autoSign: false }), null, 'sign');
    assert.strictEqual(r.enabled, false, '账号级打卡开关被忽略 —— 关掉开关任务仍会跑');
  });

  test('打卡：脏字段 features.sign=false 不得影响判定（证明读的是 autoSign）', () => {
    const r = resolveTaskEnabled(acc({ sign: false }), null, 'sign');
    assert.strictEqual(r.enabled, true, '读取了错误的字段名 sign');
  });

  test('打卡：default 开启', () => {
    assert.strictEqual(resolveTaskEnabled(acc({}), null, 'sign').enabled, true);
  });

  test('挂机：保活关闭不得影响挂机任务执行（脱钩验证）', () => {
    const r = resolveTaskEnabled(acc({ keepAlive: false, cloudHang: true }), { taskEnabled: true }, 'cloudHang');
    assert.strictEqual(r.enabled, true, '保活开关错误地影响了任务执行');
  });

  test('挂机：cloudHang=false 关闭', () => {
    assert.strictEqual(resolveTaskEnabled(acc({ cloudHang: false }), null, 'cloudHang').enabled, false);
  });

  test('挂机：单机 taskEnabled=false 关闭', () => {
    assert.strictEqual(
      resolveTaskEnabled(acc({ cloudHang: true }), { taskEnabled: false }, 'cloudHang').enabled,
      false
    );
  });

  test('保活：账号级 keepAlive=false 关闭（不会被任务开关救回）', () => {
    assert.strictEqual(resolveTaskEnabled(acc({ keepAlive: false }), { taskEnabled: true }, 'keepAlive').enabled, false);
  });

  test('保活：单机 keepaliveEnabled=false 关闭', () => {
    assert.strictEqual(
      resolveTaskEnabled(acc({ keepAlive: true }), { keepaliveEnabled: false }, 'keepAlive').enabled,
      false
    );
  });

  test('账号停用：一律关闭', () => {
    assert.strictEqual(resolveTaskEnabled({ enabled: false, features: {} }, null, 'sign').enabled, false);
  });

  test('AI 对话：aiChat=false 关闭', () => {
    assert.strictEqual(resolveTaskEnabled(acc({ aiChat: false }), null, 'aiChat').enabled, false);
  });
}

// ============================================================================
// 组 7 · 移动云底层开机引擎不得复活（2026-09-22 用户硬性要求：不允许它出现）
// ============================================================================
// 背景：移动云"开机 / 唤醒"曾由 app/ydpc/boot_engine.js 实现 —— 它伪造官方 SC 客户端
// 身份（cdpsdk-server-1.0）、使用第三方开源项目硬编码的客户端 ID 与 RSA 公钥，并在 TLS
// 层关闭证书校验，直连 api.soho.komect.com 触发物理开机。用户明确要求此代码不得再出现。
// 本组把它变成机械约束：任何人重新种回该引擎，`npm test` 立刻变红。
group('组 7 · 移动云底层开机引擎不得复活');

const YDPC_BOOT_ENGINE = 'app/ydpc/boot_engine.js';

test('app/ydpc/boot_engine.js 必须不存在（SC/ZTE 底层直连开机引擎已整体删除）', () => {
  const abs = path.join(ROOT, YDPC_BOOT_ENGINE);
  assert.ok(
    !fs.existsSync(abs),
    `底层开机引擎文件重新出现：${YDPC_BOOT_ENGINE}。` +
      `该文件伪造官方 SC 客户端身份直连移动云网关，属用户明确要求"不得出现"的代码。`
  );
});

// 扫描生产源码中的"底层开机"指纹符号（沙箱内缺失的文件自动跳过）
const BOOT_SCAN_FILES = [
  'server.js',
  'app/tasks/scheduler.js',
  'app/tasks/native_tasks.js',
  'app/ydpc/ydpc_client.js',
  'app/ydpc/soho_client.js',
  'app/static/app.js',
];

// 一旦出现即代表底层开机能力被重新引入的"指纹"符号
const BOOT_FINGERPRINTS = [
  { re: /bootYdpcVmUnified/, why: 'SC/ZTE 自适应融合开机统一入口' },
  { re: /sc-user-5e38ece5/, why: '硬编码的第三方 SC 客户端 ID（伪造官方身份）' },
  { re: /SC_RSA_PK_SDK2/, why: '硬编码的第三方 SC RSA 公钥' },
  { re: /scBootVm\s*\(/, why: 'SC 直连开机函数' },
  { re: /scRsaEncryptVmId/, why: 'SC 专用 VMID 加密函数' },
  { re: /require\s*\(\s*['"][^'"]*boot_engine['"]\s*\)/, why: '对已删除开机引擎模块的引用' },
];

test('生产源码不得出现底层开机引擎的任何指纹符号', () => {
  const hits = [];
  for (const f of BOOT_SCAN_FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const { re, why } of BOOT_FINGERPRINTS) {
      const m = code.match(re);
      if (m) hits.push(`${f}  ←  ${why}  ${JSON.stringify(m[0])}`);
    }
  }
  assert.strictEqual(
    hits.length,
    0,
    '检测到底层开机引擎残留（用户明确要求不得出现）：\n        ' + hits.join('\n        ')
  );
});

test('ydpc_client.controlPower 必须对"开机/唤醒"显式拒绝，且不再有 bootVm 开机调用点', () => {
  const code = stripComments(read('app/ydpc/ydpc_client.js'));
  assert.ok(
    /已移除移动云【开机 \/ 唤醒】能力/.test(code),
    'ydpc_client 缺少对"开机/唤醒"的显式拒绝，可能退化为静默无响应或被重新接回开机引擎'
  );
  // 注意：官方 rebootVm 的字符串里含 "bootVm" 子串，会误报，先剔除 rebootVm 再检查
  const noReboot = code.replace(/rebootVm/g, '');
  assert.ok(!/\.bootVm\s*\(/.test(noReboot), 'ydpc_client 重新出现 bootVm() 开机调用点');
});

test('scheduler 的移动云分支不得再自动拉起开机', () => {
  const code = stripComments(read('app/tasks/scheduler.js'));
  const noReboot = code.replace(/rebootVm/g, '');
  assert.ok(!/\bbootVm\s*\(/.test(noReboot), 'scheduler 重新出现 bootVm() 自动拉起开机');
  assert.ok(!/bootYdpcVmUnified/.test(code), 'scheduler 重新出现 bootYdpcVmUnified 开机入口');
});

test('移动云账号 API 不得再接受 autoBootEnabled（天翼云 desktop 不受影响）', () => {
  // 前端已移除移动云"自动开机守护"开关，后端也必须对 ydpc 平台显式拒绝，杜绝该能力以任何形式复活
  assert.ok(
    /acc\.platform === 'ydpc' && featureName === 'autoBootEnabled'/.test(serverCode),
    'server.js 未对移动云平台的 autoBootEnabled 做显式拒绝，开机能力存在复活通道'
  );
});

// ============================================================================
// 汇总输出
// ============================================================================
console.log(lines.join('\n'));
console.log('\n' + '='.repeat(64));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(64));

if (failed > 0) {
  process.exit(1);
}
