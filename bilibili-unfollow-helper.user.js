// ==UserScript==
// @name         B站关注列表标签分析 & 批量取关 (bilibili-unfollow-helper)
// @namespace    https://github.com/brui233/bilibili-unfollow-helper
// @version      1.10.0
// @description  按需分析选中的UP主最新视频标签，支持按分组加载、互关保护排除、标签独立搜索、批量取关，内置更宽裕的随机延迟与分批冷却防风控机制。新增失败项自动重试及简介搜索。
// @author       brui
// @match        https://space.bilibili.com/*/fans/follow*
// @match        https://www.bilibili.com/
// @match        https://space.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.bilibili.com
// @connect      space.bilibili.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ─── 工具函数 ───────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: {
          'Referer': 'https://www.bilibili.com/',
          'Origin': 'https://www.bilibili.com',
          ...(options.headers || {}),
        },
        data: options.body || null,
        withCredentials: true,
        onload: res => {
          try {
            resolve(JSON.parse(res.responseText));
          } catch {
            resolve(res.responseText);
          }
        },
        onerror: reject,
      });
    });
  }

  function getCsrf() {
    const match = document.cookie.match(/bili_jct=([^;]+)/);
    return match ? match[1] : '';
  }

  function getMyUid() {
    const match = document.cookie.match(/DedeUserID=(\d+)/);
    return match ? match[1] : null;
  }

  // ─── API 调用 ───────────────────────────────────────────────────────────────

  async function fetchGroups() {
    const data = await gmFetch(`https://api.bilibili.com/x/relation/tags`);
    if (data?.code === 0) return data.data || [];
    return [];
  }

  async function fetchFollowingsByGroup(uid, tagid, pn = 1, ps = 50) {
    if (tagid === "0" || tagid === 0) {
      const data = await gmFetch(`https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${pn}&ps=${ps}&order=desc`);
      if (data?.code === 0) return { list: data.data?.list || [], total: data.data?.total || 0 };
      throw new Error('获取关注列表失败：' + (data?.message || '未知错误'));
    }

    const data = await gmFetch(`https://api.bilibili.com/x/relation/tag?mid=${uid}&tagid=${tagid}&pn=${pn}&ps=${ps}`);
    if (data?.code === 0) {
      let list = [];
      if (Array.isArray(data.data)) {
          list = data.data;
      } else if (data.data?.list) {
          list = data.data.list;
      } else if (data.data?.data) {
          list = data.data.data;
      }
      return { list: list, total: list.length };
    }
    throw new Error('获取分组关注失败：' + (data?.message || '未知错误'));
  }

  async function fetchLatestBvid(uid) {
    const arcData = await gmFetch(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${uid}&ps=5&pn=1`);
    if (arcData?.code === 0) {
      const vlist = arcData.data?.list?.vlist || [];
      if (vlist.length > 0) return vlist[0].bvid;
      return null;
    }

    const dynData = await gmFetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}`);
    if (dynData?.code === 0 && dynData.data?.items) {
      const vItem = dynData.data.items.find(i => i.type === 'DYNAMIC_TYPE_AV');
      if (vItem?.modules?.module_dynamic?.major?.archive?.bvid) {
        return vItem.modules.module_dynamic.major.archive.bvid;
      }
      return null;
    }
    throw new Error(`获取视频列表被拦截或失败`);
  }

  async function fetchVideoTags(bvid) {
    const data = await gmFetch(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`);
    if (data?.code === 0) return data.data || [];
    return [];
  }

  async function unfollowUser(uid) {
    const csrf = getCsrf();
    if (!csrf) throw new Error('未找到 CSRF token，请确保已登录');
    const data = await gmFetch('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `fid=${uid}&act=2&re_src=11&csrf=${csrf}`,
    });

    if (data?.code === 0) return true;
    if (data?.code === -400 || data?.code === -105 || (data?.message && data.message.includes('验证'))) {
      throw new Error('触发风控');
    }
    throw new Error(data?.message || '取关失败');
  }

  // ─── 样式注入 ────────────────────────────────────────────────────────────────

  GM_addStyle(`
    #buh-launcher { position: fixed; bottom: 80px; right: 24px; z-index: 99998; width: 46px; height: 46px; border-radius: 50%; background: #fb7299; color: #fff; font-size: 20px; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(251,114,153,.5); display: flex; align-items: center; justify-content: center; transition: transform .2s, box-shadow .2s; }
    #buh-launcher:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(251,114,153,.65); }
    #buh-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 99999; width: 840px; max-width: 96vw; max-height: 88vh; background: #1a1a2e; border-radius: 16px; box-shadow: 0 24px 80px rgba(0,0,0,.6); display: flex; flex-direction: column; font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; overflow: hidden; color: #e8e8f0; }
    #buh-panel.hidden { display: none; }
    #buh-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px 14px; background: linear-gradient(135deg,#fb7299 0%,#e85d8a 100%); flex-shrink: 0; }
    #buh-header h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: .5px; color: #fff; }
    #buh-header span { font-size: 12px; opacity: .85; color: #fff; }
    #buh-close { background: rgba(255,255,255,.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: background .15s; }
    #buh-close:hover { background: rgba(255,255,255,.35); }
    #buh-toolbar { display: flex; gap: 8px; padding: 12px 16px; background: #16213e; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
    .buh-btn { padding: 7px 14px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; transition: opacity .15s, transform .1s; white-space: nowrap; }
    .buh-btn:hover:not(:disabled) { opacity: .85; transform: translateY(-1px); }
    .buh-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }
    .buh-btn-primary { background: #fb7299; color: #fff; }
    .buh-btn-danger  { background: #e74c3c; color: #fff; }
    .buh-btn-ghost   { background: rgba(255,255,255,.08); color: #ccc; }
    .buh-btn-ghost.active { background: rgba(251,114,153,.2); color: #fb7299; border: 1px solid #fb7299; }
    .buh-input { min-width: 100px; padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.05); color: #e8e8f0; font-size: 13px; outline: none; }
    .buh-input:focus { border-color: #fb7299; }
    #buh-progress-wrap { padding: 0 16px 10px; background: #16213e; flex-shrink: 0; }
    #buh-progress-bar-bg { height: 4px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; }
    #buh-progress-bar { height: 100%; background: linear-gradient(90deg,#fb7299,#e85d8a); border-radius: 4px; width: 0%; transition: width .3s; }
    #buh-progress-text { font-size: 11px; color: #888; margin-top: 4px; }
    #buh-tags-filter { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px; background: #16213e; border-top: 1px solid rgba(255,255,255,.05); max-height: 100px; overflow-y: auto; flex-shrink: 0; }
    .buh-tag-chip { padding: 4px 10px; border-radius: 20px; font-size: 11px; cursor: pointer; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #aaa; transition: all .15s; white-space: nowrap; }
    .buh-tag-chip:hover  { border-color: #fb7299; color: #fb7299; }
    .buh-tag-chip.active { background: #fb7299; border-color: #fb7299; color: #fff; }
    #buh-stats { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; font-size: 12px; color: #888; background: #16213e; border-top: 1px solid rgba(255,255,255,.05); flex-shrink: 0; }
    #buh-stats b { color: #fb7299; }
    #buh-list-wrap { flex: 1; overflow-y: auto; padding: 8px 10px; }
    #buh-list-wrap::-webkit-scrollbar { width: 5px; }
    #buh-list-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 4px; }
    .buh-up-card { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; margin-bottom: 4px; background: rgba(255,255,255,.04); transition: background .15s; }
    .buh-up-card:hover { background: rgba(255,255,255,.08); }
    .buh-up-card.selected { background: rgba(251,114,153,.12); }
    .buh-up-card.disabled { opacity: 0.6; }
    .buh-check { width: 18px; height: 18px; accent-color: #fb7299; cursor: pointer; flex-shrink: 0; }
    .buh-check:disabled { cursor: not-allowed; }
    .buh-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 2px solid rgba(255,255,255,.1); }
    .buh-up-info { flex: 1; min-width: 0; }
    .buh-up-name { font-size: 14px; font-weight: 600; color: #e8e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
    .buh-up-name a { color: inherit; text-decoration: none; }
    .buh-up-name a:hover { color: #fb7299; }
    .buh-tag-mutual { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(243, 156, 18, 0.2); color: #f39c12; font-weight: normal; }
    .buh-up-sign { font-size: 11px; color: #888; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .buh-up-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    .buh-vtag { padding: 2px 7px; border-radius: 12px; font-size: 10px; background: rgba(255,255,255,.08); color: #aaa; }
    .buh-vtag.highlight { background: rgba(251,114,153,.25); color: #fb7299; }
    .buh-up-status { font-size: 11px; padding: 3px 10px; border-radius: 20px; flex-shrink: 0; font-weight: 600; }
    .buh-status-analyzing { background: rgba(255,200,0,.12); color: #f0c040; }
    .buh-status-done      { background: rgba(0,200,100,.12); color: #3ecf8e; }
    .buh-status-unfollowed{ background: rgba(100,100,100,.2); color: #666; text-decoration: line-through; }
    .buh-status-error     { background: rgba(231,76,60,.15); color: #e74c3c; }
    #buh-empty { text-align: center; padding: 40px; color: #555; font-size: 14px; }
    #buh-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 99998; backdrop-filter: blur(3px); }
    #buh-overlay.hidden { display: none; }
  `);

  // ─── 状态 ────────────────────────────────────────────────────────────────────

  let state = {
    uid: null,
    followings: [],
    allTags: {},
    selectedTags: new Set(),
    analyzing: false,
    analyzeTotal: 0,
    analyzeDone: 0,
    searchText: '',
    searchTagText: '',
    filterMutual: false,
    filterError: false,      // 新增：过滤出分析失败的用户
    mutualMidsLoaded: false,
    mutualMids: new Set()
  };

  // ─── 面板 HTML ───────────────────────────────────────────────────────────────

  function createPanel() {
    const overlay = document.createElement('div');
    overlay.id = 'buh-overlay';
    overlay.className = 'hidden';
    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.id = 'buh-panel';
    panel.className = 'hidden';
    panel.innerHTML = `
      <div id="buh-header">
        <div>
          <h2>🎯 关注列表分析 & 批量取关</h2>
          <span id="buh-uid-info">检测登录状态中…</span>
        </div>
        <button id="buh-close">✕</button>
      </div>
      <div id="buh-toolbar">
        <select id="buh-group-select" class="buh-input" style="max-width: 140px; cursor: pointer;">
          <option value="0">获取分组中...</option>
        </select>
        <button class="buh-btn buh-btn-primary" id="buh-btn-load">📋 加载本组</button>
        <button class="buh-btn buh-btn-ghost"   id="buh-btn-analyze" disabled>🔍 分析视频标签</button>
        <button class="buh-btn buh-btn-ghost"   id="buh-btn-selall"  disabled>全选</button>
        <button class="buh-btn buh-btn-ghost"   id="buh-btn-selinv"  disabled>反选</button>
        <button class="buh-btn buh-btn-ghost"   id="buh-btn-mutual">👥 仅看互关</button>
        <button class="buh-btn buh-btn-ghost"   id="buh-btn-error">❌ 仅看分析失败</button>

        <input id="buh-search" class="buh-input" style="flex: 1;" type="text" placeholder="搜索UP主/简介…" />
        <input id="buh-search-tag" class="buh-input" style="flex: 1;" type="text" placeholder="搜索标签…" />
      </div>
      <div id="buh-progress-wrap" style="display:none">
        <div id="buh-progress-bar-bg"><div id="buh-progress-bar"></div></div>
        <div id="buh-progress-text"></div>
      </div>
      <div id="buh-tags-filter"></div>
      <div id="buh-stats">
        <span>勾选UP主分析标签，防风控策略已增强。</span>
        <div style="display: flex; gap: 12px; align-items: center;">
          <label style="display: flex; align-items: center; gap: 4px; color: #3ecf8e; cursor: pointer; font-size: 13px; font-weight: bold;" title="一轮分析完毕后，若发现失败项将自动尝试重新获取">
            <input type="checkbox" id="buh-auto-retry" checked style="accent-color: #3ecf8e; width: 16px; height: 16px;">
            🔄 自动重试失败项
          </label>
          <label style="display: flex; align-items: center; gap: 4px; color: #f39c12; cursor: pointer; font-size: 13px; font-weight: bold;">
            <input type="checkbox" id="buh-protect-mutual" checked style="accent-color: #f39c12; width: 16px; height: 16px;">
            🛡️ 保护互关不被勾选
          </label>
          <button class="buh-btn buh-btn-danger" id="buh-btn-unfollow" disabled>✂️ 取关已选项</button>
        </div>
      </div>
      <div id="buh-stats-text" style="padding: 0 16px 8px; font-size: 12px; color: #888; background: #16213e; flex-shrink: 0;"></div>
      <div id="buh-list-wrap"><div id="buh-empty">点击「加载本组」开始获取内容</div></div>
    `;
    document.body.appendChild(panel);
    return { panel, overlay };
  }

  // ─── 渲染 ────────────────────────────────────────────────────────────────────

  function renderTagFilter() {
    const wrap = document.getElementById('buh-tags-filter');
    if (!Object.keys(state.allTags).length) { wrap.innerHTML = ''; return; }
    const sorted = Object.entries(state.allTags)
      .sort((a, b) => b[1] - a[1]);
    wrap.innerHTML = sorted.map(([name, cnt]) =>
      `<span class="buh-tag-chip ${state.selectedTags.has(name) ? 'active' : ''}"
             data-tag="${encodeURIComponent(name)}">${name} <small>${cnt}</small></span>`
    ).join('');
    wrap.querySelectorAll('.buh-tag-chip').forEach(el => {
      el.addEventListener('click', () => {
        const tag = decodeURIComponent(el.dataset.tag);
        if (state.selectedTags.has(tag)) state.selectedTags.delete(tag);
        else state.selectedTags.add(tag);
        renderTagFilter();
        renderList();
        updateStats();
      });
    });
  }

  function getFilteredList() {
    return state.followings.filter(up => {
      if (up.status === 'unfollowed') return false;
      if (state.filterMutual && !up.isMutual) return false;
      if (state.filterError && up.status !== 'error') return false; // 添加了对错误状态的筛选

      // 拓展：除了UP主的昵称，增加对UP主签名(简介)的搜索匹配
      const searchTextLower = state.searchText.toLowerCase();
      const matchSearch = !state.searchText ||
                          up.name.toLowerCase().includes(searchTextLower) ||
                          (up.sign && up.sign.toLowerCase().includes(searchTextLower));

      const matchTagText = !state.searchTagText || up.tags.some(t => t.toLowerCase().includes(state.searchTagText.toLowerCase()));
      const matchTag = state.selectedTags.size === 0 || [...state.selectedTags].every(t => up.tags.some(ut => ut === t));
      return matchSearch && matchTagText && matchTag;
    });
  }

  function renderList() {
    const wrap = document.getElementById('buh-list-wrap');
    const list = getFilteredList();
    if (!list.length) {
      wrap.innerHTML = '<div id="buh-empty">没有符合条件的UP主</div>';
      return;
    }

    const protectMutual = document.getElementById('buh-protect-mutual').checked;

    wrap.innerHTML = list.map(up => {
      const statusMap = {
        idle: '',
        analyzing: `<span class="buh-up-status buh-status-analyzing">分析中…</span>`,
        done: `<span class="buh-up-status buh-status-done">已分析</span>`,
        unfollowed: `<span class="buh-up-status buh-status-unfollowed">已取关</span>`,
        error: `<span class="buh-up-status buh-status-error">出错</span>`,
      };

      let emptyText = '尚未分析';
      if (up.status === 'done') emptyText = up.emptyReason || '暂无标签';
      if (up.status === 'error') emptyText = up.emptyReason || '请求失败';

      const tagSearchLower = state.searchTagText.toLowerCase();
      const tagHtml = up.tags.length
        ? up.tags.map(t => {
            const isMatch = (state.searchTagText && t.toLowerCase().includes(tagSearchLower)) || state.selectedTags.has(t);
            return `<span class="buh-vtag ${isMatch ? 'highlight' : ''}">${t}</span>`;
          }).join('')
        : `<span style="color:#555;font-size:11px">${emptyText}</span>`;

      const signText = up.sign || '这个人很懒，什么都没写';
      const mutualBadge = up.isMutual ? `<span class="buh-tag-mutual">互关</span>` : '';

      const isProtected = protectMutual && up.isMutual;

      return `
        <div class="buh-up-card ${up.checked ? 'selected' : ''} ${isProtected ? 'disabled' : ''}" data-mid="${up.mid}">
          <input class="buh-check" type="checkbox" data-mid="${up.mid}" ${up.checked ? 'checked' : ''} ${isProtected ? 'disabled' : ''} title="${isProtected ? '互关保护开启中' : ''}" />
          <img class="buh-avatar" src="${up.face}@60w_60h.webp" alt="" loading="lazy" />
          <div class="buh-up-info">
            <div class="buh-up-name">
              <a href="https://space.bilibili.com/${up.mid}" target="_blank">${up.name}</a>
              ${mutualBadge}
            </div>
            <div class="buh-up-sign" title="${signText}">${signText}</div>
            <div class="buh-up-tags">${tagHtml}</div>
          </div>
          ${statusMap[up.status] || ''}
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('.buh-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const up = state.followings.find(u => String(u.mid) === cb.dataset.mid);
        if (up) { up.checked = cb.checked; cb.closest('.buh-up-card').classList.toggle('selected', cb.checked); }
        updateStats();
        updateButtons();
      });
    });
  }

  function updateStats() {
    const el = document.getElementById('buh-stats-text');
    const total = state.followings.filter(u => u.status !== 'unfollowed').length;
    const analyzed = state.followings.filter(u => u.status === 'done').length;
    const errors = state.followings.filter(u => u.status === 'error').length;
    const selected = state.followings.filter(u => u.checked && u.status !== 'unfollowed').length;
    const filtered = getFilteredList().length;
    el.innerHTML = `当前列表共 <b>${total}</b> 个关注 · 已分析 <b>${analyzed}</b>${errors > 0 ? ` · 失败 <b>${errors}</b>` : ''} · 显示过滤 <b>${filtered}</b> · 即将操作选中 <b>${selected}</b> 个`;
  }

  function updateButtons() {
    const hasFollowings = state.followings.length > 0;
    const hasSelected = state.followings.some(u => u.checked && u.status !== 'unfollowed');
    const notBusy = !state.analyzing;

    document.getElementById('buh-btn-analyze').disabled = !hasSelected || !notBusy;
    document.getElementById('buh-btn-selall').disabled  = !hasFollowings;
    document.getElementById('buh-btn-selinv').disabled  = !hasFollowings;
    document.getElementById('buh-btn-unfollow').disabled= !hasSelected || !notBusy;

    const mutualBtn = document.getElementById('buh-btn-mutual');
    if (state.filterMutual) {
      mutualBtn.classList.add('active');
      mutualBtn.textContent = '👥 取消互关过滤';
    } else {
      mutualBtn.classList.remove('active');
      mutualBtn.textContent = '👥 仅看互相关注';
    }

    const errorBtn = document.getElementById('buh-btn-error');
    if (state.filterError) {
      errorBtn.classList.add('active');
      errorBtn.textContent = '❌ 取消失败过滤';
    } else {
      errorBtn.classList.remove('active');
      errorBtn.textContent = '❌ 仅看分析失败';
    }
  }

  function setProgress(done, total, msg) {
    const wrap = document.getElementById('buh-progress-wrap');
    wrap.style.display = total > 0 ? '' : 'none';
    document.getElementById('buh-progress-bar').style.width = total > 0 ? `${(done/total)*100}%` : '0%';
    document.getElementById('buh-progress-text').textContent = msg || '';
  }

  // ─── 逻辑 ────────────────────────────────────────────────────────────────────

  async function loadUserGroups() {
    try {
        const groups = await fetchGroups();
        const sel = document.getElementById('buh-group-select');
        const options = groups.map(t => `<option value="${t.tagid}">${t.name} (${t.count})</option>`).join('');
        sel.innerHTML = '<option value="0">全部关注</option>' + options;
    } catch (e) {
        document.getElementById('buh-group-select').innerHTML = '<option value="0">全部分组(加载失败)</option>';
        console.error('获取分组失败', e);
    }
  }

  // 🛡️ [核心升级] 预加载全局互关名单
  async function preloadMutualMids(uid) {
    if (state.mutualMidsLoaded) return;

    let pn = 1;
    const ps = 50;
    setProgress(0, 1, '🛡️ 安全机制：因B站分组接口不包含互关状态，正在后台提取【互关白名单】防止误删...');

    while (true) {
        const data = await gmFetch(`https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${pn}&ps=${ps}&order=desc`);
        const list = data?.data?.list || [];

        list.forEach(u => {
            if (u.attribute === 6 || u.attribute === 128 + 6) {
                state.mutualMids.add(u.mid);
            }
        });

        const total = data?.data?.total || 0;
        setProgress(pn, Math.ceil(total / ps) || 1, `🛡️ 安全机制：正在提取全局互关白名单 (已记录 ${state.mutualMids.size} 个互关)...`);

        if (list.length < ps) break;
        pn++;
        await sleep(250);
    }
    state.mutualMidsLoaded = true;
  }

  async function loadFollowings() {
    const uid = state.uid;
    if (!uid) { alert('未检测到登录状态，请先登录B站'); return; }

    const tagid = document.getElementById('buh-group-select').value;
    const tagText = document.getElementById('buh-group-select').options[document.getElementById('buh-group-select').selectedIndex].text;

    document.getElementById('buh-btn-load').disabled = true;
    document.getElementById('buh-btn-load').textContent = '加载中…';
    state.followings = [];
    state.allTags = {};
    state.selectedTags = new Set();

    try {
      if (tagid !== "0" && tagid !== 0 && !state.mutualMidsLoaded) {
          await preloadMutualMids(uid);
      }

      let pn = 1;
      const ps = 50;
      setProgress(0, 1, `正在获取 [${tagText}] 的关注列表…`);

      while (true) {
        const data = await fetchFollowingsByGroup(uid, tagid, pn, ps);
        const list = data?.list || [];

        list.forEach(u => {
          let isMutual = false;
          if (tagid === "0" || tagid === 0) {
              isMutual = (u.attribute === 6 || u.attribute === 128 + 6);
              if (isMutual) state.mutualMids.add(u.mid);
              state.mutualMidsLoaded = true;
          } else {
              isMutual = state.mutualMids.has(u.mid);
          }

          state.followings.push({
            mid: u.mid,
            name: u.uname,
            face: u.face,
            sign: u.sign,
            isMutual: isMutual,
            tags: [],
            emptyReason: '',
            status: 'idle',
            checked: false,
          });
        });

        setProgress(pn, Math.ceil((data?.total || list.length) / ps) || 1, `已加载 ${state.followings.length} 个关注…`);
        if (list.length < ps) break;
        pn++;
        await sleep(300);
      }

      renderTagFilter();
      renderList();
      updateStats();
      updateButtons();
      setProgress(0, 0, '');
    } catch (e) {
      alert('加载失败：' + e.message);
    }
    document.getElementById('buh-btn-load').disabled = false;
    document.getElementById('buh-btn-load').textContent = '🔄 重新加载本组';
  }

  // 修改版：支持自动重试失败项的分析逻辑
  async function analyzeTags() {
    if (state.analyzing) return;

    const targets = state.followings.filter(u => u.checked && u.status !== 'unfollowed');
    if (targets.length === 0) {
      alert('没有选中的项可以分析！');
      return;
    }

    state.analyzing = true;
    updateButtons();

    let currentTargets = [...targets];
    let retryCount = 0;
    const maxRetries = 3; // 限制最大重试次数为3次，避免风控死循环

    while (currentTargets.length > 0 && retryCount <= maxRetries) {
        state.analyzeTotal = currentTargets.length;
        state.analyzeDone = 0;
        const isRetry = retryCount > 0;

        for (const up of currentTargets) {
          up.status = 'analyzing';
          renderList();
          setProgress(state.analyzeDone, state.analyzeTotal,
            `${isRetry ? `[自动重试 ${retryCount}] ` : ''}分析中 ${state.analyzeDone}/${state.analyzeTotal}：${up.name}`);

          try {
            const bvid = await fetchLatestBvid(up.mid);
            if (bvid) {
              await sleep(150);
              const vtags = await fetchVideoTags(bvid);
              const extractedTags = vtags.filter(t => t.tag_name).map(t => t.tag_name.toUpperCase());
              up.tags = extractedTags;

              if (extractedTags.length > 0) {
                extractedTags.forEach(t => { state.allTags[t] = (state.allTags[t] || 0) + 1; });
                up.emptyReason = '';
              } else {
                up.emptyReason = '最新视频未设置标签';
              }
            } else {
              up.tags = [];
              up.emptyReason = '该UP主暂未发布视频';
            }
            up.status = 'done';
          } catch (e) {
            up.status = 'error';
            up.emptyReason = '获取失败 (被拦截)';
          }

          state.analyzeDone++;
          renderTagFilter();
          renderList();
          updateStats();
          // 如果是重试，稍稍拉长每次请求的间隔
          await sleep(isRetry ? 800 : 400);
        }

        const autoRetry = document.getElementById('buh-auto-retry').checked;
        if (autoRetry) {
            // 筛选出本轮仍获取失败的项
            currentTargets = currentTargets.filter(u => u.status === 'error');
            if (currentTargets.length > 0) {
                retryCount++;
                if (retryCount <= maxRetries) {
                    setProgress(0, 1, `✅ 本轮完毕，发现 ${currentTargets.length} 个获取失败。3秒后自动进行第 ${retryCount} 次重试...`);
                    await sleep(3000);
                } else {
                    setProgress(0, 1, `❌ 连续重试 ${maxRetries} 次后，仍有 ${currentTargets.length} 个失败。请稍后重试或尝试手动通过验证。`);
                    await sleep(2500);
                    break;
                }
            } else {
                break; // 全部成功了，跳出循环
            }
        } else {
            break; // 用户没有勾选自动重试
        }
    }

    setProgress(0, 0, '');
    state.analyzing = false;
    updateButtons();
  }

  async function unfollowSelected() {
    const targets = state.followings.filter(u => u.checked && u.status !== 'unfollowed');
    if (!targets.length) return;

    const protectMutual = document.getElementById('buh-protect-mutual').checked;
    const finalTargets = targets.filter(u => !(protectMutual && u.isMutual));

    if (targets.length !== finalTargets.length) {
        alert(`已自动为你剔除了 ${targets.length - finalTargets.length} 个互相关注的UP主以防止误删。`);
    }
    if (!finalTargets.length) return;

    const ok = confirm(`确定取关选定的 ${finalTargets.length} 个UP主吗？\n\n🛡️ 【已拉满防风控保护】:\n每个取关动作随机延迟 3~7秒，每隔 15 个强制深呼吸冷却 15 秒。\n执行期间请勿关闭面板。`);
    if (!ok) return;

    state.analyzing = true;
    updateButtons();
    let done = 0;

    for (const up of finalTargets) {
      setProgress(done, finalTargets.length, `取关中 ${done}/${finalTargets.length}：${up.name} (防风控运行中, 请等待)`);
      try {
        await unfollowUser(up.mid);
        up.status = 'unfollowed';
        up.checked = false;
        done++;

        let delay = 3000 + Math.random() * 4000;
        if (done > 0 && done % 15 === 0 && done < finalTargets.length) {
            setProgress(done, finalTargets.length, `触发分批冷却保护：暂停呼吸 15 秒以防验证码拦截...`);
            delay = 15000;
        }
        await sleep(delay);

      } catch (e) {
        up.status = 'error';
        up.emptyReason = '取关接口失败';
        console.error(`取关 ${up.name} 失败:`, e);

        if (e.message.includes('风控')) {
            alert('⚠️ 警告：已被B站风控系统拦截（可能要求输入验证码）！\n\n任务已中止，剩余未取关。\n建议前往主站随便取关一个人过一遍验证码，或者休息半小时后再试。');
            break;
        }
      }
      renderList();
      updateStats();
    }
    setProgress(0, 0, '');
    state.analyzing = false;
    updateButtons();
    alert(`批量操作结束！成功取关 ${finalTargets.filter(u => u.status === 'unfollowed').length} 个。`);
  }

  // ─── 初始化 ──────────────────────────────────────────────────────────────────

  let isFirstOpen = true;

  function init() {
    state.uid = getMyUid();

    const launcher = document.createElement('button');
    launcher.id = 'buh-launcher';
    launcher.title = '关注分析 & 批量取关';
    launcher.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><line x1="18" y1="8" x2="23" y2="13" stroke="#fff" stroke-width="2.5"/><line x1="23" y1="8" x2="18" y2="13" stroke="#fff" stroke-width="2.5"/></svg>`;
    document.body.appendChild(launcher);

    const { panel, overlay } = createPanel();

    const uidInfo = document.getElementById('buh-uid-info');
    uidInfo.textContent = state.uid ? `UID: ${state.uid}` : '未登录（请先登录B站）';

    function openPanel()  {
        panel.classList.remove('hidden');
        overlay.classList.remove('hidden');
        if(isFirstOpen) {
            loadUserGroups();
            isFirstOpen = false;
        }
    }
    function closePanel() { panel.classList.add('hidden'); overlay.classList.add('hidden'); }

    launcher.addEventListener('click', openPanel);
    document.getElementById('buh-close').addEventListener('click', closePanel);
    overlay.addEventListener('click', closePanel);

    document.getElementById('buh-btn-load').addEventListener('click', loadFollowings);
    document.getElementById('buh-btn-analyze').addEventListener('click', analyzeTags);
    document.getElementById('buh-btn-unfollow').addEventListener('click', unfollowSelected);

    document.getElementById('buh-btn-selall').addEventListener('click', () => {
      const protectMutual = document.getElementById('buh-protect-mutual').checked;
      getFilteredList().forEach(u => {
          if (protectMutual && u.isMutual) {
              u.checked = false;
          } else {
              u.checked = true;
          }
      });
      renderList(); updateStats(); updateButtons();
    });

    document.getElementById('buh-btn-selinv').addEventListener('click', () => {
      const protectMutual = document.getElementById('buh-protect-mutual').checked;
      getFilteredList().forEach(u => {
          if (protectMutual && u.isMutual) {
              u.checked = false;
          } else {
              u.checked = !u.checked;
          }
      });
      renderList(); updateStats(); updateButtons();
    });

    document.getElementById('buh-protect-mutual').addEventListener('change', (e) => {
      if (e.target.checked) {
          state.followings.forEach(u => {
             if (u.isMutual) u.checked = false;
          });
      }
      renderList(); updateStats(); updateButtons();
    });

    // 独立互关过滤按钮事件
    document.getElementById('buh-btn-mutual').addEventListener('click', () => {
      state.filterMutual = !state.filterMutual;
      renderList(); updateStats(); updateButtons();
    });

    // 独立失败项过滤按钮事件
    document.getElementById('buh-btn-error').addEventListener('click', () => {
      state.filterError = !state.filterError;
      renderList(); updateStats(); updateButtons();
    });

    document.getElementById('buh-search').addEventListener('input', e => {
      state.searchText = e.target.value;
      renderList();
      updateStats();
    });

    document.getElementById('buh-search-tag').addEventListener('input', e => {
      state.searchTagText = e.target.value;
      renderList();
      updateStats();
    });

    updateButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
