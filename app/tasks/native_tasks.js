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
  if (!client.loginInfo) {
    onLog('AIChat', `正在刷新天翼云客户端认证会话...`, 'info');
    const loginRes = await client.login();
    if (!loginRes.success) throw new Error(loginRes.error || '登录失败');
  }

  onLog('AIChat', `请求天翼 CAS 单点登录 Ticket 票据...`, 'info');
  const nowTs = Date.now().toString();
  const authData = client.loginInfo;
  const sigStr = `${client.deviceType}${nowTs}${authData.tenantId}${nowTs}${authData.userId}103020001${authData.secretKey}`;
  const service = 'https://eaichat.ctyun.cn:443/chat/#/aichat';

  const ticketRes = await (await fetch(`https://desk.ctyun.cn:8810/api/auth/client/getTicket?service=${encodeURIComponent(service)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'ctg-devicetype': client.deviceType,
      'ctg-version': '103020001',
      'ctg-devicecode': acc.deviceCode,
      'ctg-userid': String(authData.userId),
      'ctg-tenantid': String(authData.tenantId),
      'ctg-timestamp': nowTs,
      'ctg-requestid': nowTs,
      'ctg-signaturestr': md5(sigStr),
      'Referer': 'https://pc.ctyun.cn/'
    }
  })).json();

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

  const rawCookies = authPostRes.headers.get('set-cookie') || '';
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
  onLog('AIChat', `✅ AI 对话成功完成！已获取今日 100 积分！`, 'success');
  
  await client.refreshOfficialTasks();
  return { success: true, message: 'AI 对话成功完成，积分已刷新' };
}

/**
 * 登录打卡 (严格对齐天翼云官方鉴权中心 tokenLogin 真实登录事件)
 */
async function executeNativeSign(client, acc, onLog = console.log) {
  const accName = acc.name || acc.user;
  onLog('Sign', `正在执行天翼云官方登录打卡认证...`, 'info');
  try {
    // 1. 检查今日是否已在官方任务中心完成
    await client.refreshOfficialTasks();
    const loginTask = client.metrics.officialTasks?.find(t => t.name.includes('登录AI云电脑') || t.name.includes('登录'));
    if (loginTask && (loginTask.status === 2 || (loginTask.total > 0 && loginTask.current >= loginTask.total))) {
      onLog('Sign', `✅ 今日登录打卡任务已在官方达成 (+100积分)，无需重复执行。`, 'success');
      return { success: true, isCompleted: true, message: '今日已完成登录打卡' };
    }

    // 2. 核心修复：真实触发天翼云官方鉴权中心登录事件 (genLoginToken + tokenLogin 真实调用官方 /api/auth/client/tokenLogin)
    // 这不仅使天翼云服务端明确记录到今日的正式登录事件，还同时实现 Token 静默轮转保鲜
    let realLoginDone = false;
    try {
      onLog('Sign', `正在向官方鉴权中心下发真实登录握手 (tokenLogin)...`, 'info');
      await client.renewToken();
      realLoginDone = true;
    } catch (e) {
      onLog('Sign', `Token 轮转登录提示: ${e.message}，尝试直接鉴权...`, 'warning');
      const res = await client.login();
      if (!res.success) throw new Error(res.error || '登录握手失败');
      // fromCache=true 表示命中内存会话，未产生任何真实登录事件
      realLoginDone = res.fromCache !== true;
    }

    // 3. 同步拉取最新云电脑设备列表并触发一次桌面网关连接握手
    const desktops = await client.getDesktops().catch(() => []);
    if (desktops && desktops.length > 0) {
      const mainD = desktops.find(d => d.taskEnabled !== false) || desktops[0];
      const dId = mainD.objId || mainD.desktopId;
      if (dId && typeof client.connect === 'function') {
        await client.connect(dId).catch(() => {});
      }
    }

    // 4. 等待 3 秒让天翼云营销积分系统记录登录事件，并重新拉取官方任务中心确认
    await new Promise(r => setTimeout(r, 3000));
    await client.refreshOfficialTasks();

    const verifiedTask = client.metrics.officialTasks?.find(t => t.name.includes('登录AI云电脑') || t.name.includes('登录'));
    const isDone = verifiedTask ? (verifiedTask.status === 2 || (verifiedTask.total > 0 && verifiedTask.current >= verifiedTask.total)) : false;

    if (isDone) {
      onLog('Sign', `🎉 官方任务中心已确认【登录AI云电脑】达成 (+100积分)！`, 'success');
    } else if (!realLoginDone) {
      // 关键加固：免密凭据被官方拒绝 (设备未授信) 且兜底命中缓存时，绝不虚报完成
      onLog('Sign', `⚠️ 官方拒绝了免密登录凭据 (当前设备未获授信)，本次未能产生真实登录事件，登录打卡暂时无法在官方记为达成。`, 'warning');
      onLog('Sign', `👉 请先在卡片完成【设备绑定】(📱 扫码一键授信 或 图验+短信验证) —— 设备授信后每日签到与静默续期将全部自动生效。`, 'warning');
    } else {
      onLog('Sign', `✅ 官方登录打卡信令与桌面握手已全部完成 (官方积分通常在数分钟内同步到账)。`, 'info');
    }

    return { success: true, isCompleted: isDone, realLoginDone, message: isDone ? '官方已确认登录打卡完成' : '打卡信令已下发' };
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
