/* J7Tracker 中文界面 — Twitter 标签纯逻辑工具（content / background 共用） */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.J7ZhLabels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENDPOINT = 'https://loadbalance.frontrun.pro/api/v2/twitter/info/batch-query-light';
  const USERNAME_RE = /^[A-Za-z0-9_]{1,50}$/;
  const DEFAULT_EMPTY_TTL_HOURS = 24;
  const MAX_EMPTY_TTL_HOURS = 8760;

  function normalizeUsername(value) {
    let text = String(value == null ? '' : value).trim();
    if (!text) return '';
    const urlMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
    if (urlMatch) text = urlMatch[1];
    text = text.replace(/^@+/, '').trim();
    return USERNAME_RE.test(text) ? text : '';
  }

  function inputRows(input) {
    if (Array.isArray(input)) return input;
    if (!input || typeof input !== 'object') return [];
    if (Array.isArray(input.data)) return input.data;
    if (Array.isArray(input.rows)) return input.rows;
    if (Array.isArray(input.labels)) return input.labels;
    return [];
  }

  function normalizeRows(input) {
    const byName = new Map();
    for (const item of inputRows(input)) {
      const rawName = typeof item === 'string' ? item : item && (item.twitterUsername || item.username || item.screenName || item.handle);
      const twitterUsername = normalizeUsername(rawName);
      if (!twitterUsername) continue;
      const rawPosition = typeof item === 'object' && item && typeof item.position === 'string' ? item.position.trim() : '';
      const legacyOverride = !!(typeof item === 'object' && item && item.localOverride === true);
      const declaredSource = typeof item === 'object' && item && String(item.source || '').toUpperCase() === 'USER' ? 'USER' : 'FRONTRUN';
      const source = legacyOverride ? 'USER' : declaredSource;
      const position = legacyOverride && typeof item.localLabel === 'string' ? item.localLabel.trim() : rawPosition;
      const key = twitterUsername.toLowerCase();
      if (byName.has(key)) byName.delete(key);
      const row = { twitterUsername, position, source };
      const checkedAt = typeof item === 'object' && item ? Number(item.frontrunCheckedAt) : NaN;
      if (Number.isFinite(checkedAt) && checkedAt > 0) row.frontrunCheckedAt = Math.floor(checkedAt);
      if (source === 'USER') {
        const provider = legacyOverride ? rawPosition : (typeof item.frontrunPosition === 'string' ? item.frontrunPosition.trim() : '');
        if (provider) row.frontrunPosition = provider;
        if (item.hidden === true || !position) row.hidden = true;
      }
      byName.set(key, row);
    }
    return [...byName.values()];
  }

  function rowsToMap(input) {
    return new Map(normalizeRows(input).map((row) => [row.twitterUsername.toLowerCase(), row]));
  }

  function mapToRows(map) {
    return [...map.values()].map((row) => {
      const source = row.source === 'USER' ? 'USER' : 'FRONTRUN';
      const out = { twitterUsername: row.twitterUsername, position: row.position || '', source };
      const checkedAt = Number(row.frontrunCheckedAt);
      if (Number.isFinite(checkedAt) && checkedAt > 0) out.frontrunCheckedAt = Math.floor(checkedAt);
      if (source === 'USER') {
        if (row.frontrunPosition) out.frontrunPosition = row.frontrunPosition;
        if (row.hidden === true || !row.position) out.hidden = true;
      }
      return out;
    });
  }

  function effectiveLabel(row) {
    if (!row) return '';
    return row.hidden === true ? '' : String(row.position || '').trim();
  }

  function normalizeEmptyTtlHours(value) {
    if (value == null || String(value).trim() === '') return DEFAULT_EMPTY_TTL_HOURS;
    const hours = Number(value);
    if (!Number.isFinite(hours)) return DEFAULT_EMPTY_TTL_HOURS;
    return Math.min(MAX_EMPTY_TTL_HOURS, Math.max(1, Math.round(hours)));
  }

  function shouldRefreshEmpty(row, ttlHours, now) {
    if (!row) return true;
    if (row.source === 'USER' || effectiveLabel(row)) return false;
    const checkedAt = Number(row.frontrunCheckedAt);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return current - checkedAt >= normalizeEmptyTtlHours(ttlHours) * 60 * 60 * 1000;
  }

  function chunk(values, size) {
    const out = [];
    const n = Math.max(1, Number(size) || 1);
    for (let i = 0; i < values.length; i += n) out.push(values.slice(i, i + n));
    return out;
  }

  function decodePastedText(value) {
    return String(value || '')
      .replace(/&#x20;|&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\\_/g, '_');
  }

  function optionValue(command, optionPattern) {
    const re = new RegExp('(?:^|\\s)(?:' + optionPattern + ')\\s+(?:\"([^\"]*)\"|\'([^\']*)\'|([^\\s\\\\]+))', 'i');
    const match = command.match(re);
    return match ? (match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] || '') : '';
  }

  function parseCookieHeader(header) {
    const cookies = [];
    const seen = new Set();
    for (const part of String(header || '').split(';')) {
      const at = part.indexOf('=');
      if (at <= 0) continue;
      const name = part.slice(0, at).trim().replace(/\\_/g, '_');
      const value = part.slice(at + 1).trim();
      if (!name || !value || seen.has(name)) continue;
      seen.add(name);
      cookies.push({ name, value });
    }
    return cookies;
  }

  function parseCurlCommand(rawCommand) {
    const command = decodePastedText(rawCommand).replace(/\\\r?\n/g, ' ');
    if (!command.trim()) throw new Error('请粘贴完整 curl 命令');
    if (!command.includes('loadbalance.frontrun.pro/api/v2/twitter/info/batch-query-light')) {
      throw new Error('curl 地址不是 Frontrun batch-query-light 接口');
    }
    const cookieHeader = optionValue(command, '-b|--cookie');
    if (!cookieHeader) throw new Error('curl 命令里没有 Cookie（-b / --cookie）');
    const cookies = parseCookieHeader(cookieHeader);
    if (!cookies.some((cookie) => cookie.name === '__Secure-frontrun.session_token')) {
      throw new Error('Cookie 中缺少 Frontrun session_token');
    }

    const headers = {};
    const headerRe = /(?:^|\s)(?:-H|--header)\s+(?:\"([^\"]*)\"|'([^']*)'|([^\r\n\\]+))/gi;
    let match;
    while ((match = headerRe.exec(command))) {
      const line = String(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] || '').trim();
      const at = line.indexOf(':');
      if (at <= 0) continue;
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      if (['accept-language', 'x-copilot-client-language', 'x-copilot-client-version'].includes(name) && value) headers[name] = value;
    }

    return { endpoint: ENDPOINT, cookieHeader, cookies, headers };
  }

  function usernameFromHref(href) {
    const match = String(href || '').match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/?(?:[?#].*)?$/i);
    return match ? normalizeUsername(match[1]) : '';
  }

  return {
    ENDPOINT,
    DEFAULT_EMPTY_TTL_HOURS,
    normalizeUsername,
    normalizeRows,
    rowsToMap,
    mapToRows,
    effectiveLabel,
    normalizeEmptyTtlHours,
    shouldRefreshEmpty,
    chunk,
    parseCookieHeader,
    parseCurlCommand,
    usernameFromHref
  };
});
