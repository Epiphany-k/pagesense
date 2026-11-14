// PageSense Content Script
// 功能：正文提取、选区捕获、常驻悬浮球（点击摘要/悬停展开菜单/可拖动）、结果小卡片（流式渲染）
(() => {
  'use strict';

  // ---------------- 配置 ----------------
  let cfg = { launcherEnabled: true };

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    } catch (e) { /* storage 不可用时保持默认 */ }
  }
  loadConfig();
  // 悬浮球形象（桌宠）：默认 SVG / 预设 emoji / 自定义图片（GIF 动画）
  let petIcon = null;
  async function loadPetIcon() {
    try {
      const stored = await chrome.storage.local.get(LAUNCHER_ICON_KEY);
      petIcon = stored[LAUNCHER_ICON_KEY] || null;
    } catch (e) { /* storage 不可用时保持默认 */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[CONFIG_KEY]) {
      cfg = Object.assign({}, DEFAULT_CONFIG, changes[CONFIG_KEY].newValue || {});
      applyLauncherVisibility();
    }
    // 桌宠形象切换后实时同步到已打开页面
    if (changes[LAUNCHER_ICON_KEY]) {
      petIcon = changes[LAUNCHER_ICON_KEY].newValue || null;
      applyLauncherIcon();
    }
  });

  // ---------------- 正文提取 ----------------
  // NOISE_SELECTOR 追加数学公式渲染容器：
  // MathML(math)、KaTeX(.katex)、MathJax(.MathJax*/mjx-container)、MediaWiki(.mwe-math-element)、
  // latexml/ar5iv(.ltx_Math/.ltx_equation*)——这些元素的 textContent 是乱码符号流，
  // 提取出来既浪费 token 又干扰摘要，统一剔除（svg 本身无文本价值，一并处理）
  const NOISE_SELECTOR = 'script,style,noscript,nav,footer,aside,iframe,form,button,svg,header'
    + ',math,.katex,.katex-display,.MathJax,.MathJax_Display,.MathJax_Preview,mjx-container'
    + ',.mwe-math-element,.ltx_Math,.ltx_equation,.ltx_equationgroup,.ltx_eqn_num';

  // 参考文献标题（独立成行才截断，避免误伤正文中的普通提及）
  const REF_HEADING_RE = /^\s*(references?( and notes)?|notes? and references|bibliography|literature cited|acknowledg(e?ments?)?|funding|参考文献|引用文献|参考资料|致\s*谢)\s*:?\s*$/i;
  // display 公式右侧的编号残留：整行仅为 "(1)"、"(23)" 这类编号
  const EQ_NUM_RE = /^\(\s*\d{1,3}\s*\)$/;

  // 候选正文容器打分，选文本密度最高的块级容器
  function pickRoot() {
    const direct = document.querySelector('article')
      || document.querySelector('main')
      || document.querySelector('[role="main"]');
    if (direct) return direct;
    let best = null, bestScore = -1;
    const candidates = document.querySelectorAll('div, section, td');
    for (const el of candidates) {
      const pCount = el.querySelectorAll('p').length;
      const textLen = (el.textContent || '').length;
      // 过滤明显过短或过大的容器
      if (textLen < 300 || textLen > 500000) continue;
      const score = pCount * 50 + textLen;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best || document.body;
  }

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n').map(l => l.trim()).join('\n')
      .trim();
  }

  // 从克隆节点按块级元素收集段落，保留换行结构
  function collectParagraphs(rootEl) {
    const clone = rootEl.cloneNode(true);
    clone.querySelectorAll(NOISE_SELECTOR).forEach(n => n.remove());
    // figcaption：图表标题（"Figure 1: …" / "Table 2: …"）是图表的浓缩信息，
    // 正文纯文本提取不到图表本身，保留 caption 可让摘要覆盖实验结论
    const blocks = clone.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,dd,figcaption');
    const lines = [];
    for (const b of blocks) {
      const t = cleanText(b.textContent);
      if (!t) continue;
      // 参考文献标题：学术页面正文后的引用列表对摘要无价值且占大量 token，
      // 命中后截断后续内容（参考文献总是位于正文之后，截断安全）
      if (REF_HEADING_RE.test(t)) break;
      // 公式编号行：display 公式剔除后残留的独立编号
      if (EQ_NUM_RE.test(t)) continue;
      lines.push(t);
    }
    return lines.join('\n');
  }

  function extractContent() {
    const title = document.title || '';
    const metaDesc = document.querySelector('meta[name="description"]');
    const desc = metaDesc ? (metaDesc.content || '') : '';

    let text = '';
    try { text = collectParagraphs(pickRoot()); } catch (e) { /* 降级 */ }
    // 兜底：正文过短时用 body.innerText
    if (text.length < 200) {
      const fallback = cleanText(document.body ? document.body.innerText : '');
      if (fallback.length > text.length) text = fallback;
    }
    return { title, desc, text, url: location.href };
  }

  function currentSelectionText() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    return String(sel).trim();
  }

  // ---------------- 选区快照 ----------------
  // 部分站点（如 CSDN 的复制保护）会在点击瞬间清除选区，preventDefault 拦不住网站自己的脚本。
  // 通过 selectionchange 实时缓存最近一次有效选区，操作时兜底使用。
  let lastSelection = '', lastSelectionAt = 0, selectionClearedAt = 0;
  document.addEventListener('selectionchange', () => {
    const t = currentSelectionText();
    if (t && t.length >= 2) {
      lastSelection = t; lastSelectionAt = Date.now(); selectionClearedAt = 0;
    } else if (lastSelection) {
      // 选区从有到无：可能是用户主动取消，也可能是站点脚本在点击瞬间清除
      selectionClearedAt = Date.now();
    }
  });

  // 取当前选区；被站点清除时回退到最近一次有效选区快照。
  // 500ms 宽限期：容忍"点击菜单瞬间被站点清除"的场景（清除后立即读取操作）；
  // 选区消失超过宽限期（用户已主动取消选择）则不再使用旧快照。
  function selectionSnapshot() {
    const live = currentSelectionText();
    if (live) return live;
    if (selectionClearedAt && Date.now() - selectionClearedAt > 500) return '';
    return (Date.now() - lastSelectionAt < 30000) ? lastSelection : '';
  }

  // ---------------- 扩展上下文存活检测 ----------------
  // 插件重载/更新后，页面中残留的旧 content script 调用 chrome API 会抛
  // "Extension context invalidated" —— 所有 chrome API 调用前先检测
  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ---------------- 触发消息发送 ----------------
  function sendJob(type, payload) {
    if (!extAlive()) return; // 上下文已失效（插件已重载），静默忽略
    try {
      const p = chrome.runtime.sendMessage({ type, payload });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 同步抛出的 invalidated 错误，忽略 */ }
  }

  // ================= 常驻悬浮球（Launcher） =================
  // 点击 → 有选区摘要选中段落，无选区摘要整页；悬停 → 展开菜单；可拖动；位置按来源记忆
  let lcHost = null, lcShadow = null;
  let lcPos = null; // {right, bottom} 相对视口右下角的偏移

  const LAUNCHER_CSS = `
    .lc-wrapper {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
      font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    }
    .lc-ball {
      position: relative;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #06b6d4, #3b82f6, #8b5cf6, #06b6d4);
      background-size: 300% 300%;
      animation: lc-float 3.2s ease-in-out infinite, lc-flow 8s linear infinite;
      box-shadow: 0 6px 20px rgba(99,102,241,.45), 0 2px 6px rgba(6,182,212,.25);
      cursor: pointer; user-select: none;
      touch-action: none; /* 触屏拖动球时不触发页面滚动 */
    }
    /* 悬浮呼吸：轻微上下浮动，让球有"活着"的感觉 */
    @keyframes lc-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
    /* 流光：渐变色缓慢流动 */
    @keyframes lc-flow { to { background-position: 300% 300% } }
    /* 光环涟漪：向外扩散的呼吸圈 */
    .lc-ball::after {
      content: ""; position: absolute; inset: -3px; border-radius: 50%;
      border: 2px solid rgba(139,92,246,.45);
      animation: lc-ring 2.6s ease-out infinite;
      pointer-events: none;
    }
    @keyframes lc-ring {
      0% { transform: scale(.92); opacity: .8 }
      70% { transform: scale(1.4); opacity: 0 }
      100% { transform: scale(1.4); opacity: 0 }
    }
    /* 缩放交给内层 core：外层 transform 被浮动动画占用，分层避免冲突 */
    .lc-core {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      transition: transform .35s cubic-bezier(.34,1.56,.64,1);
    }
    .lc-ball:hover .lc-core { transform: scale(1.12) rotate(-8deg); }
    .lc-ball:active .lc-core { transform: scale(.88); }
    .lc-core svg { width: 26px; height: 26px; pointer-events: none; }
    .lc-menu {
      /* 脱离文档流贴在球上方展开：隐藏时不占布局空间，提醒气泡得以紧贴悬浮球 */
      position: absolute; right: 0; bottom: 62px;
      min-width: 168px; /* 最小宽度：菜单项长度不同时不抖动 */
      display: flex; flex-direction: column; gap: 4px;
      background: rgba(255,255,255,.82);
      backdrop-filter: blur(18px) saturate(1.6);
      border: 1px solid rgba(255,255,255,.65);
      border-radius: 16px; padding: 7px;
      box-shadow: 0 16px 44px rgba(31,38,135,.18), 0 0 0 1px rgba(15,23,42,.05);
      opacity: 0; transform: translateY(8px) scale(.92); pointer-events: none;
      transition: opacity .18s ease, transform .3s cubic-bezier(.34,1.56,.64,1);
      transform-origin: bottom right;
    }
    .lc-menu.show { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    .lc-readtime {
      padding: 6px 14px 7px; margin-bottom: 3px;
      font-size: 11.5px; color: #94a3b8;
      border-bottom: 1px solid rgba(148,163,184,.2);
      white-space: nowrap; text-align: left;
    }
    .lc-menu button {
      all: unset; cursor: pointer;
      padding: 9px 15px; border-radius: 10px;
      font-size: 13px; color: #1e293b; white-space: nowrap;
      transition: background .15s ease, color .15s ease, transform .2s cubic-bezier(.34,1.56,.64,1);
    }
    .lc-menu button:hover {
      background: linear-gradient(135deg, rgba(6,182,212,.12), rgba(139,92,246,.16));
      color: #6d28d9; transform: translateX(3px);
    }
    .lc-menu button .mi { margin-right: 8px; }
    /* 阅读提醒气泡：悬浮球上方冒出 */
    .lc-reminder {
      display: none;
      background: rgba(15,23,42,.85);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(148,163,184,.25);
      color: #f1f5f9;
      border-radius: 12px; padding: 10px 14px;
      font-size: 12.5px; line-height: 1.5;
      box-shadow: 0 10px 30px rgba(15,23,42,.35);
      cursor: pointer; max-width: 220px;
      transform-origin: bottom right;
    }
    .lc-reminder.show { display: block; animation: lc-pop .38s cubic-bezier(.34,1.56,.64,1); }
    @keyframes lc-pop {
      0% { opacity: 0; transform: translateY(6px) scale(.9) }
      100% { opacity: 1; transform: translateY(0) scale(1) }
    }
    /* 桌宠形象：emoji 模式 —— 渐变球身 + 角色 */
    .lc-ball.pet-emoji .lc-core { font-size: 27px; line-height: 1; }
    /* 桌宠形象：自定义图片模式 —— 去掉渐变底与光环，图片按原比例呈现（GIF 保留动画） */
    .lc-ball.pet-image { background: none; box-shadow: 0 6px 20px rgba(99,102,241,.38), 0 2px 6px rgba(6,182,212,.2); }
    .lc-ball.pet-image::after { display: none; }
    .lc-ball.pet-image .lc-core img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  `;

  const LAUNCHER_ICON = '<svg viewBox="0 0 24 24" fill="none">'
    + '<path d="M12 3C7.03 3 3 6.58 3 11c0 1.83.74 3.5 1.97 4.82-.1 1.06-.5 2.06-1.16 2.87-.16.2-.02.5.23.47 1.5-.14 2.8-.7 3.66-1.3.98.36 2.06.57 3.3.57 4.97 0 9-3.58 9-8S16.97 3 12 3z" fill="#fff"/>'
    + '<circle cx="8.6" cy="11" r="1.1" fill="#06b6d4"/>'
    + '<circle cx="12" cy="11" r="1.1" fill="#3b82f6"/>'
    + '<circle cx="15.4" cy="11" r="1.1" fill="#8b5cf6"/>'
    + '</svg>';

  const POS_KEY = 'pagesense_launcher_pos';

  // 位置持久化到 chrome.storage.local：跨标签页、跨会话记忆
  async function restoreLauncherPos() {
    try {
      const stored = await chrome.storage.local.get(POS_KEY);
      if (stored[POS_KEY]) lcPos = stored[POS_KEY];
    } catch (e) { /* storage 不可用时用默认位置 */ }
  }

  function saveLauncherPos() {
    try { chrome.storage.local.set({ [POS_KEY]: lcPos }); } catch (e) { /* 忽略 */ }
  }

  // 把已恢复/已保存的位置应用到悬浮球
  function applyLauncherPos() {
    if (!lcPos || !lcShadow) return;
    const wrapper = lcShadow.querySelector('.lc-wrapper');
    if (!wrapper) return;
    wrapper.style.right = lcPos.right + 'px';
    wrapper.style.bottom = lcPos.bottom + 'px';
  }

  function ensureLauncher() {
    if (lcHost) return;
    // 位置异步恢复，完成后应用到悬浮球
    restoreLauncherPos().then(applyLauncherPos);
    // 清理失效实例残留的宿主：插件重载后旧 content script 仍会留下旧悬浮球 DOM
    document.documentElement.querySelectorAll('[data-ps-host="launcher"]').forEach(n => n.remove());

    lcHost = document.createElement('div');
    lcHost.dataset.psHost = 'launcher';
    lcHost.style.cssText = 'position:static;width:0;height:0;';
    lcShadow = lcHost.attachShadow({ mode: 'closed' });
    lcShadow.innerHTML = `
      <style>${LAUNCHER_CSS}</style>
      <div class="lc-wrapper">
        <div class="lc-reminder"></div>
        <div class="lc-menu">
          <div class="lc-readtime">已阅读 0 分钟</div>
          <button data-act="summarize"><span class="mi">✦</span>摘要本页</button>
          <button data-act="explain-sel"><span class="mi">💡</span>解释选中内容</button>
          <button data-act="summarize-sel"><span class="mi">📝</span>摘要选中内容</button>
          <button data-act="settings"><span class="mi">⚙️</span>设置</button>
        </div>
        <div class="lc-ball" title="PageSense：点击摘要（有选区时摘要选中段落，否则摘要整页），悬停展开菜单"><div class="lc-core">${LAUNCHER_ICON}</div></div>
      </div>`;
    document.documentElement.appendChild(lcHost);

    const wrapper = lcShadow.querySelector('.lc-wrapper');
    const ball = lcShadow.querySelector('.lc-ball');
    const menu = lcShadow.querySelector('.lc-menu');

    // 阻止浏览器按下时的默认"点击清除选区"行为：
    // 否则用户选中段落后再点菜单，选区已被清掉，"解释/摘要选中内容"会取到空文本
    wrapper.addEventListener('pointerdown', (e) => e.preventDefault());

    // 悬停展开菜单（离开后延迟收起，给鼠标移向菜单的时间）
    let menuTimer = null;
    const openMenu = () => {
      clearTimeout(menuTimer);
      updateReadTimeUI(); // 展开时刷新累计阅读时长
      menu.classList.add('show');
    };
    const closeMenu = () => {
      menuTimer = setTimeout(() => menu.classList.remove('show'), 250);
    };
    ball.addEventListener('mouseenter', openMenu);
    menu.addEventListener('mouseenter', openMenu);
    wrapper.addEventListener('mouseleave', closeMenu);
    // 触屏没有 mouseleave：点击页面其他区域时收起菜单
    // （closed shadow 内部的点击在 document 层会被 retarget 为宿主 lcHost）
    document.addEventListener('pointerdown', (e) => {
      if (e.target === lcHost) return;
      menu.classList.remove('show');
    });

    // 菜单项点击
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      menu.classList.remove('show');
      handleMenuAction(btn.dataset.act);
    });

    // 拖动 + 点击 + 长按（pointer events 同时支持鼠标与触屏）
    // 位移 <5px 视为点击；按住 600ms 未移动视为长按——触屏没有 hover，靠长按展开菜单
    let dragging = false, moved = false, longPressed = false, startX = 0, startY = 0, pressTimer = 0;
    ball.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true; moved = false; longPressed = false;
      startX = e.clientX; startY = e.clientY;
      pressTimer = setTimeout(() => {
        if (!moved) { longPressed = true; openMenu(); }
      }, 600);
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      clearTimeout(pressTimer);
      const rect = wrapper.getBoundingClientRect();
      // 以 right/bottom 偏移定位，保证贴边与缩放安全
      const right = Math.max(0, Math.min(window.innerWidth - rect.width, window.innerWidth - e.clientX - rect.width / 2));
      const bottom = Math.max(0, Math.min(window.innerHeight - 40, window.innerHeight - e.clientY - rect.height / 2));
      lcPos = { right, bottom };
      wrapper.style.right = right + 'px';
      wrapper.style.bottom = bottom + 'px';
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      clearTimeout(pressTimer);
      if (moved) { saveLauncherPos(); return; }
      if (longPressed) return; // 长按已展开菜单，不触发摘要
      // 点击（非拖动）智能分流：有选区 → 摘要选中段落；无选区 → 摘要整页（快照兜底）
      const sel = selectionSnapshot();
      if (sel) {
        sendJob(MSG.SUMMARIZE_SELECTION, { text: sel, title: document.title, url: location.href });
      } else {
        sendJob(MSG.SUMMARIZE_PAGE, {});
      }
    });
    // 触屏拖动被系统手势打断（如浏览器接管滚动）：保存已移动到的位置
    window.addEventListener('pointercancel', () => {
      if (!dragging) return;
      dragging = false;
      clearTimeout(pressTimer);
      if (moved) saveLauncherPos();
    });

    // 阅读提醒：点击气泡关闭
    const reminder = lcShadow.querySelector('.lc-reminder');
    reminder.addEventListener('click', () => {
      clearTimeout(reminderHideTimer);
      reminder.classList.remove('show');
    });
    startReadingReminder();
    applyLauncherIcon(); // 按 petIcon 渲染球体形象（默认 SVG / emoji / 自定义图片）
  }

  // 应用桌宠形象：更换球体外观，交互（点击/拖动/悬停菜单/呼吸浮动）保持不变
  function applyLauncherIcon() {
    if (!lcShadow) return;
    const ball = lcShadow.querySelector('.lc-ball');
    const core = lcShadow.querySelector('.lc-core');
    if (!ball || !core) return;
    ball.classList.remove('pet-emoji', 'pet-image');
    core.textContent = '';
    if (petIcon && petIcon.type === 'emoji' && petIcon.value) {
      ball.classList.add('pet-emoji');
      core.textContent = petIcon.value;
    } else if (petIcon && petIcon.type === 'image' && petIcon.value) {
      ball.classList.add('pet-image');
      const img = document.createElement('img');
      img.src = petIcon.value;
      img.alt = 'PageSense';
      img.draggable = false;
      core.appendChild(img);
    } else {
      core.innerHTML = LAUNCHER_ICON;
    }
  }

  function applyLauncherVisibility() {
    if (cfg.launcherEnabled) {
      ensureLauncher();
      if (lcHost) lcHost.style.display = '';
    } else if (lcHost) {
      lcHost.style.display = 'none';
    }
  }

  // ---------------- 阅读提醒 ----------------
  // 仅在页面可见时累计阅读时间；达到设定时长后悬浮球冒出气泡提醒，
  // 提醒后重新计时（循环提醒），设置分钟数为 0 时关闭。
  // readMs 为当前提醒周期，totalReadMs 为本次会话累计（菜单实时显示用，不随提醒清零）
  let reminderStarted = false, reminderHideTimer = 0, readMs = 0, totalReadMs = 0;
  const REMINDER_TICK_MS = 15000;

  function startReadingReminder() {
    if (reminderStarted) return;
    reminderStarted = true;
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      readMs += REMINDER_TICK_MS;
      totalReadMs += REMINDER_TICK_MS;
      updateReadTimeUI();
      const min = Number(cfg.reminderMinutes) || 0;
      if (min > 0 && readMs >= min * 60000) {
        readMs = 0;
        showReadingReminder(min);
      }
    }, REMINDER_TICK_MS);
  }

  // 菜单顶部实时显示累计阅读时长（分钟级变化才写 DOM）
  function updateReadTimeUI() {
    if (!lcShadow) return;
    const el = lcShadow.querySelector('.lc-readtime');
    if (!el) return;
    const text = '已阅读 ' + Math.floor(totalReadMs / 60000) + ' 分钟';
    if (el.textContent !== text) el.textContent = text;
  }

  function showReadingReminder(min) {
    if (!lcShadow) return;
    const tip = lcShadow.querySelector('.lc-reminder');
    if (!tip) return;
    tip.textContent = '已连续阅读 ' + min + ' 分钟，该休息一下了（点击关闭）';
    tip.classList.add('show');
    clearTimeout(reminderHideTimer);
    // 用户可能不在电脑前：气泡保留 60 秒后自动收起，避免长期遮挡
    reminderHideTimer = setTimeout(() => tip.classList.remove('show'), 60000);
  }

  function handleMenuAction(act) {
    // 用快照兜底：站点脚本可能在点击菜单瞬间清除选区
    const sel = selectionSnapshot();
    switch (act) {
      case 'summarize':
        sendJob(MSG.SUMMARIZE_PAGE, {});
        break;
      case 'explain-sel':
        sendJob(MSG.EXPLAIN_SELECTION, { text: sel, title: document.title, url: location.href });
        break;
      case 'summarize-sel':
        sendJob(MSG.SUMMARIZE_SELECTION, { text: sel, title: document.title, url: location.href });
        break;
      case 'settings':
        sendJob(MSG.OPEN_OPTIONS, {});
        break;
    }
  }

  // 配置与桌宠形象就绪后创建悬浮球
  Promise.all([loadConfig(), loadPetIcon()]).then(applyLauncherVisibility);

  // ================= 结果小卡片 =================
  let fwHost = null, fwShadow = null;
  let fwState = null;          // {jobId, kind, source, streaming, done, error, mainText}
  let fwPos = null;            // 拖动后的自由定位 {left, top}
  let fwRenderTimer = 0;

  const FW_CSS = `
    .fw {
      position: fixed; z-index: 2147483647;
      width: 360px; max-width: calc(100vw - 24px);
      background: rgba(255,255,255,.92);
      backdrop-filter: blur(20px) saturate(1.5);
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(31,38,135,.18), 0 0 0 1px rgba(15,23,42,.06);
      font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #0f172a;
      display: flex; flex-direction: column;
      overflow: hidden;
      opacity: 0; transform: translateY(10px) scale(.94);
      transition: opacity .2s ease, transform .34s cubic-bezier(.34,1.56,.64,1);
      transform-origin: bottom right;
    }
    .fw.show { opacity: 1; transform: translateY(0) scale(1); }
    .fw-header {
      position: relative;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px 10px 14px;
      background: rgba(248,250,252,.7);
      border-bottom: 1px solid rgba(148,163,184,.18);
      cursor: move; user-select: none;
      touch-action: none; /* 触屏拖动卡片时不触发页面滚动 */
    }
    /* 头部顶端的渐变高光线，点睛用 */
    .fw-header::before {
      content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
      background: linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6, transparent 85%);
      opacity: .8;
    }
    .fw-logo {
      font-weight: 700; font-size: 12px; white-space: nowrap;
      background: linear-gradient(135deg, #0891b2, #6d28d9);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .fw-title {
      flex: 1; font-size: 11px; color: #64748b;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fw-close {
      all: unset; cursor: pointer; padding: 3px 8px; border-radius: 8px;
      font-size: 11px; line-height: 1; color: #94a3b8;
      transition: background .15s, color .15s, transform .2s cubic-bezier(.34,1.56,.64,1);
    }
    .fw-close:hover { background: rgba(148,163,184,.2); color: #334155; transform: rotate(90deg); }
    .fw-body {
      max-height: 46vh; min-height: 40px; overflow-y: auto;
      padding: 14px 16px;
      scrollbar-width: thin;
    }
    .status-line {
      display: flex; align-items: center; gap: 8px;
      color: #64748b; font-size: 12px; margin: 0 0 8px;
    }
    .spinner {
      width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid #ddd6fe; border-top-color: #7c3aed;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg) } }
    .fw-empty { color: #94a3b8; font-size: 12px; text-align: center; padding: 8px 0; }
    /* Markdown */
    .md { word-wrap: break-word; font-size: 13px; line-height: 1.7; }
    .md h1,.md h2,.md h3,.md h4,.md h5 { margin: 10px 0 5px; line-height: 1.4; color: #0f172a; }
    .md h2 { font-size: 14px; padding-bottom: 3px; border-bottom: 1px solid rgba(148,163,184,.2); }
    .md h3 { font-size: 13px; }
    .md p { margin: 4px 0; }
    .md ul { margin: 4px 0; padding-left: 18px; }
    .md li { margin: 3px 0; }
    .md li::marker { color: #7c3aed; }
    .md code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; font-family: Consolas, monospace; font-size: 12px; color: #be185d; }
    .md pre { background: #0f172a; border-radius: 10px; padding: 10px 12px; overflow-x: auto; }
    .md pre code { background: none; padding: 0; color: #e2e8f0; }
    .md blockquote { margin: 5px 0; padding: 2px 10px; color: #64748b; border-left: 3px solid #a78bfa; }
    .md strong { font-weight: 600; color: #0f172a; }
    .ps-cursor::after { content: "▍"; color: #7c3aed; animation: blink 1s infinite; }
    @keyframes blink { 0%,100% { opacity: .2 } 50% { opacity: 1 } }
    /* 错误卡片 */
    .error-card {
      background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;
      border-radius: 10px; padding: 10px 12px; margin: 4px 0; font-size: 12.5px;
    }
    .error-card .row { display: flex; gap: 8px; margin-top: 8px; }
    .error-card button {
      all: unset; cursor: pointer; background: #dc2626; color: #fff;
      padding: 4px 12px; border-radius: 8px; font-size: 12px;
    }
    .error-card button.secondary { background: #fff; color: #dc2626; border: 1px solid #fecaca; }
    /* 底部操作栏 */
    .fw-footer {
      display: flex; flex-wrap: wrap; align-items: center; gap: 7px;
      padding: 10px 12px; border-top: 1px solid rgba(148,163,184,.18);
      background: rgba(248,250,252,.7);
    }
    .fw-footer button {
      all: unset; cursor: pointer; font-size: 11.5px;
      padding: 5px 12px; border-radius: 999px;
      border: 1px solid rgba(148,163,184,.35); color: #334155; background: rgba(255,255,255,.85);
      transition: background .15s, border-color .15s, color .15s, transform .2s cubic-bezier(.34,1.56,.64,1);
    }
    .fw-footer button:hover:not(:disabled) {
      background: linear-gradient(135deg, rgba(6,182,212,.12), rgba(139,92,246,.16));
      border-color: rgba(139,92,246,.4); color: #6d28d9; transform: translateY(-1px);
    }
    .fw-footer button:active:not(:disabled) { transform: translateY(0) scale(.95); }
    .fw-footer button:disabled { opacity: .4; cursor: default; }
    .fw-footer .spacer { flex: 1; }
  `;

  function ensureFloatWindow() {
    if (fwHost) return;
    // 清理失效实例残留的结果卡片宿主
    document.documentElement.querySelectorAll('[data-ps-host="float"]').forEach(n => n.remove());
    fwHost = document.createElement('div');
    fwHost.dataset.psHost = 'float';
    fwHost.style.cssText = 'position:static;width:0;height:0;';
    fwShadow = fwHost.attachShadow({ mode: 'closed' });
    fwShadow.innerHTML = `
      <style>${FW_CSS}</style>
      <div class="fw" style="display:none">
        <div class="fw-header">
          <span class="fw-logo">✦ PageSense</span>
          <span class="fw-title"></span>
          <button class="fw-close" title="收起结果">✕</button>
        </div>
        <div class="fw-body"></div>
        <div class="fw-footer">
          <button data-act="copy" disabled>复制</button>
          <button data-act="export" disabled>导出 MD</button>
          <button data-act="regen" disabled>重新生成</button>
          <button data-act="clip" disabled>收藏</button>
          <button data-act="term" disabled style="display:none">存术语</button>
          <span class="spacer"></span>
          <button data-act="settings">设置</button>
        </div>
      </div>`;
    document.documentElement.appendChild(fwHost);

    // 拖动（按住头部移动；pointer events 兼容鼠标与触屏）
    const header = fwShadow.querySelector('.fw-header');
    const win = fwShadow.querySelector('.fw');
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fw-close')) return;
      e.preventDefault();
      const rect = win.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      const move = (ev) => {
        const left = Math.max(0, Math.min(ev.clientX - offX, window.innerWidth - rect.width));
        const top = Math.max(0, Math.min(ev.clientY - offY, window.innerHeight - 40));
        win.style.left = left + 'px';
        win.style.top = top + 'px';
        win.style.right = 'auto';
        win.style.bottom = 'auto';
        fwPos = { left, top };
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });

    // 关闭（收起，不销毁，下次任务重新弹出）
    fwShadow.querySelector('.fw-close').addEventListener('click', () => {
      win.classList.remove('show');
      setTimeout(() => { win.style.display = 'none'; }, 170);
    });

    // 操作按钮
    fwShadow.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'copy') doCopy();
      else if (act === 'export') doExport();
      else if (act === 'clip') doSaveClip();
      else if (act === 'term') doSaveTerm();
      else if (act === 'regen') {
        // 流式输出中 → 停止任务；结束后 → 重新生成
        if (fwState && fwState.streaming) sendJob(MSG.CANCEL_JOB, {});
        else sendRegenerate();
      }
      else if (act === 'settings') sendJob(MSG.OPEN_OPTIONS, {});
    });
  }

  function showFloatWindow() {
    ensureFloatWindow();
    const win = fwShadow.querySelector('.fw');
    if (fwPos) {
      // 用户拖动过的自由位置
      win.style.left = fwPos.left + 'px';
      win.style.top = fwPos.top + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    } else {
      // 贴近悬浮球：悬浮球上方、右对齐（62 = 球直径 52 + 间距 10）
      const anchor = lcPos || { right: 24, bottom: 24 };
      win.style.left = 'auto';
      win.style.top = 'auto';
      win.style.right = anchor.right + 'px';
      win.style.bottom = (anchor.bottom + 62) + 'px';
    }
    win.style.display = 'flex';
    requestAnimationFrame(() => win.classList.add('show'));
  }

  function fwScheduleRender() {
    if (fwRenderTimer) return;
    fwRenderTimer = setTimeout(() => {
      fwRenderTimer = 0;
      fwRender();
    }, 80);
  }

  function fwRender() {
    if (!fwShadow || !fwState) return;
    const $ = (sel) => fwShadow.querySelector(sel);
    const body = $('.fw-body');

    // 头部来源标题
    $('.fw-title').textContent = (fwState.source && fwState.source.title) || document.title || '';

    // 内容区
    let html = '';
    if (fwState.streaming) {
      html += '<div class="status-line"><span class="spinner"></span><span>' + escapeHtml(fwState.statusText || '正在生成…') + '</span></div>';
    } else if (fwState.statusText) {
      // 结束后的附加状态（如"已停止"）
      html += '<div class="status-line"><span>' + escapeHtml(fwState.statusText) + '</span></div>';
    }
    if (fwState.mainText) {
      html += '<div class="md">' + renderMarkdown(fwState.mainText, fwState.streaming) + '</div>';
    } else if (!fwState.streaming && !fwState.error) {
      html += '<div class="fw-empty">等待结果…</div>';
    }
    if (fwState.error) {
      html += '<div class="error-card"><div>' + escapeHtml(fwState.error) + '</div>'
        + '<div class="row"><button data-act="settings" class="secondary">打开设置</button>'
        + '<button data-act="regen">重试</button></div></div>';
    }
    body.innerHTML = html;
    if (fwState.streaming) body.scrollTop = body.scrollHeight;

    // 操作按钮状态：流式时"重新生成"变"停止"（可点击），结束后恢复
    $('[data-act="copy"]').disabled = !(fwState.done && fwState.mainText);
    $('[data-act="export"]').disabled = !(fwState.done && fwState.mainText);
    const regenBtn = $('[data-act="regen"]');
    if (fwState.streaming) {
      regenBtn.disabled = false;
      regenBtn.textContent = '停止';
    } else {
      regenBtn.textContent = '重新生成';
      regenBtn.disabled = !(fwState.done || fwState.error);
    }
    // 收藏：结果生成后可存入收藏本，已收藏则固定为完成态
    const clipBtn = $('[data-act="clip"]');
    clipBtn.disabled = !(fwState.done && fwState.mainText) || fwState.savedClip;
    clipBtn.textContent = fwState.savedClip ? '已收藏' : '收藏';
    // 存术语：仅解释任务显示；选中文本过长时不适用（术语应为词组级别）
    const termBtn = $('[data-act="term"]');
    if (fwState.kind === 'explain') {
      termBtn.style.display = '';
      termBtn.disabled = !(fwState.done && fwState.mainText) || fwState.savedTerm
        || (fwState.selection || '').trim().length > 40;
      termBtn.textContent = fwState.savedTerm ? '已存术语' : '存术语';
    } else {
      termBtn.style.display = 'none';
    }
  }

  async function doCopy() {
    const text = fwState ? fwState.mainText : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = fwShadow.querySelector('[data-act="copy"]');
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    } catch (e) { /* 页面无剪贴板权限时忽略 */ }
  }

  // 导出 Markdown：内容为 background 在任务结束时下发、缓存在 fwState 的完整文档
  // （生成结果 + 原文），本地 Blob 下载，不依赖后台存活
  function doExport() {
    const md = fwState ? fwState.exportMd : '';
    if (!md) return;
    const btn = fwShadow.querySelector('[data-act="export"]');
    try {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
        + '_' + pad(d.getHours()) + pad(d.getMinutes());
      // 文件名剔除 Windows 非法字符，标题截断防止过长
      const safeTitle = ((fwState.source && fwState.source.title) || 'export')
        .replace(/[\\/:*?"<>|#\r\n]/g, '').slice(0, 40).trim() || 'export';
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'PageSense_' + safeTitle + '_' + stamp + '.md';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (btn) {
        btn.textContent = '已导出';
        setTimeout(() => { btn.textContent = '导出 MD'; }, 1200);
      }
    } catch (e) { /* 下载失败时忽略 */ }
  }

  function sendRegenerate() {
    if (!fwState || fwState.streaming) return;
    sendJob(MSG.REGENERATE, {});
  }

  // ---------------- 收藏本 / 术语本 ----------------
  // 收藏当前结果到收藏本（background 统一写入，带上来源信息）
  async function doSaveClip() {
    if (!fwState || !fwState.done || !fwState.mainText || fwState.savedClip) return;
    if (!extAlive()) return;
    try {
      const res = await chrome.runtime.sendMessage({
        type: MSG.SAVE_CLIP,
        payload: {
          title: (fwState.source && fwState.source.title) || document.title || '',
          url: (fwState.source && fwState.source.url) || location.href,
          kind: fwState.kind,
          text: fwState.mainText
        }
      });
      if (res && res.ok) {
        fwState.savedClip = true;
        fwRender();
      } else {
        const btn = fwShadow.querySelector('[data-act="clip"]');
        btn.textContent = '失败';
        setTimeout(fwRender, 1200);
      }
    } catch (e) { /* 上下文失效等异常，忽略 */ }
  }

  // 把解释结果一键存为术语：选中文本作术语名，解释内容作为期望解释
  async function doSaveTerm() {
    if (!fwState || !fwState.done || !fwState.mainText || fwState.savedTerm) return;
    if (!extAlive()) return;
    try {
      const res = await chrome.runtime.sendMessage({
        type: MSG.ADD_TERM,
        payload: { term: fwState.selection || '', note: fwState.mainText }
      });
      if (res && res.ok) {
        fwState.savedTerm = true;
        fwRender();
      } else {
        const btn = fwShadow.querySelector('[data-act="term"]');
        btn.textContent = '失败';
        setTimeout(fwRender, 1200);
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---------------- 消息处理 ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    switch (msg.type) {
      // ---- 提取类（background 请求） ----
      case MSG.EXTRACT_CONTENT:
        sendResponse(extractContent());
        return;
      case MSG.GET_SELECTION:
        sendResponse({ text: currentSelectionText(), title: document.title, url: location.href });
        return;
      // ---- 任务广播（background 推送到结果卡片） ----
      case MSG.JOB_START: {
        fwState = {
          jobId: msg.jobId,
          kind: msg.kind,
          source: msg.source,
          selection: msg.selection || '',  // 解释任务的选中文本（存术语按钮用作术语名）
          streaming: true,
          done: false,
          error: null,
          mainText: '',
          exportMd: null,
          savedClip: false,
          savedTerm: false,
          statusText: msg.kind === 'summarize' ? '正在阅读页面…' : '正在生成…'
        };
        showFloatWindow();
        fwRender();
        break;
      }
      case MSG.LLM_CHUNK: {
        if (!fwState || msg.jobId !== fwState.jobId) break;
        if (msg.reset) fwState.mainText = '';
        fwState.streaming = true;
        fwState.mainText += msg.delta || '';
        fwScheduleRender();
        break;
      }
      case MSG.LLM_DONE: {
        if (!fwState || msg.jobId !== fwState.jobId) break;
        fwState.streaming = false;
        fwState.done = true;
        fwState.statusText = '';
        fwState.exportMd = msg.markdown || null; // 完整导出文档（生成结果 + 原文）
        fwRender();
        break;
      }
      case MSG.LLM_ERROR: {
        if (!fwState || msg.jobId !== fwState.jobId) break;
        fwState.streaming = false;
        fwState.error = msg.message;
        fwState.statusText = '';
        if (msg.clearText) fwState.mainText = ''; // 出错前的进度提示无保留价值
        fwRender();
        break;
      }
      case MSG.LLM_CANCELLED: {
        if (!fwState || msg.jobId !== fwState.jobId) break;
        fwState.streaming = false;
        fwState.done = true;
        fwState.statusText = '已停止';
        fwState.exportMd = msg.markdown || null; // 半截结果同样可导出
        fwRender();
        break;
      }
    }
  });
})();
