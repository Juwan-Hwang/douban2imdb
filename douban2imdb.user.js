// ==UserScript==
// @name         豆瓣「看过」→ IMDb 同步 (Douban → IMDb)
// @namespace    https://github.com/Juwan-Hwang/douban2imdb
// @version      1.0.0
// @homepageURL  https://github.com/Juwan-Hwang/douban2imdb
// @supportURL   https://github.com/Juwan-Hwang/douban2imdb/issues
// @updateURL    https://raw.githubusercontent.com/Juwan-Hwang/douban2imdb/main/douban2imdb.user.js
// @downloadURL  https://raw.githubusercontent.com/Juwan-Hwang/douban2imdb/main/douban2imdb.user.js
// @description  把豆瓣「看过/在看/想看」列表逐条同步到 IMDb（标记看过 + 按 星×2−1 打分）。优先用豆瓣条目页内嵌的 IMDb 编号做权威匹配，其次用 IMDb suggest 相关度+年份兜底。逻辑移植自已验证的迁移脚本。仅供个人自用。
// @author       Juwan-Hwang
// @match        https://movie.douban.com/mine*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      movie.douban.com
// @connect      www.imdb.com
// @connect      api.graphql.imdb.com
// @connect      v3.sg.media-imdb.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 合规提示：抓取豆瓣、自动化写入 IMDb 可能违反双方服务条款（IMDb 内部 API 明确禁止
 * 公开/商业/非私人用途）。本脚本仅供你同步“自己的”账号数据使用；脚本不含任何账号/Cookie，
 * 全部复用你当前浏览器的登录态。请先在浏览器分别登录豆瓣与 IMDb。
 */

(function () {
  'use strict';

  // ============================ 配置（集中，坏了自己改） ============================
  const CFG = {
    listBase: 'https://movie.douban.com/mine',   // ?status=collect|mark|wish
    statuses: { collect: '看过', mark: '在看', wish: '想看' },
    pageStep: 15,          // 豆瓣列表每页条数
    maxPages: 80,          // 抓取页数上限（安全阀）
    delayMs: 600,          // 每次网络操作之间的间隔，降低限流
    storePrefix: 'd2i_v1_',// localStorage 前缀（按状态分开续跑）
  };
  const RATING = (stars) => (stars > 0 ? stars * 2 - 1 : 0); // 豆瓣星(1-5) → IMDb(2-10)；0=未评分

  const IMDB_HEADERS = {
    'content-type': 'application/json',
    'accept': 'application/graphql+json, application/json',
    'x-imdb-client-name': 'imdb-web-next',
    'x-imdb-consent-info': 'eyJhZ2VTaWduYWwiOiJBRFVMVCIsImlzR2RwciI6ZmFsc2V9',
    'x-imdb-user-country': 'CN',
    'x-imdb-user-language': 'zh-CN',
    'origin': 'https://www.imdb.com',
    'referer': 'https://www.imdb.com/',
  };
  const ADD_W = 'mutation AddWatchedTitle($titleId: ID!) { addWatchedTitle(titleId: $titleId) { success } }';
  const RATE = 'mutation UpdateTitleRating($rating: Int!, $titleId: ID!) { rateTitle(input: {rating: $rating, titleId: $titleId}) { rating { value } } }';
  const MOVIE_KINDS = { feature: 1, tvMovie: 1, tvSeries: 1, tvMiniSeries: 1, tvSpecial: 1, tvShort: 1 };

  // 正则（用 \u 转义，避免源码里出现字面 CJK/组合字符）
  const RE_CJK = /[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff]/;
  const RE_LATENESS = /[A-Za-z]{3,}/;

  // ============================ 网络（GM_xmlhttpRequest 封装） ============================
  function xhr(url, opt = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opt.method || 'GET', url,
        headers: opt.headers || {}, timeout: opt.timeout || 30000,
        data: opt.body,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('net:' + url)),
        ontimeout: () => reject(new Error('timeout:' + url)),
      });
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function getHTML(url) { const r = await xhr(url); return r.text; }
  async function getJSON(url) { const r = await xhr(url); try { return JSON.parse(r.text); } catch (e) { return null; } }

  // ============================ 归一化（去变音符，来自已验证逻辑） ============================
  function norm(s) {
    return (s || '').toLowerCase().normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  // ============================ 豆瓣列表解析（移植自 crawl.js） ============================
  function parseList(html, gseen) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    doc.querySelectorAll('li.title').forEach((li) => {
      const a = li.querySelector('a[href*="/subject/"]'); if (!a) return;
      const m = a.href.match(/subject\/(\d+)/); const sid = m ? m[1] : '';
      if (!sid || gseen[sid]) return; gseen[sid] = 1;
      const em = a.querySelector('em');
      const primary = (em ? em.textContent : a.textContent).replace(/\s+/g, ' ').trim();
      const title = a.textContent.replace(/\s+/g, ' ').trim();
      const row = li.parentElement;
      const intro = row ? row.querySelector('li.intro') : null;
      const introTxt = intro ? intro.textContent.replace(/\s+/g, ' ').trim() : '';
      const ym = introTxt.match(/(19|20)\d{2}/); const year = ym ? ym[0] : '';
      const rate = row ? row.querySelector('[class*="rating"]') : null; let db = 0;
      if (rate) { const cm = rate.className.match(/rating(\d+)/); if (cm) db = parseInt(cm[1], 10); }
      items.push({ sid, primary, title, year, db });
    });
    return items;
  }

  // 标题分段（移植自 prep.ps1）：cn=首段，orig=首个拉丁段，q=orig||cn
  function prep(it) {
    const segs = it.title.split(' / ').map((s) => s.trim()).filter(Boolean);
    const cn = segs[0] || it.primary;
    const latin = segs.filter((s) => RE_LATENESS.test(s) && !RE_CJK.test(s));
    const orig = latin[0] || '';
    const q = orig || cn;
    return Object.assign({}, it, { cn, orig, q, imdb: RATING(it.db) });
  }

  // ============================ 豆瓣条目页：抽 IMDb 编号 + 英文又名（移植自 resolve_final） ============================
  function parseSubject(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const info = ((doc.querySelector('#info') || {}).textContent || '').replace(/\s+/g, ' ');
    const m = info.match(/IMDb[^\d]{0,12}(tt\d{7,9})/i); const imdbId = m ? m[1] : '';
    let alt = ''; const ai = info.indexOf('又名');
    if (ai >= 0) {
      for (const raw of info.slice(ai + 2).split('/')) {
        const x = raw.trim().replace(/IMDb.*$/i, '').trim();
        if (RE_LATENESS.test(x) && !RE_CJK.test(x)) { alt = x; break; }
      }
    }
    return { imdbId, alt };
  }

  // ============================ IMDb suggest + 匹配（移植自 resolve.js） ============================
  async function suggest(term) {
    const j = await getJSON('https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(term) + '.json?includeVideos=0');
    return ((j && j.d) || []).filter((x) => x.id && /^tt\d+$/.test(x.id));
  }
  async function matchTerms(terms, it) {
    const cand = {}, order = [];
    for (const t of terms) {
      let ds = []; try { ds = await suggest(t); } catch (e) { }
      for (const d of ds) { if (!cand[d.id]) { cand[d.id] = { id: d.id, y: d.y, q: d.q, l: d.l }; order.push(d.id); } }
      await sleep(120);
    }
    const my = parseInt(it.year, 10) || 0;
    const yr = order.map((id) => cand[id]).filter((c) => my && (parseInt(c.y, 10) || 0) === my);
    const feats = yr.filter((c) => MOVIE_KINDS[c.q]);
    const pool = feats.length ? feats : yr;
    let pick = null;
    if (pool.length === 1) pick = pool[0];
    else if (pool.length > 1) { const tn = {}; terms.forEach((t) => { tn[norm(t)] = 1; }); const nm = pool.filter((c) => tn[norm(c.l)]); if (nm.length === 1) pick = nm[0]; }
    if (!pick && my) { const yrOrd = order.map((id) => cand[id]).filter((c) => (parseInt(c.y, 10) || 0) === my); const yf = yrOrd.filter((c) => MOVIE_KINDS[c.q]); const top = (yf.length ? yf : yrOrd)[0]; if (top) pick = top; }
    return pick ? pick.id : null;
  }
  async function resolveOne(it) {
    let imdbId = '', alt = '';
    try { const s = parseSubject(await getHTML('https://movie.douban.com/subject/' + it.sid + '/')); imdbId = s.imdbId; alt = s.alt; } catch (e) { }
    if (imdbId) return { id: imdbId, src: 'douban-imdbid' };
    const terms = [...new Set([alt, it.cn, it.q, it.orig].filter(Boolean))];
    const id = await matchTerms(terms, it);
    return id ? { id, src: 'suggest' } : { id: null, src: 'none' };
  }

  // ============================ IMDb 写入 ============================
  async function gql(op, query, vars) {
    const r = await xhr('https://api.graphql.imdb.com/', { method: 'POST', headers: IMDB_HEADERS, body: JSON.stringify({ query, operationName: op, variables: vars }) });
    let j; try { j = JSON.parse(r.text); } catch (e) { j = {}; }
    return { status: r.status, json: j };
  }
  function gqlErr(json) {
    if (json && json.errors && json.errors.length) { const e = json.errors[0] || {}; return String(e.message || e.code || (e.extensions && e.extensions.code) || 'error').slice(0, 160); }
    return '';
  }
  const looksAuth = (msg) => /unauthor|not logged|please log|log ?in|sign ?in|authenticat|session|permission|forbidden|credential|csrf|token/i.test(msg || '');
  async function writeImdb(id, score) {
    const w = await gql('AddWatchedTitle', ADD_W, { titleId: id });
    const okW = w.json && w.json.data && w.json.data.addWatchedTitle && w.json.data.addWatchedTitle.success;
    let err = okW ? '' : (gqlErr(w.json) || ('HTTP ' + w.status));
    let authFail = !okW && (w.status === 401 || w.status === 403 || looksAuth(err));
    let rate = 'n/a';
    if (score > 0) { const rt = await gql('UpdateTitleRating', RATE, { rating: score, titleId: id }); const okR = rt.json && rt.json.data && rt.json.data.rateTitle; rate = (rt.status === 200 && okR) ? 'ok' : 'ERR'; if (rate === 'ERR') { const re = gqlErr(rt.json); if (!err) err = re; if (looksAuth(re)) authFail = true; } }
    return { watch: okW ? 'ok' : ('fail' + w.status), rate, err, authFail };
  }
  async function imdbLoggedIn() {
    try { const html = await getHTML('https://www.imdb.com/'); if (/imdb-header__account-toggle--logged-in/i.test(html)) return true; if (/imdb-header__account-toggle/i.test(html)) return false; return null; } catch (e) { return null; }
  }

  // ============================ 进度 / 列表缓存（断点续跑 + 免重复爬取） ============================
  const loadProg = (st) => { try { return JSON.parse(localStorage.getItem(CFG.storePrefix + st) || '{}'); } catch (e) { return {}; } };
  const saveProg = (st, p) => localStorage.setItem(CFG.storePrefix + st, JSON.stringify(p));
  const loadList = (st) => { try { return JSON.parse(localStorage.getItem(CFG.storePrefix + 'list_' + st) || 'null'); } catch (e) { return null; } };
  const saveList = (st, arr) => { try { localStorage.setItem(CFG.storePrefix + 'list_' + st, JSON.stringify(arr)); } catch (e) { } };

  // ============================ 主流程 ============================
  let stopped = false;
  function unloadGuard(e) { e.preventDefault(); e.returnValue = ''; return ''; }
  function markRunning(st, dry) { if (!dry) { localStorage.setItem(CFG.storePrefix + 'running', st); } window.addEventListener('beforeunload', unloadGuard); }
  function clearRunning() { localStorage.removeItem(CFG.storePrefix + 'running'); window.removeEventListener('beforeunload', unloadGuard); }
  async function run(status, dryRun, forceRefresh, log, done, ui) {
    ui = ui || { start() { }, stop() { }, phase() { }, set() { }, work() { }, status() { } };
    stopped = false;
    markRunning(status, dryRun);
    ui.start(); ui.status('运行中', 'run');
    try {
      const P = loadProg(status);
      log('开始：豆瓣「' + CFG.statuses[status] + '」' + (dryRun ? '（试运行，不写入）' : '（写入 IMDb）'), 'info');

      // 0) 登录状态（非试运行）：仅提示、不阻断；真正未登录会在写入阶段自动停止
      ui.phase(1, 3, '连接 IMDb', 1);
      if (!dryRun) {
        const lg = await imdbLoggedIn();
        if (lg === true) log('✓ 已检测到 IMDb 登录', 'ok');
        else if (lg === false) log('⚠ 似乎未登录 IMDb，先继续尝试；若确实未登录，写入时会自动停止并提示', 'warn');
        else log('· 未能确认登录状态，继续尝试', 'dim');
      }

      // 1) 抓取列表（有缓存则复用）
      ui.phase(1, 3, '抓取豆瓣列表', 0.7);
      let all = forceRefresh ? null : loadList(status);
      if (all && all.length) { log('· 使用已缓存列表 ' + all.length + ' 条', 'dim'); ui.set(all.length, all.length); }
      else {
        all = []; const gseen = {}; let estPages = CFG.maxPages;
        for (let start = 0, page = 0; page < CFG.maxPages; page++, start += CFG.pageStep) {
          if (stopped) break;
          let items = [], html = '';
          try { html = await getHTML(CFG.listBase + '?status=' + status + '&start=' + start); items = parseList(html, gseen); } catch (e) { log('抓取中断：' + e.message, 'err'); break; }
          if (page === 0) { const tm = html.match(/\((\d{1,5})\)/); if (tm) { const tot = parseInt(tm[1], 10); if (tot > 0) estPages = Math.min(CFG.maxPages, Math.ceil(tot / CFG.pageStep)); } }
          if (!items.length) break;
          all = all.concat(items); ui.set(page + 1, estPages); log('· 已抓取 ' + all.length + ' 条…', 'dim');
          await sleep(CFG.delayMs);
        }
        saveList(status, all);
        log('· 列表共 ' + all.length + ' 条（已缓存）', 'dim');
      }

      // 2) 匹配（解析每部 → IMDb id）
      const doneCnt = Object.values(P).filter((r) => r.watch === 'ok' || r.dry).length;
      if (doneCnt) log('⟳ 检测到已有进度：已完成 ' + doneCnt + ' 条，将跳过并从断点继续（本组共 ' + all.length + ' 条）', 'info');
      ui.phase(2, 3, '匹配 IMDb', 1.8);
      let mi = 0;
      for (const raw of all) {
        if (stopped) break;
        const it = prep(raw); const ex = P[it.sid];
        if (ex && (ex.watch === 'ok' || ex.dry || ex.id)) { mi++; ui.set(mi, all.length); continue; }
        const _t = performance.now(); const r = await resolveOne(it); ui.work((performance.now() - _t) / 1000);
        const rec = { sid: it.sid, cn: it.cn, q: it.q, year: it.year, db: it.db, imdb: it.imdb, id: r.id, src: r.src, watch: '', rate: '', err: '' };
        if (!r.id) { rec.watch = 'nomatch'; log('✗ 未匹配 ' + (mi + 1) + '/' + all.length + '：' + it.cn + ' [' + it.year + ']', 'warn'); }
        else { if (dryRun) { rec.watch = 'dry'; rec.dry = true; } log('✓ 匹配 ' + (mi + 1) + '/' + all.length + '：' + it.cn + ' → ' + r.id + ' (' + r.src + ')', 'ok'); }
        P[it.sid] = rec; saveProg(status, P); mi++; ui.set(mi, all.length);
        await sleep(120);
      }

      if (dryRun) { const m = Object.values(P).filter((r) => r.dry).length; ui.phase(3, 3, '完成', 1); ui.set(1, 1); ui.status('试运行完成', 'done'); done('试运行结束：匹配到 ' + m + ' 条（未写入 IMDb）。'); return P; }

      // 3) 写入 IMDb
      ui.phase(3, 3, '写入 IMDb', 1.5);
      const wTotal = all.filter((raw) => { const rr = P[String(raw.sid)]; return rr && rr.id && rr.watch !== 'ok'; }).length;
      log('· 进入写入阶段，待写 ' + wTotal + ' 条', 'dim');
      let okCnt = 0, skipCnt = 0, consecFail = 0, abortReason = '', wi = 0;
      for (const raw of all) {
        if (stopped) { log('已停止', 'warn'); ui.status('已停止', 'warn'); break; }
        const it = prep(raw); const rec = P[it.sid];
        if (!rec || !rec.id || rec.watch === 'ok') continue;
        wi++; ui.set(wi, wTotal || 1);
        const _t2 = performance.now(); const w = await writeImdb(rec.id, rec.imdb || 0); ui.work((performance.now() - _t2) / 1000);
        rec.watch = w.watch; rec.rate = w.rate; rec.err = w.err || '';
        if (w.watch === 'ok') { okCnt++; consecFail = 0; log('✓ 写入 ' + wi + '/' + wTotal + '：' + it.cn + ' → ' + rec.id + ' 看过=ok 评分=' + w.rate, 'ok'); }
        else {
          skipCnt++; consecFail++; log('✗ ' + it.cn + ' → ' + rec.id + ' 写入失败：' + (w.err || w.watch), 'err');
          if (w.authFail) { abortReason = 'auth'; ui.status('未登录 IMDb', 'err'); log('⚠ 疑似未登录 IMDb / 登录已失效（' + (w.err || '') + '）。已自动停止——请先登录 https://www.imdb.com/ 后再点“开始”续跑。', 'err'); P[it.sid] = rec; saveProg(status, P); break; }
          if (consecFail >= 3) { abortReason = 'fails'; ui.status('已暂停', 'warn'); log('⚠ 连续 3 次写入失败，已暂停（可能被限流或 IMDb 接口变动）。稍等片刻再点“开始”续跑。', 'warn'); P[it.sid] = rec; saveProg(status, P); break; }
        }
        P[it.sid] = rec; saveProg(status, P);
        await sleep(CFG.delayMs);
      }
      const tail = abortReason === 'auth' ? '（因未登录 IMDb 中止）' : abortReason === 'fails' ? '（因连续失败暂停）' : '';
      if (!abortReason && !stopped) ui.status('已完成', 'done');
      done('结束' + tail + '：成功 ' + okCnt + '，失败 ' + skipCnt + '。点“导出CSV”下载明细。');
      return P;
    } catch (e) { ui.status('出错', 'err'); log('运行出错：' + (e && e.message ? e.message : e), 'err'); throw e; }
    finally { ui.stop(); clearRunning(); }
  }

  // ============================ CSV 导出 / 导入 ============================
  function toCSV(prog) {
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['douban_sid', 'douban_title', 'original_title', 'year', 'douban_stars', 'imdb_score', 'imdb_id', 'match_src', 'watch', 'rate', 'imdb_url'];
    const rows = [head.join(',')];
    Object.values(prog).forEach((r) => rows.push([r.sid, r.cn, r.q, r.year, r.db, r.imdb, r.id, r.src, r.watch, r.rate, r.id ? 'https://www.imdb.com/title/' + r.id + '/' : ''].map(esc).join(',')));
    return rows.join('\n');
  }
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { q = false; } } else { cur += c; } }
      else if (c === '"') { q = true; }
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') { cur += c; }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function importCSV(text) {
    const rows = parseCSV(text); if (rows.length < 2) return { added: 0, recs: {} };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (n) => head.indexOf(n);
    if (col('douban_sid') < 0) return { added: 0, recs: {} };
    const recs = {};
    for (let r = 1; r < rows.length; r++) {
      const v = rows[r]; const sid = (v[col('douban_sid')] || '').trim(); if (!sid) continue;
      recs[sid] = { sid, cn: v[col('douban_title')], q: v[col('original_title')], year: v[col('year')], db: +(v[col('douban_stars')] || 0), imdb: +(v[col('imdb_score')] || 0), id: v[col('imdb_id')], src: v[col('match_src')], watch: v[col('watch')], rate: v[col('rate')] };
    }
    return { added: Object.keys(recs).length, recs };
  }

  // ============================ UI 面板 ============================
  function mount() {
    if (!/movie\.douban\.com/.test(location.host) || !/^\/mine\/?$/.test(location.pathname)) return;
    if (document.getElementById('d2i_box')) return;
    if (!document.getElementById('d2i_style')) { const st = document.createElement('style'); st.id = 'd2i_style'; st.textContent = '@keyframes d2ipulse{0%{box-shadow:0 0 0 0 rgba(59,139,84,.6)}70%{box-shadow:0 0 0 7px rgba(59,139,84,0)}100%{box-shadow:0 0 0 0 rgba(59,139,84,0)}}'; document.head.appendChild(st); }
    const box = document.createElement('div'); box.id = 'd2i_box';
    box.style.cssText = 'position:fixed;top:80px;right:16px;z-index:2147483647;pointer-events:auto;background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:10px;padding:12px 14px;font:13px/1.5 system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.5);width:300px';

    const title = document.createElement('div'); title.textContent = '豆瓣 → IMDb 同步（可拖动）'; title.style.cssText = 'font-weight:700;margin-bottom:6px;cursor:move;user-select:none'; box.appendChild(title);
    const warn = document.createElement('div'); warn.textContent = '⚠️ 同步进行中：请勿刷新或切换页面！(离开会中断；回到本页会自动续跑)'; warn.style.cssText = 'display:none;background:#5a2323;color:#ffd9d9;border:1px solid #a04040;border-radius:6px;padding:6px;margin-bottom:6px;font-size:12px'; box.appendChild(warn);

    const row1 = document.createElement('div'); row1.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
    const sel = document.createElement('select'); sel.id = 'd2i_status'; sel.style.cssText = 'flex:1;background:#222;color:#eee;border:1px solid #555;border-radius:5px;padding:4px';
    Object.entries(CFG.statuses).forEach(([k, v]) => { const o = document.createElement('option'); o.value = k; o.textContent = v; sel.appendChild(o); });
    const dryWrap = document.createElement('label'); dryWrap.style.cssText = 'white-space:nowrap;cursor:pointer;display:flex;align-items:center;gap:4px';
    const dry = document.createElement('input'); dry.type = 'checkbox'; dry.id = 'd2i_dry'; dry.style.cssText = 'width:16px;height:16px;cursor:pointer';
    dryWrap.appendChild(dry); dryWrap.appendChild(document.createTextNode('试运行'));
    const refWrap = document.createElement('label'); refWrap.style.cssText = 'white-space:nowrap;cursor:pointer;display:flex;align-items:center;gap:4px';
    const ref = document.createElement('input'); ref.type = 'checkbox'; ref.id = 'd2i_refresh'; ref.style.cssText = 'width:16px;height:16px;cursor:pointer';
    refWrap.appendChild(ref); refWrap.appendChild(document.createTextNode('刷新列表'));
    row1.appendChild(sel); row1.appendChild(dryWrap); row1.appendChild(refWrap); box.appendChild(row1);

    const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap';
    const btn = (id, txt, bg) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.textContent = txt; b.style.cssText = 'background:' + bg + ';color:#fff;border:0;border-radius:5px;padding:6px 8px;cursor:pointer;pointer-events:auto'; return b; };
    const start = btn('d2i_start', '开始', '#3b8b54'); start.style.flex = '1';
    const stop = btn('d2i_stop', '停止', '#7a3b3b');
    const csv = btn('d2i_csv', '导出CSV', '#37536e');
    const reset = btn('d2i_reset', '重置', '#555');
    const imp = btn('d2i_import', '导入CSV', '#6e5a37');
    [start, stop, csv, imp, reset].forEach((b) => row2.appendChild(b)); box.appendChild(row2);

    const statBadge = document.createElement('div'); statBadge.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px/1.4 system-ui,Arial;margin-bottom:6px;color:#ccc'; const statDot = document.createElement('span'); statDot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#888;display:inline-block;flex:0 0 auto'; const statTxt = document.createElement('span'); statTxt.textContent = '空闲'; statBadge.appendChild(statDot); statBadge.appendChild(statTxt); box.appendChild(statBadge);
    const barTrack = document.createElement('div'); barTrack.style.cssText = 'height:9px;background:#333;border-radius:5px;overflow:hidden;margin-bottom:4px'; const barFill = document.createElement('div'); barFill.style.cssText = 'height:100%;width:0%;background:#3b8b54;transition:width .3s'; barTrack.appendChild(barFill); box.appendChild(barTrack);
    const statusLine = document.createElement('div'); statusLine.style.cssText = 'font:11px/1.4 monospace;color:#bbb;margin-bottom:6px'; statusLine.textContent = '就绪'; box.appendChild(statusLine);
    const logEl = document.createElement('div'); logEl.id = 'd2i_log'; logEl.style.cssText = 'height:150px;overflow:auto;background:#0d0d0d;border:1px solid #333;border-radius:6px;padding:6px;font:11px/1.45 monospace;white-space:pre-wrap'; box.appendChild(logEl);
    document.body.appendChild(box);

    const LOGC = { info: '#dcdcdc', ok: '#7fd18a', warn: '#ffcf6b', err: '#ff8a8a', dim: '#8f8f8f' };
    const log = (m, level) => { const d = document.createElement('div'); d.style.color = LOGC[level] || LOGC.info; d.textContent = m; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; };
    const SC = { idle: '#888', run: '#3b8b54', done: '#37536e', warn: '#c98a2b', err: '#c0392b' };
    const setStatus = (txt, kind) => { kind = kind || 'idle'; statTxt.textContent = txt; statDot.style.background = SC[kind] || SC.idle; statDot.style.animation = kind === 'run' ? 'd2ipulse 1.2s infinite' : 'none'; };
    const setBusy = (b) => { start.disabled = b; warn.style.display = b ? 'block' : 'none'; if (b) setStatus('运行中', 'run'); };
    let pStart = 0, pPhaseStart = 0, pIdx = 1, pTot = 3, pName = '', pDone = 0, pTotal = 0, pBase = 1, pWorkTime = 0, pWorkCount = 0, pTimer = null;
    const fmtT = (sec) => { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60, p = (n) => (n < 10 ? '0' : '') + n; return (h ? h + ':' + p(m) : m) + ':' + p(s); };
    const renderProg = () => { barFill.style.width = (pTotal ? Math.round(pDone / pTotal * 100) : 0) + '%'; const now = performance.now(); const el = (now - pStart) / 1000; const per = (pWorkTime + pBase * 2) / (pWorkCount + 2); let rem = '--:--'; if (pTotal) rem = fmtT(Math.max(0, pTotal - pDone) * per); statusLine.textContent = '阶段 ' + pIdx + '/' + pTot + '：' + pName + '　' + pDone + '/' + pTotal + '　已用 ' + fmtT(el) + '　预计还需 ' + rem; };
    const ui = { start() { pStart = performance.now(); pPhaseStart = pStart; if (!pTimer) pTimer = setInterval(renderProg, 400); renderProg(); }, stop() { if (pTimer) { clearInterval(pTimer); pTimer = null; } }, phase(i, t, name, base) { pIdx = i; pTot = t; pName = name; pBase = base || 1; pDone = 0; pTotal = 0; pWorkTime = 0; pWorkCount = 0; pPhaseStart = performance.now(); renderProg(); }, set(d, t) { pDone = d; pTotal = t; renderProg(); }, work(sec) { pWorkTime += sec; pWorkCount++; renderProg(); }, status(txt, kind) { setStatus(txt, kind); } };

    // 可拖动（避开页面右下角的悬浮控件遮挡）
    let drag = null;
    title.addEventListener('mousedown', (e) => { drag = { x: e.clientX - box.offsetLeft, y: e.clientY - box.offsetTop }; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (drag) { box.style.left = (e.clientX - drag.x) + 'px'; box.style.top = (e.clientY - drag.y) + 'px'; box.style.right = 'auto'; } });
    window.addEventListener('mouseup', () => { drag = null; });

    // 事件 + 点击反馈
    dry.addEventListener('change', () => log('试运行：' + (dry.checked ? '开（只解析不写入）' : '关（将写入 IMDb）')));
    start.addEventListener('click', async () => {
      const status = sel.value, dryRun = dry.checked, forceRefresh = ref.checked;
      log('点击“开始”：分组=' + CFG.statuses[status] + '，' + (dryRun ? '试运行' : '正式写入') + (forceRefresh ? '，重抓列表' : '，用缓存列表'));
      if (!dryRun && !confirm('将向你的 IMDb 账号写入「' + CFG.statuses[status] + '」列表（标记看过+打分）。确认已登录 IMDb？\n\n提示：同步期间请不要刷新或切换页面。')) return;
      setBusy(true);
      try { await run(status, dryRun, forceRefresh, log, (m) => { log(m, 'info'); setBusy(false); }, ui); }
      catch (e) { log('错误：' + (e && e.message ? e.message : e), 'err'); setBusy(false); }
    });
    stop.addEventListener('click', () => { stopped = true; log('正在停止…'); });
    csv.addEventListener('click', () => {
      const status = sel.value, prog = loadProg(status);
      if (!Object.keys(prog).length) { log('暂无数据可导出（请先点“开始”跑一遍）'); return; }
      const blob = new Blob(['\ufeff' + toCSV(prog)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'douban2imdb_' + status + '.csv'; document.body.appendChild(a); a.click(); a.remove();
      log('已导出 CSV');
    });
    reset.addEventListener('click', () => { const status = sel.value; if (confirm('清除「' + CFG.statuses[status] + '」的续跑进度？')) { localStorage.removeItem(CFG.storePrefix + status); log('进度已重置'); } });
    imp.addEventListener('click', () => {
      const fi = document.createElement('input'); fi.type = 'file'; fi.accept = '.csv,text/csv';
      fi.onchange = () => {
        const f = fi.files && fi.files[0]; if (!f) { return; }
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const res = importCSV(String(rd.result));
            if (!res.added) { log('导入失败：未找到 douban_sid 列（请用本脚本导出的 CSV）'); return; }
            const status = sel.value, prog = loadProg(status);
            Object.assign(prog, res.recs); saveProg(status, prog);
            log('已导入 ' + res.added + ' 条映射到「' + CFG.statuses[status] + '」；下次“开始”会跳过这些已匹配的');
          } catch (e) { log('导入出错：' + e.message); }
        };
        rd.readAsText(f, 'utf-8');
      };
      fi.click();
    });
    log('就绪。列表会缓存，重复点“开始”不会重爬；勾选“刷新列表”才重抓。可“导出/导入CSV”备份或跨设备恢复映射。', 'dim');

    // 若上次同步被中断（如切换了页面），回到本页自动续跑
    const rs = localStorage.getItem(CFG.storePrefix + 'running');
    if (rs && CFG.statuses[rs]) {
      sel.value = rs;
      log('⏩ 检测到上次「' + CFG.statuses[rs] + '」同步被中断（可能切换了页面），正在自动从断点续跑…（点“停止”可取消）', 'warn');
      setBusy(true);
      run(rs, false, false, log, (m) => { log(m, 'info'); setBusy(false); }, ui).catch((e) => { log('错误：' + (e && e.message ? e.message : e), 'err'); setBusy(false); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
