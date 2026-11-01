/**
 * B站活动模块：把「刷B站」做成鲸鱼娘插件的一项日常活动。
 *
 * 不依赖 dsh-bili-whale / dsh-bili-scroll 独立插件；只复用它们的思路：
 * - 搜索视频、读元信息、选一条、发一条 @ 主人的评论；
 * - 评论成功后通过 companion.bili 事件把同一个分享推到 App 对话；
 * - 凭据只存本机，不进日志、不进 App 备份。
 *
 * 这一版先做「搜索 + 选片 + 评论 @ + App 分享」，不接弹幕/直播/日记。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const DIR = path.join(DSH_HOME, 'whale-companion');
const CONFIG_FILE = path.join(DIR, 'bili.json');
const CRED_FILE = path.join(DIR, 'bili-credentials.json');
const STATE_FILE = path.join(DIR, 'bili-state.json');
const CHAT_TIMEOUT_MS = 30000;

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const DEFAULTS = {
  enabled: true,
  autoRun: true,
  autoComment: true,
  dailyLimit: 1,
  windowStart: '20:00',
  windowEnd: '24:00',
  skipChance: 0,
  plannedDate: '',
  plannedAt: 0,
  runsDate: '',
  runsToday: 0,
  skippedDate: '',
  history: [],
  keywords: ['AI 工具', '动画'],
  ownerName: '',
  ownerMid: '',
  lastRunDate: '',
  lastShare: null
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}

function clean(value, max = 2000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function todayKey(now = Date.now()) {
  const d = new Date(now);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return String(d.getFullYear()) + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function minuteOf(value, fallback) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value.trim())) {
    return fallback;
  }
  const [hour, minute] = value.trim().split(':').map(Number);
  return Math.max(0, Math.min(24 * 60, hour * 60 + minute));
}

function credentialHeaders(cred) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
  };
}

function parseCredentials(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    sessdata: clean(source.sessdata, 2000),
    bili_jct: clean(source.bili_jct, 200),
    buvid3: clean(source.buvid3, 500)
  };
}

function completeCredentials(cred) {
  return cred.sessdata.length > 0 && cred.bili_jct.length > 0;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`B站返回非 JSON（HTTP ${response.status}）`);
  }
  return { body, status: response.status, headers: response.headers };
}

/** 读取配置；凭据单独保存，GET 永远不回传。 */
export class BiliDuty {
  constructor({ getProfile, onShare, generateComment, log }) {
    this.getProfile = getProfile;
    this.onShare = onShare;
    this.generateComment = generateComment;
    this.log = log || (() => {});
    this.timer = null;
    this.running = false;
    this.wbi = null;
    this.wbiAt = 0;
    this.qr = null;
  }

  config() {
    const user = readJson(CONFIG_FILE, {});
    return {
      ...DEFAULTS,
      ...user,
      keywords: Array.isArray(user.keywords) && user.keywords.length > 0
        ? user.keywords.map(item => clean(item, 40)).filter(Boolean).slice(0, 8)
        : [...DEFAULTS.keywords],
      autoComment: user.autoComment !== false,
      autoRun: user.autoRun !== false,
      enabled: user.enabled !== false,
      windowStart: typeof user.windowStart === 'string' ? user.windowStart : (user.schedule || DEFAULTS.windowStart),
      windowEnd: typeof user.windowEnd === 'string' ? user.windowEnd : DEFAULTS.windowEnd,
      skipChance: Number.isFinite(Number(user.skipChance)) ? Math.max(0, Math.min(0.8, Number(user.skipChance))) : 0
    };
  }

  credentials() {
    return parseCredentials(readJson(CRED_FILE, {}));
  }

  publicConfig() {
    const config = this.config();
    const cred = this.credentials();
    return {
      enabled: config.enabled,
      autoRun: config.autoRun,
      autoComment: config.autoComment,
      dailyLimit: config.dailyLimit,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      skipChance: config.skipChance,
      plannedDate: config.plannedDate,
      plannedAt: config.plannedAt,
      runsToday: config.runsDate === todayKey() ? config.runsToday : 0,
      skippedDate: config.skippedDate,
      keywords: config.keywords,
      ownerName: config.ownerName,
      ownerMid: config.ownerMid,
      hasCredentials: completeCredentials(cred),
      lastRunDate: config.lastRunDate,
      lastShare: config.lastShare
    };
  }

  saveConfig(patch = {}) {
    const current = readJson(CONFIG_FILE, {});
    const next = { ...current };
    for (const key of ['enabled', 'autoRun', 'autoComment']) {
      if (typeof patch[key] === 'boolean') next[key] = patch[key];
    }
    if (Number.isFinite(Number(patch.dailyLimit))) {
      next.dailyLimit = Math.max(1, Math.min(1000000, Math.floor(Number(patch.dailyLimit))));
    }
    if (typeof patch.schedule === 'string' && /^\d{1,2}:\d{2}$/.test(patch.schedule.trim())) {
      if (patch.schedule.trim() !== (current.windowStart || DEFAULTS.windowStart)) {
        next.plannedDate = '';
      }
      next.windowStart = patch.schedule.trim();
    }
    if (typeof patch.windowStart === 'string' && /^\d{1,2}:\d{2}$/.test(patch.windowStart.trim())) {
      if (patch.windowStart.trim() !== (current.windowStart || DEFAULTS.windowStart)) {
        next.plannedDate = '';
      }
      next.windowStart = patch.windowStart.trim();
    }
    if (typeof patch.windowEnd === 'string' && /^\d{1,2}:\d{2}$/.test(patch.windowEnd.trim())) {
      if (patch.windowEnd.trim() !== (current.windowEnd || DEFAULTS.windowEnd)) {
        next.plannedDate = '';
      }
      next.windowEnd = patch.windowEnd.trim();
    }
    if (Number.isFinite(Number(patch.skipChance))) {
      if (Number(patch.skipChance) !== Number(current.skipChance ?? 0)) {
        next.plannedDate = '';
      }
      next.skipChance = Math.max(0, Math.min(0.8, Number(patch.skipChance)));
    }
    if (Array.isArray(patch.keywords)) {
      next.keywords = patch.keywords.map(item => clean(item, 40)).filter(Boolean).slice(0, 8);
    } else if (typeof patch.keywords === 'string') {
      next.keywords = patch.keywords.split(/\n|,/).map(item => clean(item, 40)).filter(Boolean).slice(0, 8);
    }
    if (typeof patch.ownerName === 'string') next.ownerName = clean(patch.ownerName, 80);
    if (typeof patch.ownerMid === 'string') next.ownerMid = clean(patch.ownerMid, 30);
    writeJson(CONFIG_FILE, next);

    if (patch.credentials && typeof patch.credentials === 'object') {
      const incoming = parseCredentials(patch.credentials);
      const old = this.credentials();
      const merged = {
        sessdata: incoming.sessdata || old.sessdata,
        bili_jct: incoming.bili_jct || old.bili_jct,
        buvid3: incoming.buvid3 || old.buvid3
      };
      if (completeCredentials(merged)) {
        writeJson(CRED_FILE, merged);
      }
    }
    return this.publicConfig();
  }

  async account() {
    const cred = this.credentials();
    if (!completeCredentials(cred)) {
      throw new Error('还没有配置 B 站登录 Cookie');
    }
    const { body } = await requestJson(
      'https://api.bilibili.com/x/web-interface/nav',
      { headers: credentialHeaders(cred) }
    );
    if (body.code !== 0 || body.data?.isLogin !== true) {
      throw new Error(body.message || 'B 站登录态无效，请重新填写 Cookie');
    }
    return { cred, mid: String(body.data.mid), name: String(body.data.uname || '') };
  }

  async qrStart() {
    const { body } = await requestJson(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
      {
        headers: {
          'user-agent': 'Mozilla/5.0',
          referer: 'https://passport.bilibili.com/login'
        }
      }
    );
    const url = body.data?.url;
    const key = body.data?.qrcode_key;
    if (body.code !== 0 || typeof url !== 'string' || typeof key !== 'string') {
      throw new Error('B站二维码生成失败');
    }
    const session = {
      id: crypto.randomUUID(),
      key,
      url,
      expiresAt: Date.now() + 180000,
      status: 'waiting'
    };
    this.qr = session;
    return { sessionId: session.id, url, expiresAt: session.expiresAt, status: session.status };
  }

  async qrPoll(sessionId) {
    const session = this.qr;
    if (!session || session.id !== sessionId) {
      throw new Error('二维码会话已失效，请重新生成');
    }
    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      return { status: 'expired' };
    }
    const { body, headers } = await requestJson(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(session.key)}`,
      {
        headers: {
          'user-agent': 'Mozilla/5.0',
          referer: 'https://passport.bilibili.com/login'
        }
      }
    );
    const code = body.data?.code;
    if (code === 86101) {
      session.status = 'waiting';
      return { status: 'waiting' };
    }
    if (code === 86090) {
      session.status = 'scanned';
      return { status: 'scanned' };
    }
    if (code === 86038) {
      session.status = 'expired';
      return { status: 'expired' };
    }
    if (code !== 0) {
      throw new Error(body.message || 'B站登录失败');
    }
    const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    const values = {};
    for (const cookie of cookies) {
      const pair = cookie.split(';', 1)[0];
      const split = pair.indexOf('=');
      const name = pair.slice(0, split).trim();
      if (['SESSDATA', 'bili_jct', 'buvid3'].includes(name)) {
        values[name] = pair.slice(split + 1).trim();
      }
    }
    if (!values.SESSDATA || !values.bili_jct) {
      throw new Error('登录成功但没有拿到完整 Cookie，请重试');
    }
    const old = this.credentials();
    const cred = {
      sessdata: values.SESSDATA,
      bili_jct: values.bili_jct,
      buvid3: values.buvid3 || old.buvid3
    };
    writeJson(CRED_FILE, cred);
    this.wbi = null;
    const account = await this.account();
    // 主号昵称/UID 只由用户手动填写；扫码只更新登录 Cookie，不自动填充。
    session.status = 'success';
    this.qr = null;
    return { status: 'success', accountName: account.name, accountMid: account.mid };
  }

  qrCancel() {
    this.qr = null;
    return { status: 'cancelled' };
  }

  async wbiKeys() {
    if (this.wbi !== null && Date.now() - this.wbiAt < 10 * 60 * 1000) {
      return this.wbi;
    }
    const account = await this.account();
    const { body } = await requestJson(
      'https://api.bilibili.com/x/web-interface/nav',
      { headers: credentialHeaders(account.cred) }
    );
    const img = body.data?.wbi_img?.img_url || '';
    const sub = body.data?.wbi_img?.sub_url || '';
    const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
    if (raw.length < 64) {
      throw new Error('B 站 WBI 签名密钥不可用');
    }
    this.wbi = raw;
    this.wbiAt = Date.now();
    return raw;
  }

  async signed(params) {
    const raw = await this.wbiKeys();
    const mixin = MIXIN.map(index => raw[index]).join('').slice(0, 32);
    const values = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(values).sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    const rid = crypto.createHash('md5').update(query + mixin).digest('hex');
    return `${query}&w_rid=${rid}`;
  }

  async search(keyword, page = 1) {
    const account = await this.account();
    const query = await this.signed({ search_type: 'video', keyword, page });
    const { body } = await requestJson(
      `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`,
      { headers: credentialHeaders(account.cred) }
    );
    if (body.code !== 0) {
      throw new Error(`B 站搜索失败：${body.message || body.code}`);
    }
    const list = Array.isArray(body.data?.result) ? body.data.result : [];
    return list.filter(item => item && item.bvid).map(item => ({
      bvid: String(item.bvid),
      title: String(item.title || '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
      author: String(item.author || ''),
      play: Number(item.play) || 0,
      pubdate: Number(item.pubdate) || 0,
      description: String(item.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 300)
    }));
  }

  async video(bvid) {
    const account = await this.account();
    const query = await this.signed({ bvid });
    const { body } = await requestJson(
      `https://api.bilibili.com/x/web-interface/wbi/view?${query}`,
      { headers: credentialHeaders(account.cred) }
    );
    if (body.code !== 0 || !body.data) {
      throw new Error(`读取视频失败：${body.message || body.code}`);
    }
    const data = body.data;
    return {
      aid: Number(data.aid) || 0,
      cid: Number(data.cid) || 0,
      bvid: String(data.bvid || bvid),
      title: String(data.title || ''),
      desc: String(data.desc || '').slice(0, 300),
      cover: String(data.pic || ''),
      owner: String(data.owner?.name || ''),
      play: Number(data.stat?.view) || 0,
      pubdate: Number(data.pubdate) || 0
    };
  }

  /** 读官方字幕；没有字幕时返回空串，让分享退回简介。 */
  async subtitles(video) {
    if (!video.cid) {
      return '';
    }
    const query = await this.signed({ bvid: video.bvid, cid: video.cid });
    const { body } = await requestJson(
      `https://api.bilibili.com/x/player/wbi/v2?${query}`,
      { headers: credentialHeaders(this.credentials()) }
    );
    const tracks = body.data?.subtitle?.subtitles;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return '';
    }
    const preferred = tracks.find(item => String(item.lan || '').startsWith('zh')) || tracks[0];
    const url = preferred?.subtitle_url;
    if (typeof url !== 'string' || url.length === 0) {
      return '';
    }
    try {
      const target = url.startsWith('//') ? 'https:' + url : url;
      const { body: subtitle } = await requestJson(target);
      const rows = Array.isArray(subtitle.body) ? subtitle.body : [];
      return rows.map(row => String(row.content || '')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    } catch {
      return '';
    }
  }

  async comment(video, message, account) {
    const query = await this.signed({});
    const form = new URLSearchParams({
      type: '1',
      oid: String(video.aid),
      message,
      plat: '1',
      csrf: account.cred.bili_jct
    });
    const { body } = await requestJson(
      `https://api.bilibili.com/x/v2/reply/add?${query}`,
      {
        method: 'POST',
        headers: {
          ...credentialHeaders(account.cred),
          referer: `https://www.bilibili.com/video/${video.bvid}/`,
          origin: 'https://www.bilibili.com',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      }
    );
    if (body.code !== 0) {
      throw new Error(`B 站评论失败：${body.message || body.code}`);
    }
    const rpid = body.data?.rpid_str || body.data?.rpid || '';
    return {
      rpid: String(rpid),
      url: `https://www.bilibili.com/video/${video.bvid}/${rpid ? '#reply' + rpid : ''}`
    };
  }

  /** 模型不可用时的兜底：至少带人格语气 + 视频具体内容。 */
  fallbackComment(video, subtitle, profile) {
    const title = String(video.title || '这个视频').slice(0, 60);
    const content = String(subtitle || video.desc || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const call = String(profile.userTitle || '主人');
    const detail = content.length > 0 ? `里面讲到${content}` : '内容挺有意思';
    switch (profile.personality) {
      case 'tsundere':
        return `哼，${call}，《${title}》${detail}。我才不是特意替你看的，只是刚好刷到。`;
      case 'genki':
        return `${call}！《${title}》${detail}，好有意思，想和你一起看！`;
      case 'calm':
        return `${call}，《${title}》${detail}。这条值得留一下。`;
      case 'clingy':
        return `${call}，我看了《${title}》，${detail}……你会喜欢吗？`;
      default:
        return `${call}，刚看完《${title}》，${detail}，觉得你可能会感兴趣。`;
    }
  }

  pick(candidates) {
    const now = Date.now();
    return candidates
      .map(item => {
        const ageDays = Math.max(0, (now - item.pubdate * 1000) / 86400000);
        const fresh = Math.max(0, 30 - ageDays) / 30;
        const play = Math.log10(Math.max(1, item.play)) / 6;
        const text = (item.title + ' ' + item.description).toLowerCase();
        const noisy = ['带货', '广告', '擦边', '标题党'].some(word => text.includes(word));
        return { item, score: play * 0.55 + fresh * 0.35 + (noisy ? -0.5 : 0) };
      })
      .sort((a, b) => b.score - a.score)[0]?.item || null;
  }

  async run({ force = false } = {}) {
    if (this.running) {
      throw new Error('B站活动正在进行中');
    }
    const config = this.config();
    if (!config.enabled) {
      throw new Error('B站活动未开启');
    }
    if (!force && config.runsDate === todayKey() && config.runsToday >= config.dailyLimit) {
      return { skipped: true, reason: '今天已经刷够了' };
    }
    const account = await this.account();
    if (!completeCredentials(account.cred)) {
      throw new Error('还没有配置 B 站登录 Cookie');
    }
    this.running = true;
    try {
      const candidates = [];
      const seen = new Set((Array.isArray(config.history) ? config.history : [])
        .filter(item => item && Date.now() - Number(item.at || 0) < 7 * 86400000)
        .map(item => String(item.bvid || '')));
      if (config.lastShare && config.lastShare.bvid) {
        seen.add(String(config.lastShare.bvid));
      }
      for (const keyword of config.keywords) {
        await sleep(600);
        const rows = await this.search(keyword, 1 + Math.floor(Math.random() * 2));
        for (const row of rows.slice(0, 8)) {
          if (!candidates.some(item => item.bvid === row.bvid)) {
            candidates.push(row);
          }
        }
      }
      const fresh = candidates.filter(item => !seen.has(item.bvid));
      const picked = this.pick(fresh.length > 0 ? fresh : candidates);
      if (picked === null) {
        throw new Error('今天没有搜到合适的视频');
      }
      const video = await this.video(picked.bvid);
      const subtitle = await this.subtitles(video);
      const profile = this.getProfile?.() || {};
      const ownerName = config.ownerName || '';
      const title = video.title || picked.title;
      let text = '';
      if (typeof this.generateComment === 'function') {
        try {
          text = await this.generateComment(video, subtitle);
        } catch (error) {
          this.log(`bili comment generation failed: ${error.message}`);
        }
      }
      if (!text || text.trim().length === 0) {
        text = this.fallbackComment(video, subtitle, profile);
      }
      text = text.trim().slice(0, 300);
      let commentStatus = 'off';
      let commentUrl = '';
      if (config.autoComment) {
        const mention = ownerName.length > 0 ? `@${ownerName} ` : '';
        const body = text.startsWith(mention) ? text : mention + text;
        try {
          const result = await this.comment(video, body.slice(0, 1000), account);
          commentStatus = 'posted';
          commentUrl = result.url;
        } catch (error) {
          commentStatus = 'failed';
          this.log(`bili comment failed: ${error.message}`);
        }
      }
      const share = {
        id: 'b_' + crypto.randomUUID(),
        bvid: video.bvid,
        title,
        url: `https://www.bilibili.com/video/${video.bvid}/`,
        cover: video.cover,
        text,
        commentStatus,
        commentUrl,
        createdAt: Date.now()
      };
      const next = readJson(CONFIG_FILE, {});
      const today = todayKey();
      const runsToday = (next.runsDate === today ? Number(next.runsToday) || 0 : 0) + 1;
      next.lastRunDate = today;
      next.runsDate = today;
      next.runsToday = runsToday;
      next.lastShare = share;
      next.ownerName = config.ownerName || '';
      next.ownerMid = config.ownerMid || '';
      next.plannedAt = runsToday < config.dailyLimit
        ? this.nextRandomAt(config, Date.now() + 5 * 60 * 1000)
        : 0;
      const history = (Array.isArray(next.history) ? next.history : [])
        .filter(item => item && Date.now() - Number(item.at || 0) < 30 * 86400000);
      history.push({ bvid: video.bvid, at: Date.now() });
      next.history = history.slice(-100);
      writeJson(CONFIG_FILE, next);
      this.onShare?.(share);
      this.log(`bili shared ${video.bvid} comment=${commentStatus} run=${runsToday}/${config.dailyLimit}`);
      return { skipped: false, share };
    } finally {
      this.running = false;
    }
  }

  /** 在窗口内从 earliest 之后随机一个时刻；窗口已过/空间不够则返回 0。 */
  nextRandomAt(config, earliestMs) {
    const start = minuteOf(config.windowStart, 20 * 60);
    let end = minuteOf(config.windowEnd, 24 * 60);
    if (end <= start) {
      end += 24 * 60;
    }
    const now = new Date();
    const earliest = new Date(earliestMs);
    const earliestMin = earliest.getDate() === now.getDate()
      ? earliest.getHours() * 60 + earliest.getMinutes()
      : now.getHours() * 60 + now.getMinutes();
    const from = Math.max(start, earliestMin + 1);
    if (from >= end) {
      return 0;
    }
    const minute = from + Math.floor(Math.random() * Math.max(1, end - from));
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, minute).getTime();
  }

  /** 每天在窗口内随机一个时刻；每天的计划只定一次。 */
  ensurePlan(config) {
    const today = todayKey();
    if (config.plannedDate === today) {
      return config;
    }
    const start = minuteOf(config.windowStart, 20 * 60);
    let end = minuteOf(config.windowEnd, 24 * 60);
    if (end <= start) {
      end += 24 * 60;
    }
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let plannedAt = 0;
    let skippedDate = config.skippedDate || '';
    if (nowMin < end) {
      const from = Math.max(start, nowMin) + 1;
      if (from < end) {
        const minute = from + Math.floor(Math.random() * Math.max(1, end - from));
        plannedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, minute).getTime();
      }
    }
    if (plannedAt > 0 && Math.random() < config.skipChance) {
      plannedAt = 0;
      skippedDate = today;
    }
    const next = {
      ...readJson(CONFIG_FILE, {}),
      plannedDate: today,
      plannedAt,
      runsDate: today,
      runsToday: 0,
      skippedDate
    };
    writeJson(CONFIG_FILE, next);
    return { ...config, ...next };
  }

  start() {
    if (this.timer !== null) return;
    const tick = () => {
      let config = this.config();
      if (!config.enabled || !config.autoRun) return;
      config = this.ensurePlan(config);
      if (config.runsDate === todayKey() && config.runsToday >= config.dailyLimit) return;
      if (!config.plannedAt || Date.now() < config.plannedAt) return;
      if (!completeCredentials(this.credentials())) return;
      void this.run().catch(error => this.log(`bili auto run failed: ${error.message}`));
    };
    this.timer = setInterval(tick, 60 * 1000);
    this.timer.unref?.();
    const kick = setTimeout(tick, 10 * 1000);
    kick.unref?.();
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
