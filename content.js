/* J7Tracker 中文界面 — content script
 * 功能都可在右下角「中」菜单里独立配置：
 *   1. 界面汉化：遍历文本节点 + placeholder/title/aria-label，按字典替换；MutationObserver 跟 SPA 动态渲染
 *   2. 阅读模式：一段 CSS（html.j7zh-reader），卡片收窄居中、图片缩小、行距放宽
 *   3. 正文翻译：把推文/引用/回复的文字发给 Google 翻译（经 background.js），译文附在原文下方
 *   4. 作者标签：按 Twitter username 在推文头部展示本地 position，并可从 Frontrun 更新
 * 推文正文、币名、账号名等数据容器一律不做字典替换。
 */
(function () {
  'use strict';
  if (window.__j7zhLoaded) return;
  window.__j7zhLoaded = true;

  const D = window.__J7_ZH;
  if (!D) return;

  /* ---------- 设置（存 localStorage，和站点同源） ---------- */
  const LS = {
    ui: 'j7zh_enabled',        // 界面汉化     默认开
    reader: 'j7zh_reader',     // 阅读模式     默认开
    trans: 'j7zh_autotrans',   // 正文翻译     默认开
    engine: 'j7zh_engine',     // 翻译引擎     auto | local | google
    copykw: 'j7zh_copykw',     // 点击关键词复制 默认开
    gmgn: 'j7zh_gmgn',         // 复制后打开 GMGN 搜索 默认开
    labels: 'j7zh_labels'       // Twitter 作者标签 默认开
  };
  const getFlag = (k, def) => { try { const v = localStorage.getItem(k); return v === null ? def : v !== '0'; } catch (e) { return def; } };
  const setFlag = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} };
  const getStr = (k, def) => { try { return localStorage.getItem(k) || def; } catch (e) { return def; } };
  const S = { ui: getFlag(LS.ui, true), reader: getFlag(LS.reader, true), trans: getFlag(LS.trans, true), engine: getStr(LS.engine, 'auto'), copykw: getFlag(LS.copykw, true), gmgn: getFlag(LS.gmgn, true), labels: getFlag(LS.labels, true) };
  if (!/^(auto|local|google)$/.test(S.engine)) S.engine = 'auto';

  /* ---------- 字典索引 ---------- */
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const exact = new Map();
  const lower = new Map();
  for (const k of Object.keys(D.exact)) {
    const nk = norm(k);
    exact.set(nk, D.exact[k]);
    const lk = nk.toLowerCase();
    if (!lower.has(lk)) lower.set(lk, D.exact[k]);
  }
  const REGEX = D.regex || [];
  const CONTEXT = D.context || [];
  const IN_BUTTON = D.inButton || {};

  // 只在登录页/首页生效的碎片（hero 标题被拆成多个节点）
  const LANDING_ONLY = new Set(['for', 'snipers', 'deployers', 'traders', 'degens', 'devs', 'builders', 'The fastest tracker']);
  const isLandingPage = () => !!document.querySelector('input[type="password"]');

  /* ---------- 跳过的容器（用户内容 / 数据） ---------- */
  const EXCLUDE_SEL = [
    'script', 'style', 'textarea', 'input', 'code', 'pre', 'kbd', '[contenteditable]',
    '#j7zh-toggle', '#j7zh-menu', '.j7zh-trans', '.j7zh-user-label', '.j7zh-label-edit',
    '.j7zh-label-panel', '.j7zh-label-editor', '.j7zh-label-manager',
    // 推文正文与引用
    '.tweet-content', '.quoted-tweet', '.nested-quoted-tweet', '.reply-to-tweet',
    '.pinned-text', '.pinned-tweet-content', '.pinned-update-content', '.following-update-content',
    // 站点自带的推文翻译结果
    '.tweet-translation', '.translation-body', '.translation-text', '.translation-content',
    // 作者 / 资料卡（名字、handle、简介、地点、链接）
    '.tweet-author', '.profile-bio', '.profile-location', '.profile-website', '.profile-name',
    '.profile-handle', '.profile-joined', '.quoted-author', '.nested-quoted-author',
    '.translation-author', '.translation-name', '.translation-handle',
    // AI 建议卡片的币名 / 代码
    '.ai-card-name', '.ai-card-ticker',
    // 粉丝数（时间容器不排除：只做 12→24 小时制转换）
    '.follower-count-badge',
    // 文章卡片、聊天消息
    '[class*="article"]', '[class*="chat-message"]', '.site-chat-messages', '.chat-messages', '.message-list'
  ].join(',');

  // 这些容器里只做“动词”替换（@xxx posted / retweeted …），不查通用字典
  const CONTEXT_SEL = '.context-text, .following-update-content, .pinned-update-content';

  const FIELD_ZH = { name: '名称', bio: '简介', avatar: '头像', banner: '横幅', username: '用户名' };

  /* ---------- 查找译文 ---------- */
  function lookup(text, parentEl) {
    const t = norm(text);
    if (!t || !/[A-Za-z]/.test(t)) return null;

    if (LANDING_ONLY.has(t)) return isLandingPage() ? exact.get(t) : null;

    // “6 of 18 selected” 被拆成多个节点时的 of
    if (t === 'of') {
      const pt = parentEl && parentEl.parentElement ? parentEl.parentElement.textContent : '';
      return /\d\s*of\s*\d/.test(pt) ? '/' : null;
    }

    // 按钮内的特殊译法
    if (IN_BUTTON[t] !== undefined && parentEl && parentEl.closest('button, [role="button"]')) return IN_BUTTON[t];

    let v = exact.get(t);
    if (v !== undefined) return v;

    // 大小写不敏感兜底：只对含大写字母的文案生效（避免误伤全小写的用户名等数据）
    if (/[A-Z]/.test(t)) {
      v = lower.get(t.toLowerCase());
      if (v !== undefined) return v;
    }

    for (const [re, rep] of REGEX) {
      if (re.test(t)) return t.replace(re, rep);
    }
    return null;
  }

  function translateContext(text) {
    let out = text;
    for (const [re, rep] of CONTEXT) {
      if (re.test(out)) {
        out = out.replace(re, (m, a, b) => {
          if (typeof rep === 'function') return rep(m, a, b);
          if (rep.indexOf('$2') >= 0) return rep.replace('$2', FIELD_ZH[b] || b || '');
          return rep.replace('$1', a || '');
        });
      }
    }
    return out === text ? null : out;
  }

  /* ---------- 文本节点 ---------- */
  const lastSet = new WeakMap(); // node -> 我们写入的值，避免自触发循环

  function processTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !/[A-Za-z]/.test(raw)) return;
    if (lastSet.get(node) === raw) return; // 是我们刚写的
    const parent = node.parentElement;
    if (!parent) return;
    // 资料卡里的 Followers / Following / posts 标签、扫描按钮：虽在正文容器里，但是界面文案，照常查字典
    const uiIsland = parent.closest('.profile-metrics, .profile-card-scan-btn, .profile-joined, .metric, .tweet-time, .modern-inline-time, .mlw-bb-time, .time-full, .time-short');
    if (!uiIsland && parent.closest(EXCLUDE_SEL)) {
      // 例外：关注/资料更新行里的动词仍然翻译
      if (!parent.closest('.following-update-content, .pinned-update-content')) return;
    }

    let translated = null;
    // “15 deploy” + “s” 这种被拆开的复数 s：前面已翻成“次发币”的话把 s 去掉
    if (norm(raw) === 's' && node.previousSibling && /次发币$/.test((node.previousSibling.textContent || '').trim())) {
      lastSet.set(node, ''); node.nodeValue = ''; return;
    }
    if (!uiIsland && parent.closest(CONTEXT_SEL)) {
      translated = translateContext(raw);
    } else {
      const v = lookup(raw, parent);
      if (v !== null && v !== undefined) {
        const m = raw.match(/^(\s*)[\s\S]*?(\s*)$/);
        translated = (m ? m[1] : '') + v + (m ? m[2] : '');
      }
    }
    if (translated !== null && translated !== raw) {
      lastSet.set(node, translated);
      node.nodeValue = translated;
    }
  }

  /* ---------- 属性（placeholder / title / aria-label / data-tooltip） ---------- */
  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tooltip', 'data-tip', 'alt'];
  const lastAttr = new WeakMap(); // el -> {attr: value}

  function processAttrs(el) {
    if (el.nodeType !== 1) return;
    if (el.closest && el.closest('#j7zh-toggle, #j7zh-menu, .j7zh-trans')) return;
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      if (!cur || !/[A-Za-z]/.test(cur)) continue;
      const rec = lastAttr.get(el);
      if (rec && rec[a] === cur) continue;
      const v = lookup(cur, el);
      if (v !== null && v !== undefined && v !== cur) {
        const r = rec || {};
        r[a] = v;
        lastAttr.set(el, r);
        el.setAttribute(a, v);
      }
    }
  }

  /* ---------- 遍历 ---------- */
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
  function isOurs(el) {
    return el.id === 'j7zh-toggle' || el.id === 'j7zh-menu' ||
      (el.classList && (el.classList.contains('j7zh-trans') || el.classList.contains('j7zh-user-label') ||
        el.classList.contains('j7zh-label-edit') || el.classList.contains('j7zh-label-panel') ||
        el.classList.contains('j7zh-label-editor') || el.classList.contains('j7zh-label-manager')));
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { processTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (isOurs(root) || SKIP_TAGS[root.tagName]) return;
      processAttrs(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS[n.tagName] || isOurs(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) processTextNode(n);
      else processAttrs(n);
    }
  }

  /* =====================================================================
   *  正文翻译
   *  - 找到真正承载文字的节点 → 取纯文本 → 批量发给 background（Google 翻译）→ 译文块插在节点后面
   *  - 失败指数退避；译文缓存在 localStorage，刷新后不用重翻
   * ===================================================================== */
  const TR = {
    UNIT_SEL: [
      '.tweet-content:not(:has(.tweet-content)):not(:has(.quoted-tweet)):not(:has(.nested-quoted-tweet))',
      '.quote-comment',
      '.quoted-tweet-content',
      '.nested-quoted-tweet-content',
      '.pinned-tweet-content',
      '.profile-bio'
    ].join(','),
    STRIP_SEL: '.j7zh-trans, .tweet-media, .media-container, img, video, svg, .quoted-tweet, .nested-quoted-tweet, .video-preview-container, [class*="article"], .tweet-translation',
    cache: new Map(),     // key -> 译文
    failed: new Map(),    // key -> 失败时间
    queue: [],            // [{key,text}]
    queued: new Set(),
    busy: false,
    BATCH: 10,
    pauseUntil: 0,
    backoff: 0,
    status: 'idle',       // idle | working | paused | error
    tl: 'zh-CN'
  };

  // 持久缓存（最多 1500 条）
  const CACHE_LS = 'j7zh_trcache_v1';
  (function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_LS);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const [k, v] of arr) if (typeof k === 'string' && typeof v === 'string') TR.cache.set(k, v);
    } catch (e) {}
  })();
  let saveTimer = null;
  function saveCacheSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        let arr = [...TR.cache.entries()];
        if (arr.length > 1500) arr = arr.slice(arr.length - 1500);
        localStorage.setItem(CACHE_LS, JSON.stringify(arr));
      } catch (e) {}
    }, 2000);
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '_' + s.length;
  }

  // 把节点变成保留换行的纯文本
  function unitText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(TR.STRIP_SEL).forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('div, p, li, blockquote').forEach((b) => { b.appendChild(document.createTextNode('\n')); });
    let t = clone.textContent || '';
    t = t.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  const LETTERS_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]/g;
  const LETTERS2_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]{2,}/;
  function needsTranslate(t) {
    if (!t || t.length < 2) return false;
    if (/^(un)?followed\s+@\S+$/i.test(t)) return false; // 关注事件行，头部已有中文
    if (/^(pinned|unpinned)\b/i.test(t) && t.length < 40) return false;
    const letters = (t.match(LETTERS_RE) || []).length;
    const han = (t.match(/[一-鿿]/g) || []).length;
    if (letters < 2) return false;
    if (han >= letters) return false; // 本来就是中文为主
    const stripped = t.replace(/https?:\/\/\S+|pic\.x\.com\/\S+|\bt\.co\/\S+|@\w+|#\w+|\$\w+/g, ' ');
    return LETTERS2_RE.test(stripped);
  }

  // ---- 本地引擎：Chrome 内置 Translator / LanguageDetector（138+，离线、无限流） ----
  const LOCAL = {
    ok: (typeof self !== 'undefined' && typeof self.Translator !== 'undefined'),
    translators: new Map(),   // srcLang -> Promise<Translator|null>
    detectorP: null,
    unsupported: new Set(),
    async detect(text) {
      try {
        if (typeof self.LanguageDetector === 'undefined') return 'en';
        if (!this.detectorP) this.detectorP = LanguageDetector.create().catch(() => null);
        const det = await this.detectorP;
        if (!det) return 'en';
        // 去掉 @ / # / 链接 再测，少受干扰
        const probe = text.replace(/https?:\/\/\S+|@\w+|#\w+|\$\w+/g, ' ').trim() || text;
        const res = await det.detect(probe);
        const top = res && res[0];
        if (!top || !top.detectedLanguage || top.detectedLanguage === 'und' || (top.confidence || 0) < 0.35) return 'en';
        return top.detectedLanguage.split('-')[0];
      } catch (e) { return 'en'; }
    },
    needGesture: new Set(),   // 创建时要求用户手势（部分 Chrome 版本首次下载语言包需要），等下一次点击再试
    retryAt: new Map(),       // 创建临时失败的语种 -> 下次可重试时间
    lastErr: null,
    async get(lang) {
      if (this.unsupported.has(lang)) return null;
      const ra = this.retryAt.get(lang);
      if (ra && Date.now() < ra) return null;
      if (!this.translators.has(lang)) {
        const p = (async () => {
          try {
            const av = await Translator.availability({ sourceLanguage: lang, targetLanguage: 'zh-Hans' });
            if (av === 'unavailable') { this.unsupported.add(lang); return null; }
            const t = await Translator.create({ sourceLanguage: lang, targetLanguage: 'zh-Hans' });
            this.retryAt.delete(lang);
            return t;
          } catch (e) {
            this.lastErr = lang + ': ' + String((e && (e.name + ' ' + e.message)) || e);
            this.translators.delete(lang);
            if (e && e.name === 'NotAllowedError') { this.needGesture.add(lang); return null; }
            // 其它错误（模型在忙/下载中等）当作临时失败，60 秒后再试；不永久拉黑
            this.retryAt.set(lang, Date.now() + 60000);
            return null;
          }
        })();
        this.translators.set(lang, p);
      }
      return this.translators.get(lang);
    },
    // 用户点了页面 → 把之前因“需要手势”没建成的翻译器补建起来
    retryOnGesture() {
      if (!this.needGesture.size) return;
      const langs = [...this.needGesture]; this.needGesture.clear();
      langs.forEach((l) => { this.translators.delete(l); this.get(l); });
      TR.failed.clear(); TR.pauseUntil = 0; TR.backoff = 0;
      scheduleScan(document.body);
    },
    async translate(text) {
      const lang = await this.detect(text);
      if (lang === 'zh') return null;
      const tr = await this.get(lang);
      if (!tr) throw new Error('no local translator for ' + lang);
      // 按段翻，保住换行
      const lines = text.split('\n');
      const out = [];
      for (const ln of lines) {
        if (!ln.trim()) { out.push(ln); continue; }
        if (!/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]/.test(ln)) { out.push(ln); continue; }
        out.push(await tr.translate(ln));
      }
      const zh = out.join('\n');
      return zh && zh.trim() && zh.trim() !== text.trim() ? zh : null;
    }
  };
  function engineInUse() {
    if (S.engine === 'google') return 'google';
    if (S.engine === 'local') return LOCAL.ok ? 'local' : 'none';
    return LOCAL.ok ? 'local' : 'google';
  }

  // ---- 请求（Google，经 background） ----
  function sendBatch(texts) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      const direct = async () => {
        // 兜底：没有扩展上下文时（比如被当普通脚本注入）直接从页面请求。Google 不一定带 CORS 头，失败就算了
        const out = [];
        for (const t of texts) {
          try {
            const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + TR.tl + '&dt=t', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'q=' + encodeURIComponent(t)
            });
            const j = await r.json();
            out.push((j && j[0] ? j[0] : []).map((s) => (s && s[0]) || '').join('') || null);
          } catch (e) { out.push(null); if (out.length === 1) { finish(reject, e); return; } }
        }
        finish(resolve, { results: out, paused: 0 });
      };
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({ type: 'j7zh-translate-batch', texts, tl: TR.tl }, (resp) => {
            if (chrome.runtime.lastError || !resp) return direct();
            if (resp.ok) finish(resolve, resp); else finish(reject, new Error(resp.error || 'fail'));
          });
          setTimeout(() => { if (!done) finish(reject, new Error('timeout')); }, 40000);
        } else direct();
      } catch (e) { direct(); }
    });
  }

  function makeBlock(key, text, loading) {
    const d = document.createElement('div');
    d.className = 'j7zh-trans' + (loading ? ' j7zh-loading' : '');
    d.setAttribute('data-j7zh-for', key);
    d.textContent = text;
    return d;
  }

  function placeBlock(unit, key, text, loading) {
    let blk = unit.nextElementSibling;
    if (!(blk && blk.classList && blk.classList.contains('j7zh-trans'))) {
      blk = makeBlock(key, text, loading);
      unit.insertAdjacentElement('afterend', blk);
    } else {
      blk.setAttribute('data-j7zh-for', key);
      blk.textContent = text;
      blk.classList.toggle('j7zh-loading', !!loading);
    }
    return blk;
  }

  function removeBlocksFor(key) {
    document.querySelectorAll('.j7zh-trans[data-j7zh-for="' + key + '"]').forEach((b) => b.remove());
  }

  function applyCached(key) {
    const zh = TR.cache.get(key);
    if (!zh) return;
    document.querySelectorAll('[data-j7zh-key="' + key + '"]').forEach((unit) => placeBlock(unit, key, zh, false));
  }

  function setStatus(st) { TR.status = st; const el = document.getElementById('j7zh-status'); if (el) el.textContent = statusText(); }
  function engineLabel() { const e = engineInUse(); return e === 'local' ? 'Chrome 本地翻译（离线）' : e === 'google' ? 'Google 翻译' : '本地引擎不可用'; }
  function statusText() {
    if (!S.trans) return '正文翻译：已关闭';
    if (TR.status === 'paused') { const s = Math.max(0, Math.ceil((TR.pauseUntil - Date.now()) / 1000)); return '正文翻译：暂时失败，' + s + ' 秒后重试'; }
    if (TR.status === 'working') return '正文翻译：翻译中…　引擎：' + engineLabel() + '（缓存 ' + TR.cache.size + ' 条）';
    return '正文翻译：正常　引擎：' + engineLabel() + '（缓存 ' + TR.cache.size + ' 条）';
  }

  const BACKOFF = [0, 5, 15, 30, 60, 120, 300];
  function failJobs(jobs) {
    jobs.forEach((j) => { TR.failed.set(j.key, Date.now()); removeBlocksFor(j.key); });
    TR.backoff = Math.min(TR.backoff + 1, 6);
    TR.pauseUntil = Date.now() + BACKOFF[TR.backoff] * 1000;
  }
  function pump() {
    if (TR.busy || !S.trans) return;
    const engine = engineInUse();
    // 退避只管 Google 那条路；本地引擎不受影响
    if (engine !== 'local' && Date.now() < TR.pauseUntil) { setStatus('paused'); setTimeout(pump, TR.pauseUntil - Date.now() + 50); return; }
    if (!TR.queue.length) { setStatus('idle'); return; }
    const jobs = TR.queue.splice(0, TR.BATCH);
    jobs.forEach((j) => TR.queued.delete(j.key));
    TR.busy = true; setStatus('working');
    (async () => {
      let rest = jobs;
      // 1) 本地引擎
      if (engine === 'local') {
        rest = [];
        for (const j of jobs) {
          try {
            const zh = await LOCAL.translate(j.text);
            if (zh) { TR.cache.set(j.key, zh); applyCached(j.key); }
            else rest.push(j);
          } catch (e) { window.__j7zh.lastErr = String(e && e.message || e); rest.push(j); }
        }
        if (rest.length < jobs.length) { TR.backoff = 0; saveCacheSoon(); }
      }
      if (!rest.length) return;
      // 2) Google（本地不支持的语种 / 本地失败 / 用户指定）
      if (S.engine === 'local' || Date.now() < TR.pauseUntil) { rest.forEach((j) => { TR.failed.set(j.key, Date.now()); removeBlocksFor(j.key); }); return; }
      try {
        const resp = await sendBatch(rest.map((j) => j.text));
        let anyOk = false;
        rest.forEach((j, i) => {
          const zh = resp.results && resp.results[i];
          if (zh) { TR.cache.set(j.key, zh); anyOk = true; applyCached(j.key); }
          else { TR.failed.set(j.key, Date.now()); removeBlocksFor(j.key); }
        });
        if (anyOk) { TR.backoff = 0; saveCacheSoon(); }
        if (resp.paused && resp.paused > 0) TR.pauseUntil = Date.now() + resp.paused;
        else if (!anyOk) { TR.backoff = Math.min(TR.backoff + 1, 6); TR.pauseUntil = Date.now() + BACKOFF[TR.backoff] * 1000; }
      } catch (e) { failJobs(rest); }
    })().catch(() => failJobs(jobs)).finally(() => { TR.busy = false; setTimeout(pump, engineInUse() === 'local' ? 10 : 120); });
  }

  function scanUnits(root) {
    if (!S.trans) return;
    const scope = root && root.nodeType === 1 ? root : document;
    let units;
    try {
      units = scope.matches && scope.matches(TR.UNIT_SEL) ? [scope] : [...scope.querySelectorAll(TR.UNIT_SEL)];
    } catch (e) { return; }
    const paused = engineInUse() !== 'local' && Date.now() < TR.pauseUntil;
    for (const unit of units) {
      if (unit.closest('#j7zh-menu, .j7zh-trans')) continue;
      if (unit.closest('.following-update-content')) {
        const nb0 = unit.nextElementSibling;
        if (nb0 && nb0.classList && nb0.classList.contains('j7zh-trans')) nb0.remove();
        continue;
      }
      const text = unitText(unit);
      if (!needsTranslate(text)) {
        unit.removeAttribute('data-j7zh-key');
        const nb = unit.nextElementSibling;
        if (nb && nb.classList && nb.classList.contains('j7zh-trans')) nb.remove();
        continue;
      }
      const key = hashStr(text);
      if (unit.getAttribute('data-j7zh-key') !== key) unit.setAttribute('data-j7zh-key', key);
      const nxt = unit.nextElementSibling;
      const hasBlock = nxt && nxt.classList && nxt.classList.contains('j7zh-trans') && nxt.getAttribute('data-j7zh-for') === key;
      if (TR.cache.has(key)) { if (!hasBlock || nxt.classList.contains('j7zh-loading')) placeBlock(unit, key, TR.cache.get(key), false); continue; }
      if (hasBlock) continue; // 已在排队/翻译中
      const f = TR.failed.get(key);
      if (f && Date.now() - f < 90000) continue; // 失败的 90 秒后再试
      if (!TR.queued.has(key)) { TR.queued.add(key); TR.queue.push({ key, text }); }
      if (!paused) placeBlock(unit, key, '翻译中…', true);
    }
    pump();
  }

  let scanTimer = null;
  const scanPending = new Set();
  function processScan(n) {
    tagKeywords(n);
    if (S.trans) scanUnits(n);
    if (S.labels) scanLabels(n);
  }
  function scheduleScan(node) {
    if (!S.trans && !S.copykw && !S.labels) return;
    scanPending.add(node || document.body);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const batch = [...scanPending]; scanPending.clear();
      if (batch.some((n) => n === document.body)) processScan(document.body);
      else batch.forEach((n) => { if (n.isConnected) processScan(n); });
    }, 250);
  }

  /* =====================================================================
   *  点击关键词复制
   *  站点把关键词（AI 预测名、黄色关键词、CA 等）包在正文里的裸 <span> 中并加药丸样式；
   *  给这些 span 打上 .j7zh-kw，点击即复制其文字，弹小气泡确认。
   * ===================================================================== */
  const KW_SCOPE = '.tweet-content, .quoted-tweet-content, .nested-quoted-tweet-content, .pinned-tweet-content, .quote-comment';

  function isPillSpan(sp) {
    if (sp.children.length) return false;
    const txt = (sp.textContent || '').trim();
    if (!txt || txt.length > 120) return false;
    const cs = getComputedStyle(sp);
    const bg = cs.backgroundColor;
    const hasBg = bg && bg !== 'transparent' && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(bg);
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(cs.borderTopColor);
    return hasBg || hasBorder;
  }

  function tagKeywords(root) {
    if (!S.copykw) return;
    const scope = root && root.nodeType === 1 && root.querySelectorAll ? root : document.body;
    if (!scope) return;
    let spans;
    try { spans = scope.querySelectorAll('span:not(.j7zh-kw):not([class])'); } catch (e) { return; }
    for (const sp of spans) {
      if (!sp.closest(KW_SCOPE)) continue;
      if (sp.closest('.j7zh-trans, #j7zh-menu, a, button, .tweet-translation')) continue;
      if (!isPillSpan(sp)) continue;
      sp.classList.add('j7zh-kw');
      if (!sp.getAttribute('title')) sp.setAttribute('title', '点击复制');
    }
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  let toastTimer = null;
  function showToast(x, y, text, ok) {
    let t = document.getElementById('j7zh-toast');
    if (!t) { t = document.createElement('div'); t.id = 'j7zh-toast'; (document.body || document.documentElement).appendChild(t); }
    t.textContent = text;
    t.classList.toggle('j7zh-toast-err', !ok);
    const pad = 14;
    t.style.left = Math.min(Math.max(x, 60), innerWidth - 160) + 'px';
    t.style.top = Math.max(y - 38, pad) + 'px';
    t.classList.add('j7zh-toast-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('j7zh-toast-show'); }, 1200);
  }

  document.addEventListener('click', (e) => {
    if (!S.copykw) return;
    const kw = e.target && e.target.closest ? e.target.closest('.j7zh-kw') : null;
    if (!kw) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.toString().trim()) return; // 用户在选字，不抢
    const txt = (kw.textContent || '').trim();
    if (!txt) return;
    e.preventDefault();
    e.stopPropagation();
    const openGmgn = S.gmgn;
    copyTextToClipboard(txt).then((ok) => {
      const short = txt.length > 24 ? txt.slice(0, 24) + '…' : txt;
      showToast(e.clientX, e.clientY, ok ? (openGmgn ? '已复制，GMGN 后台搜索中：' : '已复制：') + short : '复制失败', ok);
    });
    if (openGmgn) {
      // 经 background 用 tabs API 后台打开/更新 GMGN 标签页——不切走焦点，人留在 j7 继续看流
      let sent = false;
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({ type: 'j7zh-gmgn-search', q: txt }, () => { void chrome.runtime.lastError; });
          sent = true;
        }
      } catch (err) {}
      // 兜底（扩展上下文不可用时）：命名窗口打开，会抢焦点但至少能用
      if (!sent) { try { window.open('https://gmgn.ai/?chain=sol#j7q=' + encodeURIComponent(txt), 'j7zh_gmgn'); } catch (err) {} }
    }
  }, true);

  function applyCopyKw() {
    document.documentElement.classList.toggle('j7zh-copykw', !!S.copykw);
    if (S.copykw) tagKeywords(document.body);
  }

  /* =====================================================================
   *  Twitter 作者 position 标签
   *  标签和 Frontrun 敏感配置由 background 持久化；content 只拿公开的 username/position。
   * ===================================================================== */
  const LU = window.J7ZhLabels;
  const LABELS = {
    map: new Map(),
    loaded: false,
    loading: null,
    autoUpdate: false,
    emptyTtlHours: LU ? LU.DEFAULT_EMPTY_TTL_HOURS : 24,
    configSaved: false,
    autoUpdatedCount: 0,
    autoPauseUntil: 0,
    autoLastError: '',
    count: 0,
    nonEmpty: 0,
    localCount: 0,
    job: { busy: false, phase: 'idle', current: 0, total: 0, updated: 0, error: '' },
    rate: null,
    missing: new Map(),
    pending: new Set(),
    missingTimer: null,
    batchDueAt: 0,
    status: ''
  };
  const CA = { map: new Map(), pending: new Set(), timer: null };
  const AUTHOR_SEL = '.tweet-author, .quoted-author, .nested-quoted-author, .pinned-tweet-author';
  const LABEL_AUTO_BATCH_MIN_MS = 5000;
  const LABEL_AUTO_BATCH_MAX_MS = 10000;

  function sendLabelMessage(message) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) { reject(new Error('扩展后台不可用')); return; }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!response || !response.ok) { reject(new Error(response && response.error || '标签操作失败')); return; }
        resolve(response.result || {});
      });
    });
  }

  function mergeLabelRows(rows, replace) {
    if (!LU) return;
    if (replace) LABELS.map.clear();
    for (const row of LU.normalizeRows(rows)) LABELS.map.set(row.twitterUsername.toLowerCase(), row);
    LABELS.loaded = true;
    LABELS.count = LABELS.map.size;
    LABELS.nonEmpty = [...LABELS.map.values()].filter((row) => LU.effectiveLabel(row)).length;
    LABELS.localCount = [...LABELS.map.values()].filter((row) => row.source === 'USER').length;
  }

  function applyPublicLabelState(state) {
    if (!state) return;
    LABELS.autoUpdate = state.autoUpdate === true;
    LABELS.emptyTtlHours = LU ? LU.normalizeEmptyTtlHours(state.emptyTtlHours) : 24;
    LABELS.configSaved = state.configSaved === true;
    LABELS.autoUpdatedCount = Math.max(0, Math.floor(Number(state.autoUpdatedCount) || 0));
    LABELS.autoPauseUntil = Math.max(0, Number(state.autoPauseUntil) || 0);
    LABELS.autoLastError = String(state.autoLastError || '');
    LABELS.count = Number(state.count) || LABELS.map.size;
    LABELS.nonEmpty = Number(state.nonEmpty) || 0;
    LABELS.localCount = Number(state.localCount) || 0;
    LABELS.job = state.job || LABELS.job;
    LABELS.rate = state.rate || null;
    renderLabelPanelState();
  }

  function loadLabelState(force) {
    if (!LU) return Promise.reject(new Error('标签工具未加载'));
    if (LABELS.loading && !force) return LABELS.loading;
    LABELS.loading = sendLabelMessage({ type: 'j7zh-labels-get' }).then((result) => {
      mergeLabelRows(result.rows, true);
      applyPublicLabelState(result.state);
      scanLabels(document.body);
      return result;
    }).catch((error) => {
      LABELS.status = error.message;
      renderLabelPanelState();
      throw error;
    }).finally(() => { LABELS.loading = null; });
    return LABELS.loading;
  }

  function findAuthorUsername(author) {
    if (!LU || !author) return '';
    for (const link of author.querySelectorAll('a[href]')) {
      const username = LU.usernameFromHref(link.href);
      if (username) return username;
    }
    const handleEl = author.querySelector('.profile-handle, [class*="handle"], [class*="username"]');
    const match = String(handleEl && handleEl.textContent || author.textContent || '').match(/@([A-Za-z0-9_]{1,50})/);
    return match ? LU.normalizeUsername(match[1]) : '';
  }

  function labelTarget(author) {
    return author.querySelector('.tweet-time, .modern-inline-time, .mlw-bb-time, .time-full, .time-short, time') ||
      author.querySelector('.tweet-author-name, .profile-name, strong, a[href]');
  }

  function displayLabel(row) { return LU ? LU.effectiveLabel(row) : ''; }

  async function commitLocalLabel(username, action, value) {
    const result = await sendLabelMessage({ type: 'j7zh-label-local-set', username, action, value: value || '' });
    if (result.row) mergeLabelRows([result.row], false);
    applyPublicLabelState(result.state);
    scanLabels(document.body);
    renderLabelManager();
    return result;
  }

  let quickLabelEditorCleanup = null;

  function closeQuickLabelEditor() {
    if (quickLabelEditorCleanup) quickLabelEditorCleanup();
    quickLabelEditorCleanup = null;
    const old = document.getElementById('j7zh-label-editor');
    if (old) old.remove();
  }

  function openQuickLabelEditor(username) {
    closeQuickLabelEditor();
    const row = LABELS.map.get(username.toLowerCase());
    const editor = document.createElement('div');
    editor.id = 'j7zh-label-editor';
    editor.className = 'j7zh-label-editor';
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-modal', 'false');
    editor.setAttribute('aria-labelledby', 'j7zh-label-editor-title');
    editor.innerHTML = '<div class="j7zh-label-editor-title"></div><div class="j7zh-label-editor-line"><input type="text" maxlength="100" placeholder="输入自定义备注"><button type="button" data-action="save">保存</button><button type="button" data-action="delete">隐藏</button><button type="button" data-action="close">×</button></div><small>自定义备注优先显示；隐藏后可在「编辑备注」中恢复 Frontrun 备注。</small>';
    const title = editor.querySelector('.j7zh-label-editor-title');
    title.id = 'j7zh-label-editor-title';
    title.textContent = '⋮⋮  @' + username + ' · 编辑备注';
    title.title = '拖动标题可移动窗口';
    const input = editor.querySelector('input');
    input.value = displayLabel(row);
    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.dataset.action = 'restore';
    restoreButton.textContent = '恢复 Frontrun';
    if (!row || row.source !== 'USER') restoreButton.hidden = true;
    const actionLine = editor.querySelector('.j7zh-label-editor-line');
    actionLine.insertBefore(restoreButton, actionLine.querySelector('[data-action="close"]'));
    document.body.appendChild(editor);

    const viewportPadding = 12;
    let drag = null;
    const placeEditor = (left, top) => {
      const maxLeft = Math.max(viewportPadding, window.innerWidth - editor.offsetWidth - viewportPadding);
      const maxTop = Math.max(viewportPadding, window.innerHeight - editor.offsetHeight - viewportPadding);
      editor.style.left = Math.max(viewportPadding, Math.min(maxLeft, left)) + 'px';
      editor.style.top = Math.max(viewportPadding, Math.min(maxTop, top)) + 'px';
    };
    const centerEditor = () => placeEditor((window.innerWidth - editor.offsetWidth) / 2, (window.innerHeight - editor.offsetHeight) / 2);
    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      placeEditor(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    };
    const stopDragging = (event) => {
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      const pointerId = drag.pointerId;
      drag = null;
      title.classList.remove('is-dragging');
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', stopDragging, true);
      document.removeEventListener('pointercancel', stopDragging, true);
      try { if (title.hasPointerCapture(pointerId)) title.releasePointerCapture(pointerId); } catch (error) {}
    };
    const onPointerDown = (event) => {
      if (event.button !== 0 || drag) return;
      const rect = editor.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      editor.dataset.dragged = '1';
      title.classList.add('is-dragging');
      try { title.setPointerCapture(event.pointerId); } catch (error) {}
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', stopDragging, true);
      document.addEventListener('pointercancel', stopDragging, true);
      event.preventDefault();
    };
    const onResize = () => {
      if (editor.dataset.dragged === '1') {
        const rect = editor.getBoundingClientRect();
        placeEditor(rect.left, rect.top);
      } else centerEditor();
    };
    const onWindowBlur = () => stopDragging();
    title.addEventListener('pointerdown', onPointerDown);
    title.addEventListener('lostpointercapture', stopDragging);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onWindowBlur);
    quickLabelEditorCleanup = () => {
      stopDragging();
      title.removeEventListener('pointerdown', onPointerDown);
      title.removeEventListener('lostpointercapture', stopDragging);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onWindowBlur);
    };
    centerEditor();
    editor.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = event.target && event.target.dataset && event.target.dataset.action;
      if (!action) return;
      if (action === 'close') { closeQuickLabelEditor(); return; }
      try {
        await commitLocalLabel(username, action, input.value);
        LABELS.status = action === 'save' ? '已保存 @' + username + ' 的自定义备注' : action === 'delete' ? '已隐藏 @' + username + ' 的备注' : '已恢复 @' + username + ' 的 Frontrun 备注';
        closeQuickLabelEditor();
        renderLabelPanelState();
      } catch (error) {
        editor.querySelector('small').textContent = '操作失败：' + error.message;
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') editor.querySelector('[data-action="save"]').click();
      if (event.key === 'Escape') closeQuickLabelEditor();
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  function queueMissingLabel(username) {
    if (!LABELS.autoUpdate || !LABELS.configSaved || !username) return;
    if (LABELS.autoPauseUntil > Date.now()) return;
    const key = username.toLowerCase();
    if (LABELS.pending.has(key)) return;
    const before = LABELS.missing.size;
    LABELS.missing.set(key, username);
    if (LABELS.missing.size !== before) renderLabelPanelState();
    if (LABELS.missingTimer) return;
    const waitMs = LABEL_AUTO_BATCH_MIN_MS + Math.floor(Math.random() * (LABEL_AUTO_BATCH_MAX_MS - LABEL_AUTO_BATCH_MIN_MS + 1));
    LABELS.batchDueAt = Date.now() + waitMs;
    LABELS.missingTimer = setTimeout(() => {
      LABELS.missingTimer = null;
      LABELS.batchDueAt = 0;
      const usernames = [...LABELS.missing.values()];
      LABELS.missing.clear();
      if (!usernames.length) return;
      usernames.forEach((name) => LABELS.pending.add(name.toLowerCase()));
      renderLabelPanelState();
      sendLabelMessage({ type: 'j7zh-label-query-missing', usernames }).then((result) => {
        mergeLabelRows(result.rows || [], false);
        applyPublicLabelState(result.state);
        if (result.warning) LABELS.status = result.warning;
        else if ((result.rows || []).length) LABELS.status = '自动批量更新完成：本批 ' + result.rows.length + ' 个 username';
        scanLabels(document.body);
      }).catch((error) => {
        LABELS.status = error.message;
        renderLabelPanelState();
      }).finally(() => {
        usernames.forEach((name) => LABELS.pending.delete(name.toLowerCase()));
        renderLabelPanelState();
      });
    }, waitMs);
  }

  function clearMissingLabelQueue() {
    if (LABELS.missingTimer) clearTimeout(LABELS.missingTimer);
    LABELS.missingTimer = null;
    LABELS.batchDueAt = 0;
    LABELS.missing.clear();
    LABELS.pending.clear();
    renderLabelPanelState();
  }

  function closeCaPopover() {
    const pop = document.getElementById('j7zh-ca-pop');
    if (pop) pop.remove();
  }

  document.addEventListener('mousedown', (event) => {
    const pop = document.getElementById('j7zh-ca-pop');
    if (!pop || pop.contains(event.target)) return;
    if (event.target.closest && event.target.closest('.j7zh-ca-badge')) return;
    pop.remove();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCaPopover();
  }, true);

  function caWhen(value) {
    if (value == null || value === '') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    return date.toISOString().slice(0, 10);
  }

  function caText(row) {
    if (!row || row.error || row.pending) return row && row.pending ? 'CA索引中' : '';
    const total = (Number(row.undeleted) || 0) + (Number(row.deleted) || 0);
    if (!total && !(row.items && row.items.length)) return '未发CA';
    return '历史CA ' + (total || row.items.length);
  }

  function openCaPopover(username, anchor) {
    closeCaPopover();
    const row = CA.map.get(username.toLowerCase());
    if (!row || row.error) return;
    const pop = document.createElement('div');
    pop.id = 'j7zh-ca-pop';
    pop.className = 'j7zh-ca-pop';
    const items = Array.isArray(row.items) ? row.items : [];
    const head = document.createElement('div');
    head.className = 'j7zh-ca-pop-title';
    head.textContent = '@' + username + ' · 未删 ' + (row.undeleted || 0) + ' · 已删 ' + (row.deleted || 0);
    pop.appendChild(head);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'j7zh-ca-pop-empty';
      const total = (Number(row.undeleted) || 0) + (Number(row.deleted) || 0);
      empty.textContent = row.pending ? 'Frontrun 还在索引，稍后再看' : (total ? '有计数，但这页没有具体合约' : '没有合约记录');
      pop.appendChild(empty);
    }
    for (const item of items) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'j7zh-ca-pop-row';
      const when = caWhen(item.time);
      line.textContent = (item.deleted ? '删 ' : '') + (item.chain ? item.chain + ' ' : '') + item.ca + (when ? '  ' + when : '');
      line.title = '点击复制';
      line.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try { await navigator.clipboard.writeText(item.ca); line.textContent = '已复制 ' + item.ca; } catch (error) {}
      });
      pop.appendChild(line);
    }
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
  }

  function renderCaBadge(author, username) {
    const key = username.toLowerCase();
    let badge = author.querySelector('.j7zh-ca-badge[data-j7zh-user="' + key + '"]');
    const row = CA.map.get(key);
    const text = caText(row);
    if (!text) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'j7zh-ca-badge';
      badge.dataset.j7zhUser = key;
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      const edit = author.querySelector('.j7zh-label-edit[data-j7zh-user="' + key + '"]');
      const label = author.querySelector('.j7zh-user-label[data-j7zh-user="' + key + '"]');
      const after = edit || label;
      if (after) after.insertAdjacentElement('afterend', badge);
      else author.appendChild(badge);
      const open = (event) => {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        openCaPopover(username, badge);
      };
      badge.addEventListener('click', open);
      badge.addEventListener('keydown', open);
    }
    const total = row ? (Number(row.undeleted) || 0) + (Number(row.deleted) || 0) : 0;
    badge.classList.toggle('has', total > 0 || (row && row.items && row.items.length));
    badge.classList.toggle('none', text === '未发CA');
    badge.title = text === '未发CA' ? 'Frontrun 没有这个号发过的合约' : '点击查看历史 CA';
    if (badge.textContent !== text) badge.textContent = text;
  }

  function queueCa(username) {
    if (!LABELS.configSaved) return;
    const key = username.toLowerCase();
    const hit = CA.map.get(key);
    if (hit && hit.fetchedAt && Date.now() - hit.fetchedAt < (hit.pending ? 90000 : hit.error ? 300000 : 6 * 3600 * 1000)) return;
    if (CA.pending.has(key)) return;
    CA.pending.add(key);
    clearTimeout(CA.timer);
    CA.timer = setTimeout(flushCa, 800);
  }

  function flushCa() {
    const names = [...CA.pending].slice(0, 8);
    names.forEach((name) => CA.pending.delete(name));
    if (CA.pending.size) CA.timer = setTimeout(flushCa, 4000);
    if (!names.length) return;
    sendLabelMessage({ type: 'j7zh-label-ca-get', usernames: names }).then((result) => {
      for (const row of result.rows || []) {
        if (row && row.username) CA.map.set(String(row.username).toLowerCase(), row);
      }
      scanLabels(document.body);
    }).catch((error) => { LABELS.status = error.message; });
  }

  function scanLabels(root) {
    if (!LU || !root) return;
    const scope = root.nodeType === 1 ? root : document.body;
    if (!scope) return;
    let authors = [];
    try {
      if (scope.matches && scope.matches(AUTHOR_SEL)) authors.push(scope);
      authors.push(...scope.querySelectorAll(AUTHOR_SEL));
    } catch (e) { return; }
    for (const author of authors) {
      const username = findAuthorUsername(author);
      if (!username) continue;
      const key = username.toLowerCase();
      const row = LABELS.map.get(key);
      const label = displayLabel(row);
      let badge = author.querySelector('.j7zh-user-label[data-j7zh-user="' + key + '"]');
      let edit = author.querySelector('.j7zh-label-edit[data-j7zh-user="' + key + '"]');
      if (!S.labels) {
        if (badge) badge.remove();
        if (edit) edit.remove();
        author.querySelectorAll('.j7zh-ca-badge[data-j7zh-user="' + key + '"]').forEach((node) => node.remove());
        continue;
      }
      const target = labelTarget(author);
      if (label && !badge) {
        author.querySelectorAll('.j7zh-user-label').forEach((old) => old.remove());
        badge = document.createElement('span');
        badge.className = 'j7zh-user-label';
        badge.dataset.j7zhUser = key;
        if (target) target.insertAdjacentElement('afterend', badge);
        else author.appendChild(badge);
      }
      if (!label && badge) { badge.remove(); badge = null; }
      if (badge) {
        badge.title = '@' + username + (row && row.source === 'USER' ? ' · 用户自定义备注' : ' · Frontrun position');
        if (badge.textContent !== label) badge.textContent = label;
      }
      if (!edit) {
        author.querySelectorAll('.j7zh-label-edit').forEach((old) => old.remove());
        edit = document.createElement('span');
        edit.className = 'j7zh-label-edit';
        edit.dataset.j7zhUser = key;
        edit.setAttribute('role', 'button');
        edit.setAttribute('tabindex', '0');
        edit.setAttribute('aria-label', '编辑 @' + username + ' 的备注');
        edit.title = '编辑备注';
        edit.textContent = '✎';
        const after = badge || target;
        if (after) after.insertAdjacentElement('afterend', edit);
        else author.appendChild(edit);
        const activate = (event) => {
          if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation();
          openQuickLabelEditor(username);
        };
        edit.addEventListener('click', activate);
        edit.addEventListener('keydown', activate);
      }
      if (LABELS.loaded && LU.shouldRefreshEmpty(row, LABELS.emptyTtlHours)) queueMissingLabel(username);
      renderCaBadge(author, username);
      queueCa(username);
    }
  }

  function removeLabelBadges() {
    closeCaPopover();
    document.querySelectorAll('.j7zh-user-label, .j7zh-label-edit, .j7zh-ca-badge').forEach((node) => node.remove());
    closeQuickLabelEditor();
    closeLabelManager();
  }
  function applyLabels() {
    document.documentElement.classList.toggle('j7zh-labels', !!S.labels);
    if (!S.labels) { removeLabelBadges(); return; }
    if (LABELS.loaded) scanLabels(document.body);
    else loadLabelState().catch(() => null);
  }

  const LABEL_MANAGER_PAGE_SIZE = 40;

  function closeLabelManager() {
    const manager = document.getElementById('j7zh-label-manager');
    if (manager) manager.remove();
  }

  function filteredManagerRows(query) {
    const q = String(query || '').trim().toLowerCase();
    return [...LABELS.map.values()].filter((row) => {
      const visible = !!displayLabel(row) || row.source === 'USER';
      if (!q) return visible;
      return row.twitterUsername.toLowerCase().includes(q) ||
        String(row.position || '').toLowerCase().includes(q) ||
        String(row.frontrunPosition || '').toLowerCase().includes(q);
    }).sort((a, b) => {
      if ((a.source === 'USER') !== (b.source === 'USER')) return a.source === 'USER' ? -1 : 1;
      return a.twitterUsername.localeCompare(b.twitterUsername);
    });
  }

  function renderLabelManager() {
    const manager = document.getElementById('j7zh-label-manager');
    if (!manager) return;
    const search = manager.querySelector('#j7zh-label-manager-search');
    const rows = filteredManagerRows(search && search.value);
    const pages = Math.max(1, Math.ceil(rows.length / LABEL_MANAGER_PAGE_SIZE));
    let page = Math.max(0, Math.min(pages - 1, Number(manager.dataset.page) || 0));
    manager.dataset.page = String(page);
    const list = manager.querySelector('.j7zh-label-manager-list');
    list.innerHTML = '';
    for (const row of rows.slice(page * LABEL_MANAGER_PAGE_SIZE, (page + 1) * LABEL_MANAGER_PAGE_SIZE)) {
      const item = document.createElement('div');
      item.className = 'j7zh-label-manager-item';
      item.dataset.username = row.twitterUsername;
      const head = document.createElement('div');
      head.className = 'j7zh-label-manager-head';
      const name = document.createElement('b');
      name.textContent = '@' + row.twitterUsername;
      const source = document.createElement('span');
      source.className = 'j7zh-label-source ' + (row.source === 'USER' ? 'is-user' : 'is-frontrun');
      source.textContent = row.source === 'USER' ? 'USER' : 'FRONTRUN';
      head.append(name, source);
      if (row.hidden === true) {
        const hidden = document.createElement('span');
        hidden.className = 'j7zh-label-hidden';
        hidden.textContent = '已隐藏';
        head.appendChild(hidden);
      }
      const line = document.createElement('div');
      line.className = 'j7zh-label-manager-edit';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 100;
      input.value = displayLabel(row);
      input.placeholder = '输入备注';
      line.appendChild(input);
      for (const action of [['save', '保存'], ['delete', '删除'], ['restore', '恢复 Frontrun']]) {
        if (action[0] === 'restore' && row.source !== 'USER') continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action[0];
        button.textContent = action[1];
        line.appendChild(button);
      }
      item.append(head, line);
      if (row.source === 'USER' && row.frontrunPosition) {
        const original = document.createElement('small');
        original.textContent = '原 Frontrun：' + row.frontrunPosition;
        item.appendChild(original);
      }
      list.appendChild(item);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'j7zh-label-manager-empty';
      empty.textContent = '没有匹配的备注';
      list.appendChild(empty);
    }
    manager.querySelector('.j7zh-label-manager-count').textContent = '共 ' + rows.length + ' 条 · 第 ' + (page + 1) + ' / ' + pages + ' 页';
    manager.querySelector('[data-page="prev"]').disabled = page <= 0;
    manager.querySelector('[data-page="next"]').disabled = page >= pages - 1;
  }

  function openLabelManager() {
    closeLabelManager();
    const manager = document.createElement('div');
    manager.id = 'j7zh-label-manager';
    manager.className = 'j7zh-label-manager';
    manager.dataset.page = '0';
    manager.innerHTML = '<div class="j7zh-label-manager-dialog"><div class="j7zh-label-manager-title"><b>编辑 Twitter 备注</b><button type="button" data-close>×</button></div><div class="j7zh-label-manager-add"><input id="j7zh-label-manager-username" type="text" placeholder="username"><input id="j7zh-label-manager-new-label" type="text" maxlength="100" placeholder="新增自定义备注"><button type="button" data-add>新增 / 保存</button></div><input id="j7zh-label-manager-search" type="search" placeholder="搜索 username 或备注"><div class="j7zh-label-manager-list"></div><div class="j7zh-label-manager-pages"><button type="button" data-page="prev">上一页</button><span class="j7zh-label-manager-count"></span><button type="button" data-page="next">下一页</button></div></div>';
    document.body.appendChild(manager);
    manager.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (event.target === manager || event.target.closest('[data-close]')) { closeLabelManager(); return; }
      const pageButton = event.target.closest('button[data-page]');
      if (pageButton) {
        manager.dataset.page = String((Number(manager.dataset.page) || 0) + (pageButton.dataset.page === 'next' ? 1 : -1));
        renderLabelManager();
        return;
      }
      if (event.target.closest('[data-add]')) {
        const username = manager.querySelector('#j7zh-label-manager-username').value;
        const value = manager.querySelector('#j7zh-label-manager-new-label').value;
        try {
          await commitLocalLabel(username, 'save', value);
          manager.querySelector('#j7zh-label-manager-username').value = '';
          manager.querySelector('#j7zh-label-manager-new-label').value = '';
          LABELS.status = '已新增用户备注';
          renderLabelPanelState();
        } catch (error) { LABELS.status = '保存失败：' + error.message; renderLabelPanelState(); }
        return;
      }
      const actionButton = event.target.closest('button[data-action]');
      const item = actionButton && actionButton.closest('.j7zh-label-manager-item');
      if (!actionButton || !item) return;
      try {
        await commitLocalLabel(item.dataset.username, actionButton.dataset.action, item.querySelector('input').value);
        LABELS.status = actionButton.dataset.action === 'save' ? '备注已保存' : actionButton.dataset.action === 'delete' ? '备注已删除并隐藏' : '已恢复 Frontrun 备注';
        renderLabelPanelState();
      } catch (error) { LABELS.status = '操作失败：' + error.message; renderLabelPanelState(); }
    });
    manager.querySelector('#j7zh-label-manager-search').addEventListener('input', () => { manager.dataset.page = '0'; renderLabelManager(); });
    manager.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeLabelManager(); });
    renderLabelManager();
    setTimeout(() => manager.querySelector('#j7zh-label-manager-search').focus(), 0);
  }

  function labelStatusText() {
    const job = LABELS.job || {};
    const queued = LABELS.missing.size + LABELS.pending.size;
    let summary = '自动累计更新 ' + LABELS.autoUpdatedCount + ' 个；待批量 ' + queued + ' 个；Cookie ' + (LABELS.configSaved ? '已保存' : '未保存');
    if (LABELS.batchDueAt > Date.now()) summary += '；约 ' + Math.ceil((LABELS.batchDueAt - Date.now()) / 1000) + ' 秒后发送';
    if (LABELS.autoPauseUntil > Date.now()) {
      const cooldownMs = LABELS.autoPauseUntil - Date.now();
      summary += cooldownMs < 120000 ? '；冷却剩余 ' + Math.ceil(cooldownMs / 1000) + ' 秒' : '；冷却剩余 ' + Math.ceil(cooldownMs / 60000) + ' 分钟';
    }
    if (LABELS.rate) summary += '；分钟余量 ' + (LABELS.rate.minuteRemaining == null ? '未知' : LABELS.rate.minuteRemaining);
    let detail = '';
    if (job.busy) detail = '全部更新中：' + (job.current || 0) + ' / ' + (job.total || LABELS.count) + '（已返回 ' + (job.updated || 0) + '）';
    else if (job.phase === 'error' && job.error) detail = '更新失败：' + job.error;
    else if (job.phase === 'done') detail = '全部更新完成：' + (job.total || LABELS.count) + ' 个 username';
    else if (LABELS.status) detail = LABELS.status;
    else if (LABELS.autoPauseUntil > Date.now() && LABELS.autoLastError) detail = LABELS.autoLastError;
    else detail = '标签 ' + LABELS.count + ' 条，有备注 ' + LABELS.nonEmpty + ' 条（用户 ' + LABELS.localCount + '）；空结果 TTL ' + LABELS.emptyTtlHours + ' 小时';
    return detail + '；' + summary;
  }

  function renderLabelPanelState() {
    const panel = document.getElementById('j7zh-label-panel');
    if (panel) panel.hidden = !S.labels;
    const status = document.getElementById('j7zh-label-status');
    if (status) textContentSafe(status, labelStatusText());
    const auto = document.getElementById('j7zh-label-auto');
    if (auto) auto.checked = LABELS.autoUpdate;
    const ttl = document.getElementById('j7zh-label-empty-ttl');
    if (ttl && document.activeElement !== ttl) ttl.value = String(LABELS.emptyTtlHours);
    const saveCookie = document.getElementById('j7zh-label-save-cookie');
    if (saveCookie) saveCookie.textContent = LABELS.configSaved ? '覆盖 Cookie' : '保存 Cookie';
    const clearCookie = document.getElementById('j7zh-label-clear-cookie');
    if (clearCookie) clearCookie.disabled = !LABELS.configSaved;
    const update = document.getElementById('j7zh-label-update-all');
    if (update) {
      update.disabled = !!LABELS.job.busy || !LABELS.configSaved;
      update.textContent = LABELS.job.busy ? '更新中…' : '全部更新';
    }
  }

  function textContentSafe(element, text) { if (element) element.textContent = String(text || ''); }

  function labelPanelHtml() {
    return '<div class="j7zh-label-panel" id="j7zh-label-panel"' + (S.labels ? '' : ' hidden') + '>' +
      '<div class="j7zh-label-actions"><button type="button" id="j7zh-label-import">导入</button><button type="button" id="j7zh-label-export">导出</button><button type="button" id="j7zh-label-manage">编辑备注</button><input id="j7zh-label-file" type="file" accept="application/json,.json" hidden></div>' +
      '<div class="j7zh-label-config"><b>从 Frontrun 更新</b><textarea id="j7zh-label-curl" rows="4" autocomplete="off" spellcheck="false" placeholder="粘贴完整 curl 命令；可保存或覆盖，Cookie 不会进入导出文件"></textarea><div class="j7zh-label-config-actions"><button type="button" id="j7zh-label-save-cookie">保存 Cookie</button><button type="button" id="j7zh-label-clear-cookie">清除 Cookie</button></div></div>' +
      '<div class="j7zh-row j7zh-label-auto-row"><label class="j7zh-label-auto-toggle"><input type="checkbox" id="j7zh-label-auto"><span class="j7zh-sw"></span><span class="j7zh-txt"><b>更新无记录博主</b><small>收集 5–10 秒后批量请求；空结果在 TTL 内不重复请求</small></span></label><label class="j7zh-label-ttl"><input type="number" id="j7zh-label-empty-ttl" min="1" max="8760" step="1" inputmode="numeric" aria-label="空结果缓存小时数"><span>小时</span></label></div>' +
      '<button type="button" class="j7zh-label-update-all" id="j7zh-label-update-all">全部更新</button>' +
      '<div class="j7zh-menu-foot j7zh-label-status" id="j7zh-label-status"></div>' +
    '</div>';
  }

  function downloadLabelRows(rows) {
    const payload = { version: 2, exportedAt: new Date().toISOString(), data: LU.normalizeRows(rows) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'j7tracker-twitter-labels-' + new Date().toISOString().slice(0, 10) + '.json';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wireLabelPanel(menu) {
    const importButton = menu.querySelector('#j7zh-label-import');
    const exportButton = menu.querySelector('#j7zh-label-export');
    const manageButton = menu.querySelector('#j7zh-label-manage');
    const fileInput = menu.querySelector('#j7zh-label-file');
    const saveButton = menu.querySelector('#j7zh-label-save-cookie');
    const clearButton = menu.querySelector('#j7zh-label-clear-cookie');
    const updateButton = menu.querySelector('#j7zh-label-update-all');
    const curlInput = menu.querySelector('#j7zh-label-curl');

    importButton.addEventListener('click', () => fileInput.click());
    manageButton.addEventListener('click', openLabelManager);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const result = await sendLabelMessage({ type: 'j7zh-labels-import', data });
        LABELS.status = '已导入 ' + result.imported + ' 条标签（同名覆盖，其余保留）';
        applyPublicLabelState(result.state);
        await loadLabelState(true);
      } catch (error) { LABELS.status = '导入失败：' + error.message; renderLabelPanelState(); }
      finally { fileInput.value = ''; }
    });

    exportButton.addEventListener('click', async () => {
      try {
        const result = await sendLabelMessage({ type: 'j7zh-labels-export' });
        downloadLabelRows(result.rows || []);
        LABELS.status = '已导出 ' + (result.rows || []).length + ' 条标签（不含 Cookie）';
        renderLabelPanelState();
      } catch (error) { LABELS.status = '导出失败：' + error.message; renderLabelPanelState(); }
    });

    saveButton.addEventListener('click', async () => {
      const command = curlInput.value.trim();
      if (!command) { LABELS.status = '请先粘贴完整 curl 命令'; renderLabelPanelState(); return; }
      saveButton.disabled = true;
      try {
        const result = await sendLabelMessage({ type: 'j7zh-label-config-save', command });
        curlInput.value = '';
        LABELS.status = (result.config.replaced ? 'Cookie 已覆盖' : 'Cookie 已保存') + '，共 ' + result.config.cookieCount + ' 项';
        applyPublicLabelState(result.state);
      } catch (error) { LABELS.status = '保存失败：' + error.message; renderLabelPanelState(); }
      finally { saveButton.disabled = false; }
    });

    clearButton.addEventListener('click', async () => {
      clearButton.disabled = true;
      try {
        const result = await sendLabelMessage({ type: 'j7zh-label-config-clear' });
        curlInput.value = '';
        clearMissingLabelQueue();
        LABELS.status = 'Cookie 已清除（移除 ' + result.config.removedCookies + ' 项）';
        applyPublicLabelState(result.state);
      } catch (error) { LABELS.status = '清除失败：' + error.message; renderLabelPanelState(); }
      finally { renderLabelPanelState(); }
    });

    updateButton.addEventListener('click', async () => {
      updateButton.disabled = true;
      try {
        const result = await sendLabelMessage({ type: 'j7zh-label-update-all' });
        LABELS.status = result.started ? '全部更新任务已开始' : '已有更新任务正在运行';
        applyPublicLabelState(result.state);
      } catch (error) { LABELS.status = '启动失败：' + error.message; renderLabelPanelState(); }
    });

    renderLabelPanelState();
    loadLabelState().catch(() => null);
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'j7zh-labels-changed') {
          mergeLabelRows(message.rows || [], false);
          applyPublicLabelState(message.state);
          scanLabels(document.body);
        } else if (message.type === 'j7zh-label-progress') {
          applyPublicLabelState(message.state);
        } else if (message.type === 'j7zh-ca-changed') {
          for (const row of message.rows || []) {
            if (row && row.username) CA.map.set(String(row.username).toLowerCase(), row);
          }
          scanLabels(document.body);
        }
      });
    }
  } catch (e) {}

  /* ---------- 观察器（同步处理，后台标签页里 rAF 不触发） ---------- */
  function handleNode(n) {
    try {
      if (!n.isConnected) return;
      if (n.nodeType === 3) { if (S.ui) processTextNode(n); return; }
      if (n.nodeType !== 1) return;
      if (isOurs(n)) return;
      if (S.ui) walk(n);
      if (S.trans || S.copykw || S.labels) scheduleScan(n.closest ? (n.closest('.tweet-embed') || n) : n);
    } catch (e) { /* 单个节点出错不影响其它 */ }
  }

  function startObserver() {
    const mo = new MutationObserver((records) => {
      try {
        for (const r of records) {
          if (r.type === 'childList') {
            r.addedNodes.forEach(handleNode);
            // 正文被 React 重绘时可能把我们的译文块一起拿掉，补一次
            if (S.trans && r.removedNodes.length && r.target && r.target.closest && r.target.closest('.tweet-embed')) scheduleScan(r.target.closest('.tweet-embed'));
          } else if (r.type === 'characterData') {
            if (S.ui) handleNode(r.target);
            if (S.trans && r.target.parentElement && r.target.parentElement.closest('.tweet-embed')) scheduleScan(r.target.parentElement.closest('.tweet-embed'));
          } else if (r.type === 'attributes') {
            if (S.ui && r.target.nodeType === 1) processAttrs(r.target);
          }
        }
      } catch (e) { console.error('[j7zh] observer failed', e); }
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
    window.__j7zh.observer = mo;
  }

  /* ---------- 阅读模式 ---------- */
  function applyReader() {
    document.documentElement.classList.toggle('j7zh-reader', !!S.reader);
  }
  function applyTransFlag() {
    document.documentElement.classList.toggle('j7zh-notrans', !S.trans);
  }

  /* ---------- 右下角按钮 + 菜单 ---------- */
  function mountToggle() {
    if (document.getElementById('j7zh-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'j7zh-toggle';
    btn.type = 'button';
    btn.textContent = '中';
    btn.title = 'J7 中文扩展：界面汉化 / 阅读模式 / 正文翻译 / Twitter 标签';
    btn.setAttribute('data-on', S.ui ? '1' : '0');
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    (document.body || document.documentElement).appendChild(btn);
  }

  function toggleMenu() {
    let m = document.getElementById('j7zh-menu');
    if (m) { m.remove(); closeQuickLabelEditor(); closeLabelManager(); return; }
    m = document.createElement('div');
    m.id = 'j7zh-menu';
    m.innerHTML = [
      '<div class="j7zh-menu-title">J7 中文扩展</div>',
      row('ui', '界面汉化', '按钮、菜单、设置项翻成中文（切换会刷新页面）'),
      row('reader', '阅读模式', '卡片收窄居中、图片缩小、行距放宽'),
      row('trans', '正文翻译', '推文 / 引用 / 回复正文翻成中文，附在原文下方'),
      row('copykw', '点击关键词复制', '点推文里的高亮关键词（AI 预测名、关键词、CA）即复制'),
      row('gmgn', '复制后 GMGN 搜索', '后台打开/复用 GMGN 标签页并搜索该词，不切走当前页面'),
      row('labels', 'Twitter 标签备注', '在推文作者 username 后显示本地 position 标签'),
      labelPanelHtml(),
      '<div class="j7zh-row j7zh-row-sel"><span class="j7zh-txt"><b>翻译引擎</b><small>本地 = Chrome 内置离线翻译（快、无限流，需 Chrome 138+）；Google = 网页翻译接口（可能限流）</small></span>' +
        '<select id="j7zh-engine">' +
          '<option value="auto"' + (S.engine === 'auto' ? ' selected' : '') + '>自动（本地优先）</option>' +
          '<option value="local"' + (S.engine === 'local' ? ' selected' : '') + (LOCAL.ok ? '' : ' disabled') + '>仅本地</option>' +
          '<option value="google"' + (S.engine === 'google' ? ' selected' : '') + '>仅 Google</option>' +
        '</select></div>',
      '<div class="j7zh-menu-foot" id="j7zh-status">' + statusText() + '</div>',
      '<div class="j7zh-menu-foot">漏翻的界面文字可在 dict.js 里补</div>'
    ].join('');
    function row(key, name, desc) {
      return '<label class="j7zh-row"><input type="checkbox" data-key="' + key + '"' + (S[key] ? ' checked' : '') + '><span class="j7zh-sw"></span><span class="j7zh-txt"><b>' + name + '</b><small>' + desc + '</small></span></label>';
    }
    ['click', 'pointerdown', 'mousedown', 'keydown', 'keyup'].forEach((t) => m.addEventListener(t, (e) => e.stopPropagation()));
    m.addEventListener('change', (e) => {
      const inp = e.target;
      if (inp && inp.id === 'j7zh-label-auto') {
        LABELS.autoUpdate = !!inp.checked;
        if (!LABELS.autoUpdate) clearMissingLabelQueue();
        sendLabelMessage({ type: 'j7zh-label-auto-set', enabled: LABELS.autoUpdate }).then((result) => {
          LABELS.status = LABELS.autoUpdate ? '无记录博主自动更新已开启' : '无记录博主自动更新已关闭';
          applyPublicLabelState(result.state);
          if (LABELS.autoUpdate) scanLabels(document.body);
        }).catch((error) => { LABELS.status = '设置失败：' + error.message; renderLabelPanelState(); });
        return;
      }
      if (inp && inp.id === 'j7zh-label-empty-ttl') {
        const hours = LU.normalizeEmptyTtlHours(inp.value);
        inp.value = String(hours);
        sendLabelMessage({ type: 'j7zh-label-ttl-set', hours }).then((result) => {
          LABELS.status = '空结果缓存时间已设为 ' + hours + ' 小时';
          applyPublicLabelState(result.state);
        }).catch((error) => { LABELS.status = '设置失败：' + error.message; renderLabelPanelState(); });
        return;
      }
      if (inp && inp.id === 'j7zh-engine') {
        S.engine = inp.value; try { localStorage.setItem(LS.engine, S.engine); } catch (err) {}
        // 换引擎：清掉已有译文重翻，方便对比
        TR.cache.clear(); TR.failed.clear(); TR.queue.length = 0; TR.queued.clear(); TR.pauseUntil = 0; TR.backoff = 0;
        try { localStorage.removeItem(CACHE_LS); } catch (err) {}
        document.querySelectorAll('.j7zh-trans').forEach((b) => b.remove());
        document.querySelectorAll('[data-j7zh-key]').forEach((u) => u.removeAttribute('data-j7zh-key'));
        setStatus('idle');
        if (S.trans) scheduleScan(document.body);
        return;
      }
      if (!(inp && inp.dataset && inp.dataset.key)) return;
      const k = inp.dataset.key;
      S[k] = !!inp.checked;
      setFlag(LS[k], S[k]);
      if (k === 'ui') { location.reload(); return; }
      if (k === 'reader') applyReader();
      if (k === 'copykw') applyCopyKw();
      if (k === 'trans') { applyTransFlag(); setStatus(TR.status); if (S.trans) scheduleScan(document.body); }
      if (k === 'labels') { applyLabels(); renderLabelPanelState(); }
    });
    (document.body || document.documentElement).appendChild(m);
    wireLabelPanel(m);
    // 点菜单外面 / 按 Esc 关闭；点菜单内部（开关、下拉框）不关
    const close = (ev) => {
      const mm = document.getElementById('j7zh-menu');
      if (!mm) { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close, true); return; }
      if (ev.type === 'keydown') {
        if (ev.key !== 'Escape') return;
        if (document.getElementById('j7zh-label-manager') || document.getElementById('j7zh-label-editor')) return;
      } else if (mm.contains(ev.target) || (ev.target.closest && ev.target.closest('#j7zh-toggle, .j7zh-label-manager, .j7zh-label-editor'))) return;
      mm.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
    };
    setTimeout(() => { document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', close, true); }, 0);
  }

  /* ---------- 启动 ---------- */
  // 调试钩子（控制台可用 __j7zh.walk(document.body) 手动补扫，__j7zh.scan() 重扫翻译）
  window.__j7zh = { walk, lookup, settings: S, version: '1.9.0', scan: () => scanUnits(document.body), labels: LABELS, scanLabels: () => scanLabels(document.body), tr: TR, local: LOCAL, engine: engineInUse, lastErr: null };

  document.addEventListener('pointerdown', () => { try { if (LOCAL.ok) LOCAL.retryOnGesture(); } catch (e) {} }, true);
  document.addEventListener('keydown', () => { try { if (LOCAL.ok) LOCAL.retryOnGesture(); } catch (e) {} }, true);

  function firstPass() {
    mountToggle();
    applyReader();
    applyTransFlag();
    applyCopyKw();
    applyLabels();
    if (S.ui) { try { walk(document.body); } catch (e) { console.error('[j7zh] walk failed', e); } }
    if (S.trans) scheduleScan(document.body);
  }

  function boot() {
    firstPass();
    startObserver();
    setTimeout(firstPass, 800);
    setTimeout(firstPass, 3000);
    // 兜底：每 4 秒把缓存里已有的译文补回被重绘掉的卡片（只查 DOM，不发请求）
    setInterval(() => { tagKeywords(document.body); if (S.trans) scanUnits(document.body); if (S.labels) scanLabels(document.body); }, 4000);
  }

  if (document.readyState === 'loading') {
    startObserver();
    document.addEventListener('DOMContentLoaded', () => {
      firstPass();
      setTimeout(firstPass, 800);
      setTimeout(firstPass, 3000);
      setInterval(() => { tagKeywords(document.body); if (S.trans) scanUnits(document.body); if (S.labels) scanLabels(document.body); }, 4000);
    });
  } else {
    boot();
  }
})();
