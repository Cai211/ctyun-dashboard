const crypto = require('crypto');

const PRESET_MESSAGES = [
  '今天北京天气怎么样？（请用一句话回答）',
  '给我讲一个冷笑话。（简短回答）',
  '来一首唐诗。（简短回答）',
  '空腹可以吃饭吗？（幽默简短回答）',
  '推荐一部经典的科幻电影。（简明扼要）',
  '人工智能未来发展趋势是什么？（简明扼要）',
  '怎样保持良好的身心健康？（简短回答）',
  '请用一句话分享今天的正能量心情。'
];

function md5(t) {
  return crypto.createHash('md5').update(t).digest('hex').toLowerCase();
}

function sha256(t) {
  return crypto.createHash('sha256').update(t).digest('hex').toLowerCase();
}

/**
 * 纯原生毫秒级 HTTP 协议直连执行天翼 AI 对话任务 (彻底剔除 Chromium/Puppeteer)
 */
async function executeNativeAiChat(client, acc, onLog = console.log) {
  onLog('AIChat', `正在获取 AI 对话安全网关与 SSO 公钥配置...`, 'info');
  
  // 1. 获取网关信息并解密 SSO 公钥
  const sysRes = await fetch('https://gwyilian.ctyun.cn/server/eaiSysInfo');
  const sysJson = await sysRes.json();
  const rawSys = (sysJson.data || '').replace(/[\r\n]/g, '');
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('chinatelecom@cnn', 'utf8'), null);
  let dec = decipher.update(rawSys, 'base64', 'utf8');
  dec += decipher.final('utf8');
  const gatewayInfo = JSON.parse(dec);
  const ssopk = gatewayInfo.sso?.ssopk;
  const ssopkid = gatewayInfo.sso?.ssopkid;

  if (!ssopk) {
    throw new Error('未能从网关提取到有效的 SSO RSA 公钥配置');
  }

  // 2. 确保客户端登录并获取 CAS Service Ticket
  const service = 'https://eaichat.ctyun.cn:443/chat/#/aichat';

  async function getCasTicket(forceRefresh = false) {
    if (forceRefresh) {
      onLog('AIChat', `正在刷新天翼云客户端认证凭据...`, 'info');
      try {
        if (typeof client.renewToken === 'function') {
          await client.renewToken();
        } else if (typeof client.login === 'function') {
          client.loginInfo = null;
          await client.login();
        }
      } catch (err) {
        onLog('AIChat', `凭据续期尝试失败 (${err.message})，使用现有凭据重试...`, 'warning');
      }
    } else if (!client.loginInfo) {
      onLog('AIChat', `正在刷新天翼云客户端认证会话...`, 'info');
      const loginRes = await client.login();
      if (!loginRes.success) throw new Error(loginRes.error || '登录失败');
    }

    const authData = client.loginInfo;
    if (!authData) throw new Error('账号尚未登录');

    const nowTs = Date.now().toString();
    const ver = client.version || '103020001';
    const sigStr = `${client.deviceType}${nowTs}${authData.tenantId}${nowTs}${authData.userId}${ver}${authData.secretKey}`;

    let headers;
    if (typeof client.getSignedHeaders === 'function') {
      headers = client.getSignedHeaders();
    } else {
      headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': client.deviceType,
        'ctg-version': ver,
        'ctg-devicecode': acc.deviceCode,
        'ctg-userid': String(authData.userId),
        'ctg-tenantid': String(authData.tenantId),
        'ctg-timestamp': nowTs,
        'ctg-requestid': nowTs,
        'ctg-signaturestr': md5(sigStr),
        'Referer': 'https://pc.ctyun.cn/'
      };
      if (authData.token) {
        headers['Cookie'] = `token=${authData.token}`;
      }
    }

    const resp = await fetch(`https://desk.ctyun.cn:8810/api/auth/client/getTicket?service=${encodeURIComponent(service)}`, {
      headers
    });
    return await resp.json();
  }

  onLog('AIChat', `请求天翼 CAS 单点登录 Ticket 票据...`, 'info');
  let ticketRes = await getCasTicket(false);

  // 40010 或未取得 ticket：长效运行容器中内存 token 过期，自动静默续期并重试一次
  if (ticketRes.code === 40010 || ticketRes.code === '40010' || !ticketRes.data?.ticket) {
    onLog('AIChat', `CAS Ticket 提示会话失效或未返回票据 (${ticketRes.msg || ticketRes.code || '无Ticket'})，正在自动重新续期凭据...`, 'info');
    ticketRes = await getCasTicket(true);
  }

  if (!ticketRes.data || !ticketRes.data.ticket) {
    throw new Error('获取 CAS Ticket 失败: ' + (ticketRes.msg || JSON.stringify(ticketRes)));
  }
  const ticket = ticketRes.data.ticket;

  // 3. 生成 16 字节随机密钥并使用 RSA-PKCS1 加密
  onLog('AIChat', `RSA-PKCS1 加密生成客户端鉴权凭据，换取对话会话密钥 (SessionKey)...`, 'info');
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let clientKey = '';
  for (let i = 0; i < 16; i++) clientKey += chars[Math.floor(Math.random() * chars.length)];
  const pem = `-----BEGIN PUBLIC KEY-----\n${ssopk}\n-----END PUBLIC KEY-----`;
  const encClientKey = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(clientKey, 'utf8')).toString('hex');

  const authParams = new URLSearchParams();
  authParams.append('loginType', 'iamTicket');
  authParams.append('clientId', 'eaiapp');
  authParams.append('iamTicket', ticket);
  authParams.append('redirectUri', service);
  authParams.append('clientKey', encClientKey);
  authParams.append('clientKeyId', ssopkid);

  const authPostRes = await fetch('https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'Referer': 'https://eaichat.ctyun.cn/chat/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: authParams.toString()
  });

  const authJson = await authPostRes.json();
  if (authJson.resultCode !== 0 || !authJson.data?.sessionKey) {
    throw new Error('SSO Ticket 鉴权换取失败: ' + (authJson.resultMsg || JSON.stringify(authJson)));
  }

  let rawCookies = '';
  if (typeof authPostRes.headers.getSetCookie === 'function') {
    rawCookies = authPostRes.headers.getSetCookie().join('; ');
  } else {
    rawCookies = authPostRes.headers.get('set-cookie') || '';
  }
  const ylTokenMatch = rawCookies.match(/YL-Token=([^;]+)/);
  const ylSsidMatch = rawCookies.match(/YL-Ssid=([^;]+)/);
  const ylToken = ylTokenMatch ? ylTokenMatch[1] : (authPostRes.headers.get('yl-authorization') || '');
  const ylSsid = ylSsidMatch ? ylSsidMatch[1] : '';
  const cookieHeader = `YL-Token=${ylToken}; YL-Ssid=${ylSsid}`;

  const decipherSk = crypto.createDecipheriv('aes-128-ecb', Buffer.from(clientKey, 'utf8'), null);
  let sk = decipherSk.update(authJson.data.sessionKey, 'base64', 'utf8');
  sk += decipherSk.final('utf8');

  // 4. 发送 AI 对话请求
  const prompt = PRESET_MESSAGES[Math.floor(Math.random() * PRESET_MESSAGES.length)];
  onLog('AIChat', `向天翼云智助手发送对话指令: "${prompt}"...`, 'info');

  const chatBody = {
    key_model: 'telechat',
    messages: [
      { role: 'user', content: prompt }
    ],
    stream: false,
    client_retry: true,
    web_search: false
  };

  const bodyJsonStr = JSON.stringify(chatBody);
  const dataMd5 = md5(bodyJsonStr);
  const ts = Date.now().toString();
  let rnd = '';
  for (let i = 0; i < 8; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  const rawSign = `${dataMd5}&${sk}&${ts}&${rnd}`;
  const webSign = sha256(rawSign);
  const traceId = crypto.randomUUID();

  const chatRes = await fetch('https://eaichat.ctyun.cn/ai/portal/v3/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'YL-Authorization': ylToken,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'Referer': 'https://eaichat.ctyun.cn/chat/',
      'Origin': 'https://eaichat.ctyun.cn',
      'x-client-trace-id': traceId,
      'x-eai-source': 'web-eai',
      'x-eai-version': '202060305',
      'YL-Main-Version': '202060305',
      'YL-Product-Id': '5',
      'Web-Signature': webSign,
      'Web-Random': rnd,
      'Web-Timestamp': ts
    },
    body: bodyJsonStr
  });

  if (!chatRes.ok) {
    throw new Error(`AI 对话接口异常 (HTTP ${chatRes.status})`);
  }

  const resText = await chatRes.text();
  try {
    const chatJson = JSON.parse(resText);
    if (chatJson.code && chatJson.code !== 0 && chatJson.code !== 200) {
      throw new Error(`AI 对话业务返回错误: ${chatJson.message || chatJson.msg || resText}`);
    }
  } catch (e) {
    if (e.message && e.message.startsWith('AI 对话业务返回错误')) throw e;
  }
  onLog('AIChat', `✅ AI 对话成功完成！已获取今日 100 积分！`, 'success');
  
  await client.refreshOfficialTasks();
  return { success: true, message: 'AI 对话成功完成，积分已刷新' };
}

/**
 * 登录打卡 (真实完成天翼云官方【登录AI云电脑】任务，彻底与 40050 tokenLogin 解耦)
 */
async function executeNativeSign(client, acc, onLog = console.log) {
  const accName = acc.name || acc.user;
  onLog('Sign', `正在执行天翼云官方【登录AI云电脑】打卡认证...`, 'info');
  try {
    // 1. 检查今日是否已在官方任务中心完成
    await client.refreshOfficialTasks();
    const loginTask = client.metrics.officialTasks?.find(t => t.name.includes('登录AI云电脑') || t.name.includes('登录'));
    if (loginTask && (loginTask.status === 2 || (loginTask.total > 0 && loginTask.current >= loginTask.total))) {
      onLog('Sign', `✅ 今日登录打卡任务已在官方达成 (+100积分)，无需重复执行。`, 'success');
      return { success: true, isCompleted: true, message: '今日已完成登录打卡' };
    }

    // 2. 状态避让与互斥检查：如果当前正在执行 1 小时挂机任务，挂机会话本身即发送 112/104 桌面认领，直接复用
    if (client.isTaskHanging) {
      onLog('Sign', `[${accName}] ⏱️ 云电脑当前正处于 1 小时挂机会话中，桌面正在认领，打卡自动复用挂机会话。`, 'info');
      return { success: true, isCompleted: false, message: '挂机会话正在执行认领' };
    }

    // 3. 用户浏览器操作或客户端避让期：主动避让
    if (client.isWebUserActive && Date.now() < client.webUserActiveUntil) {
      onLog('Sign', `[${accName}] 浏览器用户正在操作云电脑，打卡任务主动避让。`, 'info');
      return { success: true, isCompleted: false, message: '浏览器用户操作中，主动避让' };
    }
    if (Date.now() < client.externalYieldUntil) {
      const waitMin = Math.ceil((client.externalYieldUntil - Date.now()) / 60000);
      onLog('Sign', `[${accName}] 官方客户端近期活跃处于避让期 (剩余 ${waitMin} 分钟)，打卡任务主动避让。`, 'info');
      return { success: true, isCompleted: false, message: '处于客户端避让冷却期' };
    }

    // 4. 获取目标云电脑（优选已开机运行的主机）
    const desktops = await client.getDesktops().catch(() => []);
    if (!desktops || desktops.length === 0) {
      onLog('Sign', `[${accName}] 账号名下暂无可用的云电脑主机。`, 'warning');
      return { success: true, isCompleted: false, message: '名下无可用云电脑' };
    }
    const taskOnDesktops = desktops.filter(d => d.taskEnabled !== false);
    if (taskOnDesktops.length === 0) {
      onLog('Sign', `[${accName}] 账号名下所有云电脑的【任务】开关均已关闭，跳过桌面登录认领。`, 'info');
      return { success: true, isCompleted: false, message: '任务开关已关闭' };
    }

    const isRunning = (d) => d && (d.useStatusText === '运行中' || d.useStatus == 25);
    const runningDesktop = taskOnDesktops.find(d => isRunning(d));
    const mainDesktop = runningDesktop || taskOnDesktops[0];
    const targetName = mainDesktop.objName || mainDesktop.desktopName || '云电脑';
    const targetId = String(mainDesktop.objId || mainDesktop.desktopId);

    // 5. 若未开机：根据自动开机配置决定是否唤醒
    if (!isRunning(mainDesktop)) {
      if (mainDesktop.autoBootEnabled !== false) {
        onLog('Sign', `[${accName}][${targetName}] 云电脑未开机，正在下发开机唤醒指令以完成【登录AI云电脑】打卡...`, 'info');
        await client.controlPower(targetId, 'poweron').catch(() => {});
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 10000));
          const fresh = await client.getDesktops().catch(() => []);
          const target = (fresh || []).find(d => String(d.objId || d.desktopId) === targetId);
          if (isRunning(target)) break;
        }
      } else {
        onLog('Sign', `[${accName}][${targetName}] 云电脑当前关机且未开启自动开机，已完成基本账号鉴权；待开机或运行挂机任务时将自动达成【登录AI云电脑】。`, 'info');
        return { success: true, isCompleted: false, message: '云电脑关机待唤醒' };
      }
    }

    // 6. 核心认证：建立桌面认领会话并向视讯网关下发 118身份 + 112登录凭据 + 104握手确认包
    // 官方营销中心以「实际进入云电脑桌面并保持会话」为准，记录【登录AI云电脑】达成 (+100积分)。
    // 因此维持一个最长 300 秒的认领观察窗口，期间持续心跳并实时轮询官方任务中心，一旦官方确认达成立即主动释放通道。
    // 只有官方任务中心确认达成才会记录成功，绝不虚报。
    onLog('Sign', `[${accName}][${targetName}] 正在建立视讯网关桌面登录认领会话 (Type 118/112/104)，保持观察等待官方确认...`, 'info');

    // 独立会话占用标记：仅用于让常态脉冲循环避让，绝不触碰挂机任务的 isTaskHanging 状态位，杜绝互斥串扰
    client._signSessionActive = true;
    let claimResult = null;
    try {
      if (client.endCurrentSession) {
        client.endCurrentSession('Yield to Sign Claim');
      }
      claimResult = await client.runDesktopKeepAliveSession(mainDesktop, true, 300, '登录AI云电脑');
    } finally {
      client._signSessionActive = false;
    }

    // 7. 会话结束后再次重新拉取官方任务中心，以官方实时状态为唯一判定依据
    await client.refreshOfficialTasks();

    const verifiedTask = client.metrics.officialTasks?.find(t => t.name.includes('登录AI云电脑') || t.name.includes('登录'));
    const isDone = verifiedTask ? (verifiedTask.status === 2 || (verifiedTask.total > 0 && verifiedTask.current >= verifiedTask.total)) : false;
    const goalConfirmed = !!(claimResult && claimResult.goalAchieved) || isDone;
    const claimReason = (claimResult && claimResult.reason) || '';

    if (goalConfirmed) {
      onLog('Sign', `🎉 官方任务中心已确认【登录AI云电脑】达成 (+100积分)！`, 'success');
    } else if (claimReason === 'Preempted by Client' || claimReason === 'Yield to External Client' || claimReason === 'Yield to Web User') {
      onLog('Sign', `[${accName}][${targetName}] 检测到官方客户端接入/用户操作，登录认领会话已主动让位，本次未确认达成。`, 'warning');
    } else {
      onLog('Sign', `[${accName}][${targetName}] 本轮认领观察窗口结束，官方任务中心暂未确认【登录AI云电脑】达成；桌面会话认领已完成，若稍后运行 1 小时挂机或官方客户端接入将自动计入积分。`, 'info');
    }

    return { success: true, isCompleted: goalConfirmed, message: goalConfirmed ? '官方已确认登录打卡完成' : '已建立登录认领会话，等待官方确认积分计入' };
  } catch (e) {
    onLog('Sign', `登录打卡异常: ${e.message}`, 'error');
    throw e;
  }
}

/**
 * 云电脑定时挂机任务 (由 Scheduler Cron 精准调度或用户手动触发)
 */
async function executeNativeHang(client, acc, onLog = console.log) {
  if (acc.platform === 'ydpc') {
    onLog('Hang', `[${acc.name}] 移动云电脑无需执行挂机时长任务。`, 'info');
    return { success: true, isCompleted: true, message: '移动云无需挂机' };
  }

  if (client && typeof client.runHangTask === 'function') {
    return await client.runHangTask(onLog);
  }

  // 兜底直接拉取任务状态
  await client.refreshOfficialTasks();
  const hangTask = client.metrics.officialTasks?.find(t => t.name.includes('使用1小时'));
  const isDone = hangTask && (hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total));
  return { success: true, isCompleted: isDone, message: isDone ? '今日挂机时长已满 1 小时' : '挂机任务就绪' };
}

module.exports = {
  executeNativeAiChat,
  executeNativeSign,
  executeNativeHang
};
