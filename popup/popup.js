// PageSense Popup：页面状态展示与操作入口
(() => {
  'use strict';

  const btnSummarize = document.getElementById('btn-summarize');
  const btnOptions = document.getElementById('btn-options');
  const pageTitle = document.getElementById('page-title');
  const configWarn = document.getElementById('config-warn');

  let currentTab = null;

  // 判断页面是否可被注入（排除 edge://、商店页、PDF 等）
  function isInjectable(url) {
    return /^https?:\/\//.test(url || '');
  }

  async function init() {
    // 读取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab || null;
    const url = currentTab && currentTab.url || '';

    if (isInjectable(url)) {
      pageTitle.textContent = currentTab.title || url;
      pageTitle.classList.add('ok');
    } else {
      pageTitle.textContent = '当前页面不支持（浏览器内部页面/商店/阅读器）';
      btnSummarize.disabled = true;
    }

    // 检查配置
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      configWarn.classList.remove('hidden');
      btnSummarize.disabled = true;
    }
  }

  btnSummarize.addEventListener('click', () => {
    if (!currentTab) return;
    chrome.runtime.sendMessage({
      type: MSG.SUMMARIZE_PAGE,
      payload: { tabId: currentTab.id }
    }).catch(() => {});
    window.close(); // 关闭 popup，避免遮挡页面内的悬浮窗
  });

  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  init();
})();
