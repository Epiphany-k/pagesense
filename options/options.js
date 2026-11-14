// PageSense 设置页：读写配置、测试 API 连通性
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const elBaseUrl = $('opt-baseurl');
  const elApiKey = $('opt-apikey');
  const elModel = $('opt-model');
  const elTemperature = $('opt-temperature');
  const elStyle = $('opt-style');
  const elCustomStyle = $('opt-customstyle');
  const customStyleField = $('custom-style-field');
  const elLanguage = $('opt-language');
  const elReminder = $('opt-reminder');
  const elLauncher = $('opt-launcher');
  const btnSave = $('btn-save');
  const btnTest = $('btn-test');
  const saveResult = $('save-result');
  const testResult = $('test-result');

  function collectForm() {
    return {
      baseUrl: elBaseUrl.value.trim(),
      apiKey: elApiKey.value.trim(),
      model: elModel.value.trim(),
      temperature: Math.min(1, Math.max(0, Number(elTemperature.value) || 0.3)),
      style: elStyle.value,
      customStyle: elCustomStyle.value.trim(),
      language: elLanguage.value,
      reminderMinutes: Math.min(180, Math.max(0, Number(elReminder.value) || 0)),
      launcherEnabled: elLauncher.checked
    };
  }

  async function loadForm() {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    elBaseUrl.value = cfg.baseUrl || '';
    elApiKey.value = cfg.apiKey || '';
    elModel.value = cfg.model || '';
    elTemperature.value = cfg.temperature;
    elStyle.value = cfg.style;
    elCustomStyle.value = cfg.customStyle || '';
    elLanguage.value = cfg.language;
    elReminder.value = cfg.reminderMinutes || 0;
    elLauncher.checked = cfg.launcherEnabled !== false;
  }

  // 表单字段以外的配置（如术语本 glossary）不可被覆盖：先读旧值再合并写入
  async function persistForm() {
    const form = collectForm();
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const prev = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    const cfg = Object.assign({}, prev, form);
    await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
    return cfg;
  }

  async function save() {
    const cfg = collectForm();
    // 自定义风格必须填写要求，否则保存无意义
    if (cfg.style === 'custom' && !cfg.customStyle) {
      saveResult.textContent = '选择了自定义风格，请填写风格要求';
      saveResult.className = 'err';
      return;
    }
    await persistForm();
    saveResult.textContent = '已保存 ✓';
    saveResult.className = '';
    setTimeout(() => { saveResult.textContent = ''; }, 1500);
  }

  // 摘要风格切换：仅 custom 时显示自定义要求输入框
  function syncCustomStyleField() {
    customStyleField.style.display = elStyle.value === 'custom' ? '' : 'none';
  }

  async function testApi() {
    const cfg = collectForm();
    testResult.textContent = '测试中…';
    testResult.className = '';
    try {
      // 先保存当前输入，保证后台读取到最新配置
      await persistForm();
      const res = await chrome.runtime.sendMessage({ type: MSG.TEST_API });
      if (res && res.ok) {
        testResult.textContent = res.message;
        testResult.className = 'ok';
      } else {
        testResult.textContent = (res && res.message) || '测试失败';
        testResult.className = 'err';
      }
    } catch (e) {
      testResult.textContent = '测试失败：' + (e.message || '未知错误');
      testResult.className = 'err';
    }
  }

  btnSave.addEventListener('click', save);
  btnTest.addEventListener('click', testApi);
  elStyle.addEventListener('change', syncCustomStyleField);

  loadForm().then(syncCustomStyleField);

  // ---------------- 收藏本 ----------------
  const clipsList = $('clips-list');
  const clipsCount = $('clips-count');
  const clipSearch = $('clips-search');
  const KIND_NAMES = { summarize: '整页摘要', 'summarize-selection': '划词摘要', explain: '划词解释' };
  let clipsData = [];    // 全量收藏（渲染时按关键字过滤）
  let clipQuery = '';    // 当前搜索关键字

  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  async function loadClips() {
    const stored = await chrome.storage.local.get(CLIPS_KEY);
    clipsData = stored[CLIPS_KEY] || [];
    renderClips();
  }

  // 按关键字过滤并渲染：匹配标题或内容（大小写不敏感），无关键字时展示全部
  function renderClips() {
    const q = clipQuery.toLowerCase();
    const clips = q
      ? clipsData.filter(c =>
          (c.title || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q))
      : clipsData;
    clipsCount.textContent = clipsData.length
      ? (q ? '匹配 ' + clips.length + ' / ' + clipsData.length + ' 条' : '共 ' + clipsData.length + ' 条')
      : '';
    clipsList.textContent = '';
    if (!clips.length) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = q ? '没有匹配的收藏。' : '暂无收藏。';
      clipsList.appendChild(empty);
      return;
    }
    for (const clip of clips) {
      const item = document.createElement('details');
      item.className = 'list-item';
      const head = document.createElement('summary');
      const meta = document.createElement('span');
      meta.className = 'item-meta';
      meta.textContent = fmtTime(clip.time) + ' · ' + (KIND_NAMES[clip.kind] || clip.kind);
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = clip.title || '(无标题)';
      head.append(meta, title);
      item.appendChild(head);
      const body = document.createElement('div');
      body.className = 'item-body';
      body.textContent = clip.text || '';
      item.appendChild(body);
      const row = document.createElement('div');
      row.className = 'item-actions';
      const link = document.createElement('a');
      link.className = 'mini-link';
      link.href = clip.url || '#';
      link.target = '_blank';
      link.textContent = '打开来源';
      const del = document.createElement('button');
      del.className = 'mini-btn';
      del.textContent = '删除';
      del.addEventListener('click', () => deleteClip(clip.id));
      row.append(link, del);
      item.appendChild(row);
      clipsList.appendChild(item);
    }
  }

  clipSearch.addEventListener('input', () => {
    clipQuery = clipSearch.value.trim();
    renderClips();
  });

  async function deleteClip(id) {
    const stored = await chrome.storage.local.get(CLIPS_KEY);
    const clips = (stored[CLIPS_KEY] || []).filter(c => c.id !== id);
    await chrome.storage.local.set({ [CLIPS_KEY]: clips });
    loadClips();
  }

  $('btn-clips-clear').addEventListener('click', async () => {
    if (!confirm('确定清空全部收藏？此操作不可恢复。')) return;
    await chrome.storage.local.set({ [CLIPS_KEY]: [] });
    loadClips();
  });

  // 导出全部收藏为一个 Markdown 文档（每条含来源、时间与结果）
  $('btn-clips-export').addEventListener('click', async () => {
    const stored = await chrome.storage.local.get(CLIPS_KEY);
    const clips = stored[CLIPS_KEY] || [];
    if (!clips.length) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const md = ['# PageSense 收藏本', '', '- 导出时间：' + fmtTime(d.toISOString()), '']
      .concat(clips.map(c => [
        '## ' + (c.title || '(无标题)') + '（' + (KIND_NAMES[c.kind] || c.kind) + '）',
        '',
        '- 来源：' + (c.url || ''),
        '- 收藏时间：' + fmtTime(c.time),
        '',
        c.text || '',
        ''
      ].join('\n')).join('\n---\n\n'))
      .join('\n') + '\n';
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + '_' + pad(d.getHours()) + pad(d.getMinutes());
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'PageSense_收藏本_' + stamp + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------------- 术语本 ----------------
  const termsList = $('terms-list');
  const elTerm = $('opt-term');
  const elTermNote = $('opt-term-note');
  const termMsg = $('term-msg');

  async function loadTerms() {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    const glossary = cfg.glossary || [];
    termsList.textContent = '';
    if (!glossary.length) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = '暂无术语。';
      termsList.appendChild(empty);
      return;
    }
    for (const t of glossary) {
      const line = document.createElement('div');
      line.className = 'list-item term-line';
      const term = document.createElement('strong');
      term.textContent = t.term;
      const note = document.createElement('span');
      note.className = 'term-note';
      note.textContent = t.note;
      const del = document.createElement('button');
      del.className = 'mini-btn';
      del.textContent = '删除';
      del.addEventListener('click', () => deleteTerm(t.term));
      line.append(term, note, del);
      termsList.appendChild(line);
    }
  }

  // 术语增删直接读改写存储中的 glossary 字段，不经过表单（避免覆盖未保存的输入）
  async function addTerm() {
    const term = elTerm.value.trim().slice(0, 40);
    const note = elTermNote.value.trim().slice(0, 200);
    if (!term || !note) {
      termMsg.textContent = '术语与解释均不能为空';
      termMsg.className = 'err';
      return;
    }
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    const glossary = (cfg.glossary || []).filter(t => t.term !== term); // 同名覆盖
    glossary.unshift({ term, note });
    cfg.glossary = glossary.slice(0, 100);
    await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
    elTerm.value = '';
    elTermNote.value = '';
    termMsg.textContent = '已添加 ✓';
    termMsg.className = '';
    setTimeout(() => { termMsg.textContent = ''; }, 1500);
    loadTerms();
  }

  async function deleteTerm(term) {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
    cfg.glossary = (cfg.glossary || []).filter(t => t.term !== term);
    await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
    loadTerms();
  }

  $('btn-add-term').addEventListener('click', addTerm);

  loadClips();
  loadTerms();
})();
