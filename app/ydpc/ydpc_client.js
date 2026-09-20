const { SohoClient } = require('./soho_client');
const { performCagAuthHold } = require('./cag_client');
const { bootYdpcVmUnified } = require('./boot_engine');
const { MqttKeepAliveClient } = require('./mqtt_client');

function getBeijingTimeString() {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeOnly() {
  const d = new Date();
  return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function isYdpcVmOff(vm) {
  if (!vm) return false;
  const st = String(vm.vmStatus || vm.vmStatusShow || '').trim();
  if (st.includes('关机') || st.includes('停止') || st.includes('未开机') || st.includes('到期') || st.includes('未知')) return true;
  if (st === '23' || st === '16' || st === '0') return true;
  if (vm.vmStatus === 23 || vm.vmStatus === 16 || vm.vmStatus === 0 || vm.vmStatusCode === 23 || vm.vmStatusCode === 16 || vm.vmStatusCode === 0) return true;
  return false;
}

class YdpcClient {
  constructor(account, { appendLog, sendNotification, saveConfig }) {
    this.account = account;
    this.appendLog = appendLog || (() => {});
    this.sendNotification = sendNotification || (() => {});
    this.saveConfig = saveConfig || (() => {});

    this.sohoClient = new SohoClient({
      deviceId: account.deviceCode,
      accountType: account.accountType || 'main'
    });

    this.metrics = {
      status: 'offline', // 'online' | 'offline'
      vmStatus: account.stats?.vmStatus || '未知',
      durationMode: account.stats?.durationMode || 'permanent',
      remainHours: account.stats?.remainHours || 0,
      remainText: account.stats?.remainText || '♾️ 永久使用',
      lastHeartbeatTime: account.stats?.lastKeepAliveTime || '',
      lastHeartbeatResult: '保活巡检待命中',
      successCount: 0,
      errorCount: 0,
      vms: account.vms || []
    };

    this.workerRunning = false;
    this.loopTimer = null;
    this.mqttClient = null;
  }

  async login() {
    const accName = this.account.name || this.account.user;
    try {
      this.appendLog('SOHO', `[${accName}] 正在向中国移动 SOHO 认证中心登录 (类型: ${this.account.accountType === 'sub' ? '独立子账号' : '和家亲主账号'})...`, 'info', accName, 'ydpc');
      const res = await this.sohoClient.login(this.account.user, this.account.password, this.account.accountType || 'main');
      this.appendLog('SOHO', `[${accName}] ✅ SOHO 鉴权登录成功 (UserId: ${res.userId})`, 'success', accName, 'ydpc');
      return { success: true, data: res };
    } catch (err) {
      this.appendLog('SOHO', `[${accName}] ❌ SOHO 登录失败: ${err.message}`, 'error', accName, 'ydpc');
      return { success: false, error: err.message };
    }
  }

  async refreshVms() {
    const accName = this.account.name || this.account.user;
    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const vms = await this.sohoClient.listCloudPcs();

      // 自动嗅探识别每台主机的底层架构底座 (深信服 SCG vs 中兴 ZTE)
      for (const vm of vms) {
        if (!vm.vendor) {
          try {
            const auth = await this.sohoClient.getFirmAuth(vm.userServiceId);
            if (auth) {
              if (auth.scAuthCode && !auth.cagIp) {
                vm.vendor = 'SCG';
                vm.vendorName = '深信服 SCG';
              } else if (auth.cagIp || auth.vmUserName || auth.vmcIp) {
                vm.vendor = 'ZTE';
                vm.vendorName = '中兴 ZTE';
              }
            }
          } catch (e) {
            // 优雅降级：依据 SPU/SKU/名称特征自适应判定
            const rawText = `${vm.vmName} ${vm.skuName} ${vm.spuCode}`;
            if (/深信服|家庭|SCG/i.test(rawText)) {
              vm.vendor = 'SCG';
              vm.vendorName = '深信服 SCG';
            } else {
              vm.vendor = 'ZTE';
              vm.vendorName = '中兴 ZTE';
            }
          }
        }
      }

      // 差量合并引擎 (Diff-Merge)：严格保留本地已有的单机独立保活、独立周期与开机偏好设置
      const oldVmsMap = new Map((this.account.vms || []).map(v => [String(v.userServiceId), v]));
      for (const vm of vms) {
        const old = oldVmsMap.get(String(vm.userServiceId));
        if (old) {
          if (old.keepaliveEnabled !== undefined) vm.keepaliveEnabled = old.keepaliveEnabled;
          if (old.autoBootEnabled !== undefined) vm.autoBootEnabled = old.autoBootEnabled;
          if (old.keepaliveInterval !== undefined) vm.keepaliveInterval = old.keepaliveInterval;
          if (old.lastKeepAliveAt !== undefined) vm.lastKeepAliveAt = old.lastKeepAliveAt;
          if (old._durationExhausted !== undefined) vm._durationExhausted = old._durationExhausted;
          if (old._bootRestricted !== undefined) vm._bootRestricted = old._bootRestricted;
        } else {
          if (vm.keepaliveEnabled === undefined) vm.keepaliveEnabled = true;
          if (vm.autoBootEnabled === undefined) vm.autoBootEnabled = true;
        }
      }

      this.account.vms = vms;
      this.metrics.vms = vms;

      if (vms.length > 0) {
        const first = vms[0];
        const anyRunning = vms.some(v => !isYdpcVmOff(v));
        this.metrics.status = anyRunning ? 'online' : 'offline';
        this.metrics.vmStatus = first.vmStatus;
        this.metrics.durationMode = first.durationMode;
        this.metrics.remainHours = first.remainHours;
        this.metrics.remainText = first.remainText;
        
        this.account.stats = this.account.stats || {};
        this.account.stats.keepAliveStatus = this.metrics.status;
        this.account.stats.vmStatus = first.vmStatus;
        this.account.stats.durationMode = first.durationMode;
        this.account.stats.remainHours = first.remainHours;
        this.account.stats.remainText = first.remainText;

        if (!anyRunning) {
          this.metrics.lastHeartbeatResult = `云电脑处于已关机状态 (${first.remainText || ''})`;
        }
      }
      this.saveConfig();
      return vms;
    } catch (err) {
      this.appendLog('SOHO', `[${accName}] 刷新云电脑列表异常: ${err.message}`, 'error', accName, 'ydpc');
      return this.account.vms || [];
    }
  }

  async ensureMqttConnection() {
    const accName = this.account.name || this.account.user;
    if (this.account.features?.mqttKeepAlive === false) {
      if (this.mqttClient) {
        this.mqttClient.disconnect();
        this.mqttClient = null;
      }
      return;
    }

    // 智能限时/到期/全关机感知：若名下所有云电脑均已关机或 20 小时限时套餐已耗尽，绝不发起无效 MQTT 连接
    const vms = this.account.vms || [];
    const allOffOrExhausted = vms.length > 0 && vms.every(vm => {
      const isVmOff = String(vm.vmStatus || '').includes('关机') || vm.vmStatusCode === 23 || vm.vmStatusCode === 16;
      const isPermanent = vm.durationMode === 'permanent' || String(vm.remainText || '').includes('永久');
      const isLimitedExpired = !isPermanent && (
        vm._durationExhausted || (
          vm.durationMode === 'limited' && (
            vm.remainHours <= 0 || 
            (typeof vm.remainDurationTime === 'number' && vm.remainDurationTime <= 0) ||
            String(vm.remainText || '').includes('0小时') ||
            String(vm.remainText || '').includes('已耗尽')
          )
        ) || (
          (String(vm.skuName || '').includes('20小时') || String(vm.vmName || '').includes('20小时')) &&
          (vm.remainHours <= 0 || (typeof vm.remainDurationTime === 'number' && vm.remainDurationTime <= 0) || String(vm.remainText || '').includes('0小时') || String(vm.remainText || '').includes('已耗尽'))
        )
      );
      return isVmOff || isLimitedExpired || vm.keepaliveEnabled === false;
    });

    if (allOffOrExhausted) {
      if (this.mqttClient) {
        this.mqttClient.disconnect();
        this.mqttClient = null;
      }
      return;
    }

    if (this.mqttClient && this.mqttClient.isConnected) {
      return;
    }

    // 防频繁重试退避：若上次连接失败，至少冷却 5 分钟（300s）后再重试，绝不刷屏
    if (this._lastMqttFailedAt && Date.now() - this._lastMqttFailedAt < 300000) {
      return;
    }

    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const res = await this.sohoClient.getMqttConnectInfo();
      if (res && res.code === 2000 && res.data) {
        const info = res.data;
        const host = info.host || 'alive.soho.komect.com';
        const port = Number(info.port) || 443;
        const clientId = info.clientId || `cl_${this.account.user.slice(-4)}_${Date.now().toString(36)}`;
        const username = info.userName || info.username || '';
        const password = info.password || '';
        const keepAliveSeconds = Number(info.keepAlive) || 60;

        if (this.mqttClient) {
          this.mqttClient.disconnect();
        }

        this.mqttClient = new MqttKeepAliveClient({
          host,
          port,
          clientId,
          username,
          password,
          keepAliveSeconds,
          onLog: (src, msg, lvl) => this.appendLog(src, `[${accName}] ${msg}`, lvl, accName, 'ydpc')
        });

        await this.mqttClient.connect(10000);
        this._lastMqttFailedAt = 0;
        this.appendLog('MQTT', `[${accName}] 🟢 官方 MQTT 3.1.1 over TLS 链路已连接保持 (Broker: ${host})`, 'success', accName, 'ydpc');
      }
    } catch (err) {
      this._lastMqttFailedAt = Date.now();
      this.appendLog('MQTT', `[${accName}] MQTT 链路连接异常: ${err.message} (已转入5分钟静默退避)`, 'warning', accName, 'ydpc');
    }
  }

  async sendHeartbeat(userServiceId) {
    const accName = this.account.name || this.account.user;
    const usid = userServiceId || this.account.vms?.[0]?.userServiceId;
    if (!usid) throw new Error('未找到有效的 userServiceId');

    const currentVm = (this.account.vms || []).find(v => String(v.userServiceId) === String(usid));
    if (currentVm && isYdpcVmOff(currentVm)) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      this.metrics.lastHeartbeatResult = `云电脑 [${currentVm.vmName}] 处于已关机状态 (待命中)`;
      this.appendLog('SOHO', `[${accName}][${currentVm.vmName}] 云电脑当前处于已关机状态，心跳守护待命中。`, 'info', accName, 'ydpc');
      return { success: true, message: '云电脑处于关机状态' };
    }

    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const res = await this.sohoClient.heartbeat(usid);
      
      // 触发官方活跃度埋点上报 (对齐 point.soho.komect.com)
      this.sohoClient.pointEvent('heartbeat', { userServiceId: Number(usid) }).catch(() => {});

      const nowStr = getBeijingTimeOnly();
      this.metrics.status = 'online';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'online';
      this.metrics.lastHeartbeatTime = nowStr;
      this.metrics.lastHeartbeatResult = `SOHO 心跳保持活跃 (${nowStr})`;
      this.appendLog('SOHO', `[${accName}] 💓 SOHO 心跳保持成功 (userServiceId: ${usid})`, 'info', accName, 'ydpc');
      return res;
    } catch (err) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      this.metrics.lastHeartbeatResult = `心跳异常: ${err.message}`;
      throw err;
    }
  }

  async pingCag(userServiceId, holdSeconds = 3) {
    const accName = this.account.name || this.account.user;
    const usid = userServiceId || this.account.vms?.[0]?.userServiceId;
    if (!usid) throw new Error('未找到有效的 userServiceId');

    const currentVm = (this.account.vms || []).find(v => String(v.userServiceId) === String(usid));
    if (currentVm && isYdpcVmOff(currentVm)) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      this.metrics.lastHeartbeatResult = `云电脑 [${currentVm.vmName}] 处于已关机状态 (待命中)`;
      return { success: false, message: '云电脑处于关机状态' };
    }

    try {
      if (!this.sohoClient.sohoToken) {
        await this.login();
      }
      const firmAuth = await this.sohoClient.getFirmAuth(usid);
      this.appendLog('CAG', `[${accName}] 正在向中兴 CAG 网关 (${firmAuth.cagIp}:${firmAuth.cagPort}) 发起 ZTEC TCP 三阶段握手...`, 'info', accName, 'ydpc');

      const cagRes = await performCagAuthHold(firmAuth, holdSeconds);
      const nowStr = getBeijingTimeOnly();
      
      this.metrics.status = 'online';
      this.metrics.lastHeartbeatTime = nowStr;
      this.metrics.lastHeartbeatResult = `ZTEC CAG 握手 200 OK (${nowStr})`;
      this.metrics.successCount++;

      this.account.stats = this.account.stats || {};
      this.account.stats.keepAliveStatus = 'online';
      this.account.stats.lastKeepAliveTime = getBeijingTimeString();
      this.saveConfig();

      this.appendLog('CAG', `[${accName}] 🟢 ZTEC CAG TCP 三阶段握手成功，网关返回 200 OK！`, 'success', accName, 'ydpc');
      return cagRes;
    } catch (err) {
      this.metrics.status = 'offline';
      if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
      const errMsg = err.message || '';
      if (errMsg.includes('用完') || errMsg.includes('已用尽') || errMsg.includes('计费周期') || errMsg.includes('到期') || errMsg.includes('欠费')) {
        this.metrics.lastHeartbeatResult = `时长已耗尽 (${errMsg})`;
        if (currentVm) {
          currentVm.durationMode = 'limited';
          currentVm.remainText = '⏱️ 0小时';
          currentVm.remainHours = 0;
          currentVm._durationExhausted = true;
        }
        this.metrics.remainText = '⏱️ 0小时';
        this.metrics.remainHours = 0;
      } else {
        this.metrics.lastHeartbeatResult = `CAG 握手受阻: ${errMsg}`;
      }
      this.saveConfig();
      throw err;
    }
  }

  async bootVm(userServiceId) {
    return await this.controlPower(userServiceId, 'poweron');
  }

  async controlPower(userServiceId, action = 'poweron') {
    const accName = this.account.name || this.account.user;
    const usid = userServiceId || this.account.vms?.[0]?.userServiceId;
    if (!usid) throw new Error('未找到有效的 userServiceId');

    if (!this.sohoClient.sohoToken) {
      await this.login();
    }

    const actionLower = (action || '').toLowerCase();
    if (actionLower === 'reboot') {
      this.appendLog('SOHO', `[${accName}] 正在向移动云下发【重启】指令 (userServiceId: ${usid})...`, 'info', accName, 'ydpc');
      const res = await this.sohoClient.rebootVm(usid);
      this.appendLog('SOHO', `[${accName}] ✅ 云电脑重启指令已生效！`, 'success', accName, 'ydpc');
      setTimeout(() => this.refreshVms().catch(() => {}), 3000);
      return res;
    } else if (actionLower === 'shutdown' || actionLower === 'poweroff') {
      this.appendLog('SOHO', `[${accName}] 正在向移动云下发【关机/断开】指令 (userServiceId: ${usid})...`, 'info', accName, 'ydpc');
      const res = await this.sohoClient.shutdownVm(usid);
      this.appendLog('SOHO', `[${accName}] ✅ 云电脑关机/断开指令已生效！`, 'success', accName, 'ydpc');
      setTimeout(() => this.refreshVms().catch(() => {}), 2000);
      return res;
    } else {
      // poweron / awake / start: 走 SC/ZTE 自适应融合开机
      this.appendLog('SOHO', `[${accName}] 正在执行移动云【开机/唤醒】指令 (userServiceId: ${usid})...`, 'info', accName, 'ydpc');
      let firmAuth = null;
      try {
        firmAuth = await this.sohoClient.getFirmAuth(usid);
      } catch (e) {}

      const currentVm = (this.account.vms || []).find(v => String(v.userServiceId) === String(usid)) || {};
      const res = await bootYdpcVmUnified(this.sohoClient, firmAuth, usid, currentVm);
      this.appendLog('SOHO', `[${accName}] ✅ ${res.message || '云电脑开机/激活指令已成功下达！'}`, 'success', accName, 'ydpc');
      setTimeout(() => this.refreshVms().catch(() => {}), 3000);
      return res;
    }
  }

  startKeepAliveWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    const accName = this.account.name || this.account.user;

    const defaultIntervalSec = Math.max(60, parseInt(this.account.keepaliveInterval) || 600);
    this.appendLog('CAG', `[${accName}] 移动云电脑多机独立时间戳看门狗已启动 (基准周期: ${Math.round(defaultIntervalSec / 60)} 分钟)...`, 'info', accName, 'ydpc');

    // 守护看门狗以 20 秒为基准时间片高精度巡检各单机
    const TICK_INTERVAL_MS = 20000;

    const runCycle = async () => {
      if (!this.workerRunning) return;
      try {
        const isAllChannelsOff = this.account.features?.cagKeepAlive === false && 
                                 this.account.features?.mqttKeepAlive === false && 
                                 this.account.features?.sohoHeartbeat === false;
        if (this.account.features?.keepAlive === false || isAllChannelsOff) {
          this.metrics.status = 'offline';
          this.metrics.lastHeartbeatResult = '自动化保活通道已全部关闭 (待命中)';
          if (this.workerRunning) {
            this.loopTimer = setTimeout(runCycle, TICK_INTERVAL_MS);
          }
          return;
        }

        // 定期静默刷新 VM 状态 (每 60 秒一次)
        if (!this._lastVmsRefreshAt || Date.now() - this._lastVmsRefreshAt > 60000) {
          await this.refreshVms().catch(() => {});
          this._lastVmsRefreshAt = Date.now();
        }

        const vms = this.account.vms || [];
        const anyRunning = vms.some(v => String(v.vmStatus || '').includes('运行') || v.vmStatusCode === 1);
        if (!anyRunning) {
          this.metrics.status = 'offline';
          if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
          this.metrics.lastHeartbeatResult = '云电脑处于已关机状态，自动守护待命中';
        }

        const now = Date.now();
        for (const vm of vms) {
          if (vm.keepaliveEnabled === false) continue;

          // 核心：单机独立时间戳差量调度 (Per-Device Interval Wheel)
          const vmIntervalSec = Math.max(60, parseInt(vm.keepaliveInterval) || defaultIntervalSec);
          const lastActive = vm.lastKeepAliveAt || 0;
          const elapsedSec = Math.floor((now - lastActive) / 1000);

          // 时间未到达该主机的专属周期，继续休眠跳过
          if (lastActive > 0 && elapsedSec < vmIntervalSec) {
            continue;
          }

          const isVmOff = String(vm.vmStatus || '').includes('关机') || vm.vmStatusCode === 23 || vm.vmStatusCode === 16;
          const isSubAccount = this.account.accountType === 'sub';

          const isPermanent = vm.durationMode === 'permanent' || String(vm.remainText || '').includes('永久');
          const isLimitedExpired = !isPermanent && (
            vm._durationExhausted || (
              vm.durationMode === 'limited' && (
                vm.remainHours <= 0 || 
                (typeof vm.remainDurationTime === 'number' && vm.remainDurationTime <= 0) ||
                String(vm.remainText || '').includes('0小时') ||
                String(vm.remainText || '').includes('已耗尽') ||
                String(vm.remainText || '').includes('用完')
              )
            ) || (
              (String(vm.skuName || '').includes('20小时') || String(vm.vmName || '').includes('20小时')) &&
              (vm.remainHours <= 0 || (typeof vm.remainDurationTime === 'number' && vm.remainDurationTime <= 0) || String(vm.remainText || '').includes('0小时') || String(vm.remainText || '').includes('已耗尽') || String(vm.remainText || '').includes('用完'))
            )
          );

          // 1. 自动开机守护逻辑
          const isAutoBootAllowed = this.account.features?.autoBoot !== false && vm.autoBootEnabled !== false;
          if (isAutoBootAllowed && isVmOff) {
            if (isLimitedExpired) {
              if (!vm._hasWarnedExpired) {
                this.appendLog('SOHO', `[${accName}][${vm.vmName}] 检测到机器已关机，由于限时套餐时长已耗尽 (${vm.remainText || '0小时'})，已智能跳过自动开机守护`, 'info', accName, 'ydpc');
                vm._hasWarnedExpired = true;
              }
            } else if (isSubAccount || vm._bootRestricted) {
              if (!vm._hasWarnedSub) {
                this.appendLog('SOHO', `[${accName}][${vm.vmName}] 检测到机器已关机，受平台架构权限限制无法直接拉起，已进入被动守护待命模式`, 'info', accName, 'ydpc');
                vm._hasWarnedSub = true;
              }
            } else {
              this.appendLog('SOHO', `[${accName}][${vm.vmName}] 检测到机器已关机，触发【自动开机守护】拉起中...`, 'warning', accName, 'ydpc');
              await this.bootVm(vm.userServiceId).catch(err => {
                this.appendLog('SOHO', `[${accName}][${vm.vmName}] 自动开机未成功: ${err.message}`, 'warning', accName, 'ydpc');
                if (err.message?.includes('子账号受限') || err.message?.includes('无权访问') || err.message?.includes('4141') || err.message?.includes('选择云电脑类型') || err.message?.includes('7025') || err.message?.includes('中兴ZTE云电脑已完成激活')) {
                  vm._bootRestricted = true;
                }
              });
            }
          }

          // 2. 发送 SOHO 心跳与埋点
          if (this.account.features?.sohoHeartbeat !== false && !isLimitedExpired && !isVmOff) {
            await this.sendHeartbeat(vm.userServiceId).catch(() => {});
          }

          // 3. 执行 CAG TCP 握手保活
          if (this.account.features?.cagKeepAlive !== false && !isVmOff && !isLimitedExpired) {
            await this.pingCag(vm.userServiceId, 3).then(() => {
              this.appendLog('CAG', `[${accName}][${vm.vmName}] ZTEC CAG TCP 握手保活成功 (周期: ${Math.round(vmIntervalSec / 60)} 分钟)`, 'success', accName, 'ydpc');
            }).catch(e => {
              const errMsg = e.message || '';
              if (errMsg.includes('用完') || errMsg.includes('已用尽') || errMsg.includes('计费周期') || errMsg.includes('到期')) {
                vm._durationExhausted = true;
                vm.durationMode = 'limited';
                vm.remainText = '⏱️ 0小时';
                vm.remainHours = 0;
                this.metrics.remainText = '⏱️ 0小时';
                this.metrics.status = 'offline';
                this.metrics.lastHeartbeatResult = '当前计费周期时长已用完 (待命中)';
                if (!vm._hasWarnedExhausted) {
                  this.appendLog('CAG', `[${accName}][${vm.vmName}] 当前计费周期时长已用完，保活守护已自动转为静默休眠待命模式`, 'info', accName, 'ydpc');
                  vm._hasWarnedExhausted = true;
                }
              } else {
                this.appendLog('CAG', `[${accName}][${vm.vmName}] CAG 握手异常: ${errMsg}`, 'warning', accName, 'ydpc');
              }
            });
          }

          // 记录单机专属活跃时间戳并同步状态
          vm.lastKeepAliveAt = now;
          this.metrics.lastHeartbeatTime = getBeijingTimeString().slice(11);
          if (this.account.stats) this.account.stats.lastKeepAliveTime = getBeijingTimeString();
        }

        // 保持官方 MQTT 3.1.1 over TLS 链路
        if (this.account.features?.mqttKeepAlive !== false) {
          await this.ensureMqttConnection().catch(() => {});
        }

      } catch (err) {
        this.metrics.status = 'offline';
        this.metrics.lastHeartbeatResult = `异常: ${err.message}`;
        this.appendLog('CAG', `[${accName}] 移动云保活巡检异常: ${err.message}`, 'error', accName, 'ydpc');
      }

      if (this.workerRunning) {
        this.loopTimer = setTimeout(runCycle, TICK_INTERVAL_MS);
      }
    };

    // 延迟 2 秒立即执行首次
    setTimeout(runCycle, 2000);
  }

  stopKeepAliveWorker() {
    this.workerRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.mqttClient) {
      this.mqttClient.disconnect();
      this.mqttClient = null;
    }
    this.metrics.status = 'offline';
    if (this.account.stats) this.account.stats.keepAliveStatus = 'offline';
  }
}

module.exports = { YdpcClient };
