/* J7Tracker 中文界面 — 后台 service worker
 * 代 content script 调 Google 翻译（免 CORS / 免 key）。
 *  - 批量：clients5 多 q 接口一次翻多条；失败再逐条走 gtx
 *  - 串行 + 最小间隔，429 时整体退避，避免把出口 IP 打进风控
 *  - 小缓存
 */
importScripts('label-utils.js');

const cache = new Map();
const CACHE_MAX = 4000;
function remember(key, val) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, val); }

let chain = Promise.resolve();      // 串行队列
let lastAt = 0;                     // 上一次请求时间
let pauseUntil = 0;                 // 退避截止
let backoff = 0;                    // 当前退避级别
const MIN_GAP = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bump() { backoff = Math.min(backoff + 1, 6); pauseUntil = Date.now() + [0, 5, 15, 30, 60, 120, 300][backoff] * 1000; }
function calm() { backoff = 0; pauseUntil = 0; }

async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }));
    if (r.status === 429 || r.status === 403) { const e = new Error('rate-limited ' + r.status); e.rateLimited = true; throw e; }
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 多条：clients5，返回 [["译","en"],...] 或 ["译",...]
async function batchClients5(texts, tl) {
  const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' + encodeURIComponent(tl) + '&' + texts.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  if (url.length > 7600) throw new Error('too long');
  const j = await fetchJson(url, { method: 'GET' });
  if (!Array.isArray(j)) throw new Error('bad');
  // 只有一条时可能直接返回 ["译","en"]
  let arr = j;
  if (texts.length === 1 && typeof j[0] === 'string') arr = [j];
  if (arr.length !== texts.length) throw new Error('count mismatch');
  return arr.map((it) => (Array.isArray(it) ? String(it[0] || '') : String(it || '')));
}

// 单条：gtx
async function singleGtx(text, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) + '&dt=t';
  const j = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'q=' + encodeURIComponent(text) });
  const out = (j && j[0] ? j[0] : []).map((s) => (s && s[0]) || '').join('');
  if (!out) throw new Error('empty');
  return out;
}

async function throttle() {
  const now = Date.now();
  if (pauseUntil > now) await sleep(pauseUntil - now);
  const gap = Date.now() - lastAt;
  if (gap < MIN_GAP) await sleep(MIN_GAP - gap);
  lastAt = Date.now();
}

// 翻译一批，返回 {results: [{text|null}], paused: ms}
async function translateBatch(texts, tl) {
  const results = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => { const k = tl + '|' + t; if (cache.has(k)) results[i] = cache.get(k); else todo.push(i); });
  if (!todo.length) return { results };

  // 分成 URL 长度可控的小批
  const groups = []; let cur = []; let curLen = 0;
  for (const i of todo) {
    const len = encodeURIComponent(texts[i]).length + 3;
    if (cur.length && (curLen + len > 6000 || cur.length >= 10)) { groups.push(cur); cur = []; curLen = 0; }
    cur.push(i); curLen += len;
  }
  if (cur.length) groups.push(cur);

  for (const g of groups) {
    await throttle();
    let ok = false;
    try {
      const outs = await batchClients5(g.map((i) => texts[i]), tl);
      g.forEach((i, n) => { if (outs[n]) { results[i] = outs[n]; remember(tl + '|' + texts[i], outs[n]); } });
      ok = true; calm();
    } catch (e) {
      if (e && e.rateLimited) { bump(); return { results, paused: pauseUntil - Date.now() }; }
    }
    if (!ok) {
      // 逐条兜底
      for (const i of g) {
        await throttle();
        try { const out = await singleGtx(texts[i], tl); results[i] = out; remember(tl + '|' + texts[i], out); calm(); }
        catch (e) { if (e && e.rateLimited) { bump(); return { results, paused: pauseUntil - Date.now() }; } }
      }
    }
  }
  return { results };
}

/* =====================================================================
 * Twitter position 标签
 * - chrome.storage.local 保存标签和 Frontrun 配置
 * - chrome.cookies 把用户粘贴的 curl Cookie 写到目标域，再由后台 fetch
 * - 所有请求串行、每批最多 20 个、随机间隔并在 429/5xx 时退避
 * ===================================================================== */
const LABEL = self.J7ZhLabels;
const LABEL_DATA_KEY = 'j7zh_twitter_labels_v1';
const LABEL_CONFIG_KEY = 'j7zh_frontrun_config_v1';
const LABEL_AUTO_KEY = 'j7zh_label_auto_update_v1';
const LABEL_EMPTY_TTL_KEY = 'j7zh_label_empty_ttl_hours_v1';
const LABEL_AUTO_STATS_KEY = 'j7zh_label_auto_stats_v1';
const LABEL_SEED_FILE = 'twitter-labels.seed.json';
const LABEL_BATCH_SIZE = 20;
const LABEL_AUTO_ERROR_COOLDOWN_MS = 5 * 60 * 1000;

let labelRowsPromise = null;
let labelMap = new Map();
let labelRequestChain = Promise.resolve();
let labelConfigMutationChain = Promise.resolve();
let labelAutoStatsMutationChain = Promise.resolve();
let labelConfigRevision = 0;
let labelAutoRevision = 0;
const labelFetchControllers = new Map();
let labelLastRequestAt = 0;
let labelRate = null;
let labelJob = { busy: false, phase: 'idle', current: 0, total: 0, updated: 0, error: '' };

async function storageGet(keys) { return chrome.storage.local.get(keys); }
async function storageSet(values) { return chrome.storage.local.set(values); }
async function storageRemove(keys) { return chrome.storage.local.remove(keys); }

async function loadSeedRows() {
  const response = await fetch(chrome.runtime.getURL(LABEL_SEED_FILE));
  if (!response.ok) throw new Error('读取内置标签失败：' + response.status);
  return LABEL.normalizeRows(await response.json());
}

async function ensureLabelRows() {
  if (!labelRowsPromise) {
    labelRowsPromise = (async () => {
      const stored = await storageGet(LABEL_DATA_KEY);
      const hasStored = Object.prototype.hasOwnProperty.call(stored, LABEL_DATA_KEY);
      const record = stored[LABEL_DATA_KEY];
      const rows = hasStored ? LABEL.normalizeRows(record && record.rows ? record.rows : record) : await loadSeedRows();
      labelMap = LABEL.rowsToMap(rows);
      if (!hasStored) await persistLabelRows();
      return LABEL.mapToRows(labelMap);
    })().catch((error) => { labelRowsPromise = null; throw error; });
  }
  await labelRowsPromise;
  return LABEL.mapToRows(labelMap);
}

async function persistLabelRows() {
  const rows = LABEL.mapToRows(labelMap);
  await storageSet({ [LABEL_DATA_KEY]: { version: 2, updatedAt: new Date().toISOString(), rows } });
  return rows;
}

function mergeProviderLabel(row) {
  const key = row.twitterUsername.toLowerCase();
  const existing = labelMap.get(key);
  row.source = 'FRONTRUN';
  if (row.position) delete row.frontrunCheckedAt;
  else row.frontrunCheckedAt = Date.now();
  if (existing && existing.source === 'USER') {
    existing.frontrunPosition = row.position || '';
    if (row.frontrunCheckedAt) existing.frontrunCheckedAt = row.frontrunCheckedAt;
    else delete existing.frontrunCheckedAt;
    labelMap.set(key, existing);
    return existing;
  }
  labelMap.set(key, row);
  return row;
}

async function getPrivateLabelConfig() {
  const stored = await storageGet(LABEL_CONFIG_KEY);
  const config = stored[LABEL_CONFIG_KEY];
  return config && config.endpoint === LABEL.ENDPOINT && Array.isArray(config.cookies) ? config : null;
}

async function applyFrontrunCookies(config) {
  let sessionSaved = false;
  for (const cookie of config.cookies) {
    const saved = await chrome.cookies.set({
      url: 'https://loadbalance.frontrun.pro/',
      name: cookie.name,
      value: cookie.value,
      secure: true,
      sameSite: 'no_restriction',
      path: '/'
    });
    if (cookie.name === '__Secure-frontrun.session_token' && saved) sessionSaved = true;
  }
  if (!sessionSaved) throw new Error('session_token 无法写入 Frontrun 域');
}

async function removeFrontrunCookies(config, keepNames) {
  let removed = 0;
  const failed = [];
  const cookies = config && Array.isArray(config.cookies) ? config.cookies : [];
  for (const cookie of cookies) {
    if (keepNames && keepNames.has(cookie.name)) continue;
    try {
      const result = await chrome.cookies.remove({ url: 'https://loadbalance.frontrun.pro/', name: cookie.name });
      if (result) removed++;
    } catch (error) {
      failed.push(cookie.name);
    }
  }
  if (failed.length) throw new Error('以下 Frontrun Cookie 清除失败，请重试：' + failed.join(', '));
  return removed;
}

function cancelledLabelRequest(message) {
  const error = new Error(message || '标签请求已取消');
  error.cancelled = true;
  return error;
}

function abortLabelFetches(autoOnly) {
  for (const [controller, meta] of labelFetchControllers) {
    if (!autoOnly || meta.auto) controller.abort();
  }
}

function invalidateConfigRequests() {
  labelConfigRevision++;
  abortLabelFetches(false);
}

function invalidateAutoRequests() {
  labelAutoRevision++;
  abortLabelFetches(true);
}

function requestContext(auto) {
  return { configRevision: labelConfigRevision, autoRevision: labelAutoRevision, auto: auto === true };
}

function assertRequestCurrent(context) {
  if (!context || context.configRevision !== labelConfigRevision) throw cancelledLabelRequest('Cookie 配置已变更，请求已取消');
  if (context.auto && context.autoRevision !== labelAutoRevision) throw cancelledLabelRequest('自动更新已关闭，请求已取消');
}

function enqueueConfigMutation(task) {
  const next = labelConfigMutationChain.then(task, task);
  labelConfigMutationChain = next.catch(() => null);
  return next;
}

async function loadAndApplyFrontrunConfig(context) {
  // 与保存/清除共用同一条串行链：浏览器重启后可恢复会话 Cookie，
  // 同时保证“清除”完成后旧请求绝不会再次把 Cookie 写回来。
  return enqueueConfigMutation(async () => {
    assertRequestCurrent(context);
    const config = await getPrivateLabelConfig();
    if (!config) throw new Error('请先保存包含 Cookie 的完整 curl 命令');
    assertRequestCurrent(context);
    await applyFrontrunCookies(config);
    assertRequestCurrent(context);
    return config;
  });
}

async function saveFrontrunConfig(command) {
  const parsed = LABEL.parseCurlCommand(command);
  invalidateConfigRequests();
  const previous = await getPrivateLabelConfig();
  const config = {
    version: 1,
    endpoint: parsed.endpoint,
    cookies: parsed.cookies,
    headers: parsed.headers,
    savedAt: new Date().toISOString()
  };
  const newNames = new Set(config.cookies.map((cookie) => cookie.name));
  const previousNames = new Set(previous && previous.cookies.map((cookie) => cookie.name) || []);
  // 先清旧配置中已废弃的名称；失败时尚未写入任何新 Cookie，不会产生孤儿凭据。
  if (previous) await removeFrontrunCookies(previous, newNames);
  try {
    await applyFrontrunCookies(config);
    await storageSet({ [LABEL_CONFIG_KEY]: config });
  } catch (error) {
    // 写新 Cookie 或落配置失败时尽力恢复旧状态，并清掉只属于新配置的名称。
    try {
      if (previous) await applyFrontrunCookies(previous);
      await removeFrontrunCookies(config, previousNames);
    } catch (rollbackError) {
      error.message += '；Cookie 回滚未完全成功：' + String(rollbackError && rollbackError.message || rollbackError);
    }
    throw error;
  }
  // 配置已经提交；非关键的状态提示清理失败不应把成功操作伪装成失败。
  try { await updateAutoStats({ pauseUntil: 0, lastError: '' }); } catch (error) {}
  if (!labelJob.busy) labelJob = { busy: false, phase: 'idle', current: 0, total: 0, updated: 0, error: '' };
  return { savedAt: config.savedAt, cookieCount: config.cookies.length, replaced: !!previous };
}

async function clearFrontrunConfig() {
  invalidateConfigRequests();
  const previous = await getPrivateLabelConfig();
  const removedCookies = previous ? await removeFrontrunCookies(previous) : 0;
  await storageRemove(LABEL_CONFIG_KEY);
  // Cookie 与配置已清除，统计提示仅尽力同步。
  try { await updateAutoStats({ pauseUntil: 0, lastError: '' }); } catch (error) {}
  if (!labelJob.busy) labelJob = { busy: false, phase: 'idle', current: 0, total: 0, updated: 0, error: '' };
  return { cleared: !!previous, removedCookies };
}

function normalizeAutoStats(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    updatedCount: Math.max(0, Math.floor(Number(input.updatedCount) || 0)),
    pauseUntil: Math.max(0, Math.floor(Number(input.pauseUntil) || 0)),
    lastError: String(input.lastError || '').slice(0, 240),
    updatedAt: String(input.updatedAt || '')
  };
}

async function updateAutoStats(patch) {
  const task = async () => {
    const stored = await storageGet(LABEL_AUTO_STATS_KEY);
    const stats = Object.assign(normalizeAutoStats(stored[LABEL_AUTO_STATS_KEY]), patch || {}, { updatedAt: new Date().toISOString() });
    await storageSet({ [LABEL_AUTO_STATS_KEY]: stats });
    return stats;
  };
  const next = labelAutoStatsMutationChain.then(task, task);
  labelAutoStatsMutationChain = next.catch(() => null);
  return next;
}

async function incrementAutoUpdatedCount(count) {
  const amount = Math.max(0, Math.floor(Number(count) || 0));
  const task = async () => {
    const stored = await storageGet(LABEL_AUTO_STATS_KEY);
    const current = normalizeAutoStats(stored[LABEL_AUTO_STATS_KEY]);
    const stats = Object.assign(current, {
      updatedCount: current.updatedCount + amount,
      pauseUntil: 0,
      lastError: '',
      updatedAt: new Date().toISOString()
    });
    await storageSet({ [LABEL_AUTO_STATS_KEY]: stats });
    return stats;
  };
  const next = labelAutoStatsMutationChain.then(task, task);
  labelAutoStatsMutationChain = next.catch(() => null);
  return next;
}

async function publicLabelState() {
  const rows = await ensureLabelRows();
  const stored = await storageGet([LABEL_CONFIG_KEY, LABEL_AUTO_KEY, LABEL_EMPTY_TTL_KEY, LABEL_AUTO_STATS_KEY]);
  const autoStats = normalizeAutoStats(stored[LABEL_AUTO_STATS_KEY]);
  return {
    count: rows.length,
    nonEmpty: rows.filter((row) => LABEL.effectiveLabel(row)).length,
    localCount: rows.filter((row) => row.source === 'USER').length,
    configSaved: !!stored[LABEL_CONFIG_KEY],
    configSavedAt: stored[LABEL_CONFIG_KEY] && stored[LABEL_CONFIG_KEY].savedAt || '',
    autoUpdate: stored[LABEL_AUTO_KEY] === true,
    emptyTtlHours: LABEL.normalizeEmptyTtlHours(stored[LABEL_EMPTY_TTL_KEY]),
    autoUpdatedCount: autoStats.updatedCount,
    autoPauseUntil: autoStats.pauseUntil,
    autoLastError: autoStats.lastError,
    job: Object.assign({}, labelJob),
    rate: labelRate
  };
}

async function broadcastLabelMessage(message) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://j7tracker.io/*', 'https://*.j7tracker.io/*'] });
    await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => null)));
  } catch (e) {}
}

function parseRateHeaders(response) {
  const number = (name) => {
    const value = Number(response.headers.get(name));
    return Number.isFinite(value) ? value : null;
  };
  return {
    minuteRemaining: number('x-ratelimit-remaining-minute'),
    hourRemaining: number('x-ratelimit-remaining-hour'),
    dayRemaining: number('x-ratelimit-remaining-day')
  };
}

async function waitForLabelGap(extraMs) {
  const randomGap = 2500 + Math.floor(Math.random() * 2001) + (extraMs || 0);
  const wait = labelLastRequestAt ? Math.max(0, labelLastRequestAt + randomGap - Date.now()) : 0;
  if (wait) await sleep(wait);
  labelLastRequestAt = Date.now();
}

async function fetchFrontrunBatch(usernames, context) {
  if (!usernames.length || usernames.length > LABEL_BATCH_SIZE) throw new Error('Frontrun 批次必须是 1-20 个 username');
  assertRequestCurrent(context);
  const config = await loadAndApplyFrontrunConfig(context);

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitForLabelGap(attempt ? Math.min(8000, 1000 * (2 ** attempt)) : 0);
    assertRequestCurrent(context);
    let response;
    const controller = new AbortController();
    labelFetchControllers.set(controller, { auto: context.auto });
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: Object.assign({
          accept: '*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'content-type': 'application/json',
          'x-copilot-client-language': 'ZH_CN',
          'x-copilot-client-version': '0.0.382'
        }, config.headers || {}),
        body: JSON.stringify({ twitterUsernames: usernames })
      });
    } catch (error) {
      if (controller.signal.aborted || (error && error.name === 'AbortError')) throw cancelledLabelRequest();
      lastError = error;
      if (attempt < 3) continue;
      throw error;
    } finally {
      labelFetchControllers.delete(controller);
    }

    assertRequestCurrent(context);
    labelRate = parseRateHeaders(response);
    const text = await response.text();
    if (response.ok) {
      let payload;
      try { payload = JSON.parse(text); } catch (e) { throw new Error('Frontrun 返回了无效 JSON'); }
      if (!payload || payload.status !== true || !Array.isArray(payload.data)) throw new Error('Frontrun 返回结构异常');
      return LABEL.normalizeRows(payload.data);
    }

    if (response.status === 401 || response.status === 403) {
      const error = new Error('Frontrun Cookie 已失效或无权限（' + response.status + '）');
      error.status = response.status;
      throw error;
    }
    if (response.status === 429) {
      const reset = Math.max(5, Math.min(90, Number(response.headers.get('x-ratelimit-reset-minute')) || 60));
      lastError = new Error('Frontrun 请求过于频繁，等待 ' + reset + ' 秒');
      if (attempt < 3) { await sleep((reset + 1) * 1000); continue; }
    } else if (response.status >= 500) {
      lastError = new Error('Frontrun 服务器错误（' + response.status + '）');
      lastError.status = response.status;
      if (attempt < 2) continue;
      throw lastError;
    } else {
      const error = new Error('Frontrun 请求失败（' + response.status + '）：' + text.slice(0, 160));
      error.status = response.status;
      throw error;
    }
  }
  throw lastError || new Error('Frontrun 请求失败');
}

function enqueueLabelTask(task) {
  const next = labelRequestChain.then(task, task);
  labelRequestChain = next.catch(() => null);
  return next;
}

async function queryAndMergeLabels(usernames, options) {
  await ensureLabelRows();
  const seen = new Set();
  let names = usernames.map(LABEL.normalizeUsername).filter((name) => {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return false;
    seen.add(key);
    if (!(options && options.missingOnly)) return true;
    return LABEL.shouldRefreshEmpty(labelMap.get(key), options.emptyTtlHours);
  });
  if (!names.length) return [];

  const batches = LABEL.chunk(names, LABEL_BATCH_SIZE);
  const changed = [];
  let done = 0;
  for (const batch of batches) {
    assertRequestCurrent(options && options.context);
    if (options && options.countAuto) {
      const stored = await storageGet([LABEL_AUTO_KEY, LABEL_AUTO_STATS_KEY]);
      assertRequestCurrent(options.context);
      if (stored[LABEL_AUTO_KEY] !== true) throw cancelledLabelRequest('自动更新已关闭，请求已取消');
      const stats = normalizeAutoStats(stored[LABEL_AUTO_STATS_KEY]);
      if (stats.pauseUntil > Date.now()) throw cancelledLabelRequest('自动补查正在冷却');
    }
    const rows = await fetchFrontrunBatch(batch, options && options.context);
    // Cookie/自动开关可能在响应返回与落盘之间改变；旧响应绝不能覆盖本地 JSON 或页面。
    assertRequestCurrent(options && options.context);
    const batchChanged = [];
    const returned = new Set(rows.map((row) => row.twitterUsername.toLowerCase()));
    for (const row of rows) {
      const merged = mergeProviderLabel(row);
      changed.push(merged);
      batchChanged.push(merged);
    }
    // 自动补全时，把接口明确未返回的 username 记成空记录，避免页面轮询反复请求。
    // 全量刷新则保留原值，防止接口偶发漏项把已有备注清空。
    if (options && options.missingOnly) {
      for (const username of batch) {
        const key = username.toLowerCase();
        if (returned.has(key)) continue;
        const emptyRow = { twitterUsername: username, position: '' };
        const merged = mergeProviderLabel(emptyRow);
        changed.push(merged);
        batchChanged.push(merged);
      }
    }
    done += batch.length;
    // 先把标准化 JSON 安全写入 storage，再更新计数并通知页面。
    await persistLabelRows();
    if (options && options.countAuto) await incrementAutoUpdatedCount(batch.length);
    if (batchChanged.length) {
      await broadcastLabelMessage({ type: 'j7zh-labels-changed', rows: batchChanged, state: await publicLabelState() });
    }
    if (options && options.phase) {
      labelJob.current = Math.min(labelJob.total, (options.base || 0) + done);
      labelJob.updated += rows.length;
      await broadcastLabelMessage({ type: 'j7zh-label-progress', state: await publicLabelState() });
    }
  }
  return changed;
}

async function importLabelRows(input) {
  await ensureLabelRows();
  const rows = LABEL.normalizeRows(input);
  if (!rows.length) throw new Error('导入文件里没有有效的 twitterUsername/position');
  const changed = [];
  for (const row of rows) {
    const key = row.twitterUsername.toLowerCase();
    const existing = labelMap.get(key);
    if (row.source !== 'USER' && existing && existing.source === 'USER') {
      existing.frontrunPosition = row.position || '';
      labelMap.set(key, existing);
      changed.push(existing);
      continue;
    }
    labelMap.set(key, row);
    changed.push(row);
  }
  await persistLabelRows();
  await broadcastLabelMessage({ type: 'j7zh-labels-changed', rows: changed, state: await publicLabelState() });
  return { imported: rows.length, state: await publicLabelState() };
}

async function updateLocalLabel(username, action, value) {
  await ensureLabelRows();
  const twitterUsername = LABEL.normalizeUsername(username);
  if (!twitterUsername) throw new Error('请输入有效的 Twitter username');
  const key = twitterUsername.toLowerCase();
  const row = labelMap.get(key) || { twitterUsername, position: '', source: 'FRONTRUN' };
  if (action === 'restore') {
    row.position = row.source === 'USER' ? (row.frontrunPosition || '') : row.position;
    row.source = 'FRONTRUN';
    delete row.frontrunPosition;
    delete row.hidden;
  } else if (action === 'delete') {
    if (row.source !== 'USER' && row.position) row.frontrunPosition = row.position;
    row.position = '';
    row.source = 'USER';
    row.hidden = true;
  } else if (action === 'save') {
    const localLabel = String(value || '').trim();
    if (!localLabel) throw new Error('备注不能为空；要隐藏备注请使用删除');
    if (localLabel.length > 100) throw new Error('备注最多 100 个字符');
    if (row.source !== 'USER' && row.position) row.frontrunPosition = row.position;
    row.position = localLabel;
    row.source = 'USER';
    delete row.hidden;
  } else {
    throw new Error('未知的备注操作');
  }
  labelMap.set(key, row);
  await persistLabelRows();
  const resultRow = LABEL.mapToRows(new Map([[key, row]]))[0];
  const state = await publicLabelState();
  await broadcastLabelMessage({ type: 'j7zh-labels-changed', rows: [resultRow], state });
  return { row: resultRow, state };
}

async function queryMissingLabels(usernames) {
  const stored = await storageGet([LABEL_AUTO_KEY, LABEL_CONFIG_KEY, LABEL_EMPTY_TTL_KEY, LABEL_AUTO_STATS_KEY]);
  if (stored[LABEL_AUTO_KEY] !== true) return { skipped: 'disabled', rows: [] };
  if (!stored[LABEL_CONFIG_KEY]) return { skipped: 'no-config', rows: [] };
  const autoStats = normalizeAutoStats(stored[LABEL_AUTO_STATS_KEY]);
  if (autoStats.pauseUntil > Date.now()) {
    return {
      skipped: 'cooldown',
      warning: autoStats.lastError || 'Frontrun 暂时不可用，自动补查正在冷却',
      rows: [],
      state: await publicLabelState()
    };
  }
  const emptyTtlHours = LABEL.normalizeEmptyTtlHours(stored[LABEL_EMPTY_TTL_KEY]);
  const context = requestContext(true);
  const result = await enqueueLabelTask(async () => {
    // 任务可能排队数秒；真正开始时再次检查开关和 500 冷却，避免旧任务穿透。
    const current = await storageGet([LABEL_AUTO_KEY, LABEL_CONFIG_KEY, LABEL_AUTO_STATS_KEY]);
    try { assertRequestCurrent(context); } catch (error) { return { skipped: 'cancelled', rows: [] }; }
    if (current[LABEL_AUTO_KEY] !== true) return { skipped: 'disabled', rows: [] };
    if (!current[LABEL_CONFIG_KEY]) return { skipped: 'no-config', rows: [] };
    const currentStats = normalizeAutoStats(current[LABEL_AUTO_STATS_KEY]);
    if (currentStats.pauseUntil > Date.now()) {
      return { skipped: 'cooldown', warning: currentStats.lastError || 'Frontrun 暂时不可用，自动补查正在冷却', rows: [] };
    }
    try {
      return { rows: await queryAndMergeLabels(usernames, { missingOnly: true, emptyTtlHours, countAuto: true, context }) };
    } catch (error) {
      if (error && error.cancelled) return { skipped: 'cancelled', rows: [] };
      if (Number(error && error.status) >= 500) {
        const warning = String(error.message || error) + '，自动补查暂停 5 分钟后再试';
        await updateAutoStats({ pauseUntil: Date.now() + LABEL_AUTO_ERROR_COOLDOWN_MS, lastError: warning });
        return { skipped: 'server-error', warning, rows: [] };
      }
      throw error;
    }
  });
  return Object.assign(result, { state: await publicLabelState() });
}

async function startFullLabelUpdate() {
  if (labelJob.busy) return { started: false, state: await publicLabelState() };
  if (!(await getPrivateLabelConfig())) throw new Error('请先保存包含 Cookie 的完整 curl 命令');
  const rows = await ensureLabelRows();
  const usernames = rows.map((row) => row.twitterUsername);
  labelJob = { busy: true, phase: 'all', current: 0, total: usernames.length, updated: 0, error: '' };
  await broadcastLabelMessage({ type: 'j7zh-label-progress', state: await publicLabelState() });
  const context = requestContext(false);
  enqueueLabelTask(() => queryAndMergeLabels(usernames, { phase: 'all', missingOnly: false, context }))
    .then(() => { labelJob.busy = false; labelJob.phase = 'done'; labelJob.current = labelJob.total; })
    .catch((error) => {
      labelJob.busy = false;
      labelJob.phase = error && error.cancelled ? 'cancelled' : 'error';
      labelJob.error = error && error.cancelled ? '' : String(error && error.message || error);
    })
    .finally(async () => { await broadcastLabelMessage({ type: 'j7zh-label-progress', state: await publicLabelState() }); });
  return { started: true, state: await publicLabelState() };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('j7zh-label')) return false;
  (async () => {
    switch (msg.type) {
      case 'j7zh-labels-get':
        return { rows: await ensureLabelRows(), state: await publicLabelState() };
      case 'j7zh-labels-export':
        return { rows: await ensureLabelRows(), state: await publicLabelState() };
      case 'j7zh-labels-import':
        return importLabelRows(msg.data);
      case 'j7zh-label-local-set':
        return updateLocalLabel(msg.username, msg.action, msg.value);
      case 'j7zh-label-config-save':
        return { config: await enqueueConfigMutation(() => saveFrontrunConfig(String(msg.command || ''))), state: await publicLabelState() };
      case 'j7zh-label-config-clear':
        return { config: await enqueueConfigMutation(clearFrontrunConfig), state: await publicLabelState() };
      case 'j7zh-label-auto-set':
        invalidateAutoRequests();
        await storageSet({ [LABEL_AUTO_KEY]: msg.enabled === true });
        return { state: await publicLabelState() };
      case 'j7zh-label-ttl-set':
        await storageSet({ [LABEL_EMPTY_TTL_KEY]: LABEL.normalizeEmptyTtlHours(msg.hours) });
        return { state: await publicLabelState() };
      case 'j7zh-label-query-missing':
        return queryMissingLabels(Array.isArray(msg.usernames) ? msg.usernames : []);
      case 'j7zh-label-update-all':
        return startFullLabelUpdate();
      default:
        throw new Error('未知标签操作');
    }
  })().then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
});

/* ---- GMGN 后台搜索：不抢焦点地打开/复用 gmgn.ai 标签页 ---- */
async function gmgnSearch(q, sender) {
  const url = 'https://gmgn.ai/?chain=sol#j7q=' + encodeURIComponent(q);
  const tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://*.gmgn.ai/*'] });
  // 优先复用与 j7 同窗口的 GMGN 标签页（比如用户开着分屏）
  const senderWin = sender && sender.tab && sender.tab.windowId;
  const existing = tabs.find((t) => t.windowId === senderWin) || tabs[0];
  if (existing) {
    // 常规路径：直接给页面里的 bridge 发消息，原地搜索，零导航零刷新
    try {
      await chrome.tabs.sendMessage(existing.id, { type: 'j7zh-gmgn-q', q });
      return { reused: true };
    } catch (e) {
      // 页面还没注入 bridge（扩展刚重载 / 标签页还在加载）→ 退回带 hash 的导航
      await chrome.tabs.update(existing.id, { url, active: false });
      return { reused: true };
    }
  }
  const createProps = { url, active: false };
  if (sender && sender.tab) { createProps.windowId = sender.tab.windowId; createProps.index = sender.tab.index + 1; }
  await chrome.tabs.create(createProps);
  return { reused: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'j7zh-gmgn-search') {
    gmgnSearch(String(msg.q || '').slice(0, 80), sender)
      .then((r) => sendResponse({ ok: true, reused: r.reused }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (!msg || msg.type !== 'j7zh-translate-batch') return false;
  const tl = msg.tl || 'zh-CN';
  const texts = (Array.isArray(msg.texts) ? msg.texts : []).map((t) => String(t || '').slice(0, 4000));
  chain = chain.then(() => translateBatch(texts, tl))
    .then((r) => sendResponse({ ok: true, results: r.results, paused: r.paused || 0 }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 异步响应
});
