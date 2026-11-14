// PageSense 后台 Service Worker：消息路由、LLM 调用（SSE 流式）、摘要编排（Map-Reduce）
// 结果流式消息通过 chrome.tabs.sendMessage 定向发往页内悬浮窗（content script）
importScripts('/shared/constants.js');

// ---------------- 配置 ----------------
async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
}

// 定向广播：发往任务所在标签页的悬浮窗；无 tabId 时退回扩展页面
function broadcast(msg, tabId) {
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  } else {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
}

// ---------------- 停滞超时看门狗 ----------------
// 每收到一次数据（chunk）就重置计时；超过 timeoutMs 无任何数据则自动中断请求，
// 避免网络挂起时任务永远停在"正在生成…"
function createStallGuard(timeoutMs = 90000) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    touch() { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), timeoutMs); },
    // 主动取消（用户点击"停止"）
    abort() { clearTimeout(timer); try { ctrl.abort(); } catch (e) { /* 忽略 */ } },
    // 任务正常结束后清掉定时器
    stop() { clearTimeout(timer); }
  };
}

// ---------------- LLM 调用 ----------------
// 规范化端点：自动补全 /v1/chat/completions
function normalizeEndpoint(base) {
  const url = String(base || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(url)) return url;
  if (/\/v\d+$/.test(url)) return url + '/chat/completions';
  return url + '/v1/chat/completions';
}

/**
 * 调用 LLM（OpenAI Chat Completions 兼容格式）
 * stream=true 时通过 SSE 逐块解析并回调 onChunk(delta)
 * guard: createStallGuard() 实例，提供超时中断与数据触活
 */
async function callLLM(cfg, messages, { stream = true, onChunk = null, guard = null } = {}) {
  const endpoint = normalizeEndpoint(cfg.baseUrl);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: Number(cfg.temperature) || 0.3,
      stream
    }),
    signal: guard ? guard.signal : undefined
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (!stream) {
    const data = await res.json();
    const c = data.choices && data.choices[0];
    return (c && c.message && c.message.content) || '';
  }
  // SSE 流式解析
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (guard) guard.touch(); // 收到数据，重置停滞计时
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (let line of lines) {
      line = line.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const c = json.choices && json.choices[0];
        const delta = c && c.delta && c.delta.content;
        if (delta) {
          full += delta;
          if (onChunk) onChunk(delta);
        }
      } catch (e) { /* 跳过无法解析的行 */ }
    }
  }
  return full;
}

function friendlyError(e) {
  const s = e && e.status;
  if (s === 401 || s === 403) return 'API 密钥无效或无权限（' + s + '），请到设置页检查配置。';
  if (s === 404) return '接口地址或模型名称可能不正确（404），请检查 Base URL 与模型名。';
  if (s >= 500) return '模型服务端错误（' + s + '），请稍后重试。';
  if (s === 429) return '请求过于频繁（429），请稍后重试。';
  if (e instanceof TypeError) return '网络请求失败，请检查 API 地址是否可访问。';
  return '请求失败：' + ((e && e.message) || '未知错误') + (e && e.detail ? '（' + e.detail + '）' : '');
}

// ---------------- 提示词 ----------------
function langInstruction(cfg) {
  if (cfg.language === 'en') return '必须全程使用英语输出。';
  if (cfg.language === 'auto') return '使用与正文/选中文本相同的语言输出。';
  return '必须全程使用中文输出。';
}

function outputLangName(cfg) {
  if (cfg.language === 'en') return '英语';
  if (cfg.language === 'auto') return '与原文相同的语言';
  return '中文';
}

// 术语本注入：用户维护的术语解释偏好，非空时拼入 system prompt，
// 让摘要/解释按用户的语境理解专有名词（截断控制 prompt 体积）
function glossaryBlock(cfg) {
  const g = (cfg.glossary || []).filter(t => t && t.term && t.note);
  if (!g.length) return null;
  return ['【术语表】用户维护的术语解释偏好，遇到相关术语时按此理解与解释：']
    .concat(g.slice(0, 20).map(t => '- ' + String(t.term).slice(0, 40) + '：' + String(t.note).slice(0, 100)))
    .join('\n');
}

function summarizeSystem(cfg) {
  const structures = {
    brief: '用一句话（50 字以内）讲清正文核心，只输出这一句。',
    standard: '先用一句话（50 字以内）讲清核心，再补最多 3 条要点，每条不超过 30 字。',
    detailed: '用一小段话（150 字以内）讲清正文的核心内容与结论。'
  };
  const isCustom = cfg.style === 'custom' && cfg.customStyle;
  const styleReq = isCustom
    ? '按照用户的风格要求输出摘要：' + cfg.customStyle
    : (structures[cfg.style] || structures.standard);
  // 预设风格保留行数硬限制；自定义风格由用户要求决定形式与篇幅，不强加行数
  const lines = isCustom
    ? []
    : ['- 要点用无序列表，写成简短的自然句，不罗列名词；整体不超过 ' + (cfg.style === 'detailed' ? 6 : 5) + ' 行'];
  const gl = glossaryBlock(cfg);
  return [
    '你是网页摘要助手，把网页内容压缩成简洁明了的概括，让人几秒钟抓住重点。',
    '',
    '【输出格式（最高优先级，必须严格遵守）】',
    styleReq,
    ...lines,
    '- 不使用"一句话摘要/关键要点/总结"等任何标题，直接输出内容',
    '',
    '【忠实性】只依据给定正文，不编造；保留关键数字、名称与结论；有立场时中立转述。',
    '',
    '【表达风格】在严格满足上述格式的前提下，语气自然平实：像转述给朋友听，直给结论，不用汇报腔，不写空洞套话。',
    '',
    '【语言】' + langInstruction(cfg)
  ].concat(gl ? ['', gl] : []).join('\n');
}

function explainSystem(cfg) {
  const gl = glossaryBlock(cfg);
  return [
    '你是网页阅读助手，用通俗易懂的话帮用户看懂选中的内容，像给朋友讲解一样自然。',
    '',
    '【解释规则】',
    '- 术语/词组：一两句话讲清它是什么，必要时打个贴切的比方',
    '- 句子：用大白话讲这句话在说什么，点出关键概念',
    '- 段落：概括核心意思',
    '- 代码：说明这段代码做了什么',
    '- 外语：给出准确自然的翻译；翻译后已经够清楚就不再解释',
    '',
    '【输出要求（最高优先级）】',
    '- 直接输出解释本身，禁止"含义/通俗理解/补充"等分节标题',
    '- 通俗易懂优先：首次出现的专业词顺带一句人话解释，不掉书袋',
    '- 不重复原文，不铺垫、不客套、不总结收尾',
    '- 简短：简单内容一句话讲清，复杂内容用几句话讲透，不展开使用场景与示例',
    '- 不确定就明说，不编造',
    langInstruction(cfg)
  ].concat(gl ? ['', gl] : []).join('\n');
}

// ---------------- 任务编排 ----------------
// 每个标签页独立持有一个任务：多标签页并发互不覆盖，
// 同标签页发起新任务时自动取消旧任务
const jobsByTab = new Map(); // tabId（或 '_'）→ job
const jobKey = (tabId) => (tabId != null ? tabId : '_');

function cancelJob(job) {
  if (job.done) return;
  job.cancelled = true; // 标记用户主动取消，与超时中断区分
  job.guard.abort();
}

// 标签页关闭时清理对应任务
chrome.tabs.onRemoved.addListener((tabId) => {
  jobsByTab.delete(tabId);
});

function streamToPanel(job, delta, reset) {
  if (reset) job.partial = '';
  job.partial += delta;
  broadcast({ type: MSG.LLM_CHUNK, jobId: job.jobId, delta, reset: !!reset }, job.tabId);
}

function splitSegments(text, size) {
  const paras = String(text).split('\n');
  const segs = [];
  let cur = '';
  for (let raw of paras) {
    let p = raw;
    // 超长单段按字符硬切
    while (p.length > size) {
      if (cur) { segs.push(cur); cur = ''; }
      segs.push(p.slice(0, size));
      p = p.slice(size);
    }
    if (cur && (cur + '\n' + p).length > size) { segs.push(cur); cur = p; }
    else { cur = cur ? cur + '\n' + p : p; }
  }
  if (cur) segs.push(cur);
  return segs;
}

// 组装摘要的 user 内容；长文走 Map-Reduce，job 用于推送进度与传递取消信号
async function summarizeUser(cfg, input, job) {
  const progress = (d) => streamToPanel(job, d);
  const c = input.content || {};
  let head = '【网页标题】' + (c.title || '(无标题)') + '\n';
  let text = c.text || '';
  if (!text) return head;

  // 划词摘要：明确告知只概括选中部分，避免模型当成整页正文
  if (input.selectionBased) {
    return head + '\n【用户在网页上选中的段落，请只概括这段内容】\n' + text;
  }

  if (c.desc) head += '【页面描述】' + c.desc + '\n';
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(0, MAX_TOTAL_CHARS);
    progress('（正文过长，仅处理前 ' + MAX_TOTAL_CHARS + ' 字）\n\n');
  }
  if (text.length <= SEGMENT_CHARS * 2) {
    // 提取文本明显偏短：提示用户可能受动态加载影响（仅整页摘要会走到这里）
    if (text.length < 500) {
      progress('（提示：提取到的正文较短，若页面内容为动态加载，摘要可能不完整）\n\n');
    }
    return head + '\n【正文】\n' + text;
  }
  // Map-Reduce：分段摘要后合并（限流并发）
  const segs = splitSegments(text, SEGMENT_CHARS);
  const briefs = new Array(segs.length); // 按序占位，乱序完成也能正确拼接
  const langNote = outputLangName(cfg);
  const segSystem = '你是分段摘要助手。请用' + langNote + '把该段内容提炼为 3~6 条要点，以 Markdown 无序列表输出，只基于给定内容，不编造。';
  // 并发 3：总耗时从"段数×单段"降为"约段数÷3×单段"，同时避免高并发触发 API 限流（429）
  const CONCURRENCY = 3;
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      // 取消/超时中断：不再领取新分段；在途请求由共享的 guard.signal 自动中断
      if (job.guard.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      const i = next++;
      if (i >= segs.length) return;
      const s = await callLLM(cfg, [
        { role: 'system', content: segSystem },
        { role: 'user', content: segs[i] }
      ], { stream: false, guard: job.guard });
      briefs[i] = '【第 ' + (i + 1) + ' 段要点】\n' + s;
      done++;
      progress('（长文分段摘要中：已完成 ' + done + '/' + segs.length + ' 段…）\n\n');
    }
  };
  progress('（长文分段摘要中：共 ' + segs.length + ' 段，并发处理…）\n\n');
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));
  progress('（分段完成，正在生成整体摘要…）\n\n');
  return head + '\n【正文较长，以下是各分段要点，请综合它们生成整体摘要】\n\n' + briefs.join('\n\n');
}

function explainUser(input) {
  return '【来源网页】' + (input.title || '') + ' ' + (input.url || '') + '\n\n【选中的内容】\n' + (input.text || '');
}

// ---------------- 导出 Markdown ----------------
// 导出原文清洗：行级启发式过滤，剔除站点噪音（互动按钮、导航链接、日期统计、
// 版权声明、重复渲染的段落），只保留正文内容，不做内容改写。
const EXPORT_NOISE_LINE_RE = /^(阅读全文|展开全文|全文|展开|收起|查看更多|加载更多|相关阅读|相关推荐|猜你喜欢|热门推荐|为您推荐|热门文章|延伸阅读|更多推荐|广告|推广|举报|投诉|意见反馈|登录|注册|关注|已关注|取关|点赞|点个赞|收藏|分享|转发|评论|发表评论|全部评论|热门评论|最新评论|回到顶部|返回顶部|上一篇|下一篇|上一页|下一页|全文完|完)$/;
const EXPORT_STAT_LINE_RE = /^[\d\s.,，:：年月日时分秒万百千\-—\/]+$/; // 纯数字/日期/统计行

function cleanRawForExport(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let prev = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue; // 空行
    if (EXPORT_STAT_LINE_RE.test(line) && line.length < 20) continue; // "2023-01-01"、"1.2万"
    if (EXPORT_NOISE_LINE_RE.test(line) && line.length <= 8) continue;  // 短互动/导航行
    if (/^\d+(\.\d+)?\s*万?\s*(阅读|浏览|播放|评论|点赞|收藏|转发|人气|人看过)?$/.test(line)
      && line.length <= 12) continue; // "345"、"1.2万阅读"类统计
    if (line.length < 60 && /^(版权所有|版权声明|免责声明|©|copyright)/i.test(line)) continue;
    // 连续重复行：仅对长行去重（站点重复渲染的整段），短行重复可能是代码/列表的合法结构
    if (line.length > 30 && line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out.join('\n');
}

// 任务完成后组装"生成结果 + 原文"的完整 Markdown，随结束广播发给悬浮窗；
// 导出动作完全在页面本地完成（Blob 下载），不依赖 service worker 是否存活
function buildExportMarkdown(job) {
  const src = job.source || {};
  const kindName = job.kind === 'explain' ? '划词解释'
    : job.kind === 'summarize-selection' ? '划词摘要' : '整页摘要';
  // 原文：划词任务用选中文本，整页任务用提取正文，统一做噪音清洗
  const raw = (job.input && job.input.text)
    || (job.input && job.input.content && job.input.content.text)
    || '';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return [
    '# ' + (src.title || '网页内容') + '（' + kindName + '）',
    '',
    '- 来源：' + (src.url || ''),
    '- 生成时间：' + date,
    '',
    '## ' + (job.kind === 'explain' ? '解释' : '摘要'),
    '',
    (job.result || job.partial || '').trim(),
    '',
    '## 原文',
    '',
    cleanRawForExport(raw) || '(未提取到原文)'
  ].join('\n') + '\n';
}

// 统一任务入口：kind = summarize | summarize-selection | explain
async function startJob(kind, input, tabId) {
  // 划词摘要统一转换为 content 结构，复用长文 Map-Reduce 逻辑
  if (kind === 'summarize-selection' && !input.content && input.text) {
    input.content = { title: input.title, url: input.url, desc: '', text: input.text };
    input.selectionBased = true; // Prompt 中明确只概括选中部分
  }
  const cfg = await getConfig();
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const source = input.source
    || (input.content ? { title: input.content.title, url: input.content.url } : { title: input.title, url: input.url });

  const guard = createStallGuard();
  const job = {
    jobId, kind, input, tabId, source, messages: [], result: '', partial: '',
    done: false, error: null, cancelled: false, resetSent: false, guard
  };
  // 同标签页已有进行中的任务：先取消，避免两个请求同时流到同一悬浮窗
  const prev = jobsByTab.get(jobKey(tabId));
  if (prev && !prev.done) cancelJob(prev);
  jobsByTab.set(jobKey(tabId), job);
  // 解释任务附带选中文本：结果卡片"存术语"按钮用它作为术语名
  broadcast({
    type: MSG.JOB_START, jobId, kind, source,
    selection: (kind === 'explain' && input && input.text) || ''
  }, tabId);

  // 前置校验：配置缺失 / 无正文 / 无选区
  let preError = null;
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    preError = '尚未配置 API，请先在设置页填写 Base URL、API Key 和模型名称。';
  } else if (input.error) {
    preError = input.error;
  } else if (kind === 'summarize' && (!input.content || !input.content.text || input.content.text.length < 30)) {
    preError = '未能从此页面提取到正文（可能是浏览器内部页面、商店页面或纯媒体页）。';
  } else if ((kind === 'explain' || kind === 'summarize-selection') && !input.text) {
    preError = '未获取到选中的文本，请先选中内容后再试。';
  }
  if (preError) {
    job.error = preError;
    job.done = true;
    guard.stop();
    broadcast({ type: MSG.LLM_ERROR, jobId, message: preError, clearText: true }, tabId);
    return;
  }

  try {
    let system, user;
    if (kind === 'explain') {
      system = explainSystem(cfg);
      user = explainUser(input);
    } else {
      system = summarizeSystem(cfg);
      user = await summarizeUser(cfg, input, job);
    }
    job.messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];

    // Map-Reduce 的进度提示不算入最终结果：真正开始输出时重置悬浮窗内容
    const full = await callLLM(cfg, job.messages, {
      guard,
      onChunk: (delta) => {
        if (!job.resetSent) { streamToPanel(job, '', true); job.resetSent = true; }
        streamToPanel(job, delta);
      }
    });
    job.result = full || job.partial;
    job.done = true;
    job.messages.push({ role: 'assistant', content: job.result });
    broadcast({ type: MSG.LLM_DONE, jobId, result: job.result, markdown: buildExportMarkdown(job) }, tabId);
  } catch (e) {
    if (job.cancelled) {
      // 用户主动停止
      if (job.resetSent) {
        // 已有正式输出：保留部分内容，标记为已停止（半截结果也可导出）
        job.done = true;
        broadcast({ type: MSG.LLM_CANCELLED, jobId: job.jobId, markdown: buildExportMarkdown(job) }, tabId);
      } else {
        // 尚无正式输出（如分段摘要阶段）：进度文本无保留价值，按已停止报错展示
        job.done = true;
        broadcast({ type: MSG.LLM_ERROR, jobId: job.jobId, message: '已停止。', clearText: true }, tabId);
      }
    } else if (e && e.name === 'AbortError') {
      // 停滞超时：90 秒无任何数据返回，已自动中断
      job.error = '请求超时（90 秒无数据返回），已自动停止，可重试。';
      job.done = true;
      broadcast({ type: MSG.LLM_ERROR, jobId: job.jobId, message: job.error, clearText: !job.resetSent }, tabId);
    } else {
      job.error = friendlyError(e);
      job.done = true;
      broadcast({ type: MSG.LLM_ERROR, jobId: job.jobId, message: job.error, clearText: !job.resetSent }, tabId);
    }
  } finally {
    guard.stop(); // 清掉看门狗定时器
  }
}

// ---------------- 内容提取 ----------------
async function extractTabContent(tabId) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT_CONTENT });
  } catch (e) {
    // 页面在插件安装前已加载，content script 不存在 → 动态注入后重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['/shared/constants.js', '/shared/markdown.js', '/content/content.js']
      });
      return await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT_CONTENT });
    } catch (e2) {
      return null;
    }
  }
}

async function getTabSelection(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: MSG.GET_SELECTION });
  } catch (e) {
    return null;
  }
}

// ---------------- 消息路由 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case MSG.SUMMARIZE_PAGE: {
        const tabId = (msg.payload && msg.payload.tabId) || (sender.tab && sender.tab.id);
        const content = await extractTabContent(tabId);
        await startJob('summarize', { content, tabId }, tabId);
        sendResponse({ ok: true });
        break;
      }
      case MSG.SUMMARIZE_SELECTION:
      case MSG.EXPLAIN_SELECTION: {
        const kind = msg.type === MSG.EXPLAIN_SELECTION ? 'explain' : 'summarize-selection';
        const p = msg.payload || {};
        const tabId = sender.tab && sender.tab.id;
        await startJob(kind, {
          text: p.text || '',
          title: p.title, url: p.url, tabId,
          source: { title: p.title, url: p.url }
        }, tabId);
        sendResponse({ ok: true });
        break;
      }
      case MSG.REGENERATE: {
        const tabId = sender.tab && sender.tab.id;
        const job = jobsByTab.get(jobKey(tabId));
        if (job && job.input) {
          await startJob(job.kind, job.input, job.tabId);
        }
        sendResponse({ ok: !!job });
        break;
      }
      case MSG.CANCEL_JOB: {
        const tabId = sender.tab && sender.tab.id;
        const job = jobsByTab.get(jobKey(tabId));
        if (job) cancelJob(job);
        sendResponse({ ok: !!job });
        break;
      }
      case MSG.OPEN_OPTIONS: {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;
      }
      case MSG.SAVE_CLIP: {
        // 收藏当前结果到收藏本：最新在前，超上限丢弃最旧
        const p = msg.payload || {};
        const clip = {
          id: 'clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          time: new Date().toISOString(),
          title: String(p.title || '').slice(0, 200),
          url: String(p.url || '').slice(0, 500),
          kind: p.kind || '',
          text: String(p.text || '')
        };
        if (!clip.text) { sendResponse({ ok: false }); break; }
        try {
          const stored = await chrome.storage.local.get(CLIPS_KEY);
          const clips = stored[CLIPS_KEY] || [];
          clips.unshift(clip);
          if (clips.length > MAX_CLIPS) clips.length = MAX_CLIPS;
          await chrome.storage.local.set({ [CLIPS_KEY]: clips });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false });
        }
        break;
      }
      case MSG.ADD_TERM: {
        // 解释结果一键存术语：同术语名覆盖旧解释，最新在前
        const p = msg.payload || {};
        const term = String(p.term || '').trim().slice(0, 40);
        const note = String(p.note || '').trim().slice(0, 200);
        if (!term || !note) { sendResponse({ ok: false, message: '术语或解释为空' }); break; }
        try {
          const stored = await chrome.storage.local.get(CONFIG_KEY);
          const cfg = Object.assign({}, DEFAULT_CONFIG, stored[CONFIG_KEY] || {});
          const glossary = (cfg.glossary || []).filter(t => t.term !== term);
          glossary.unshift({ term, note });
          cfg.glossary = glossary.slice(0, 100);
          await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, message: '存储失败' });
        }
        break;
      }
      case MSG.TEST_API: {
        const cfg = await getConfig();
        if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
          sendResponse({ ok: false, message: '请先完整填写 Base URL、API Key 和模型名称。' });
          break;
        }
        try {
          const guard = createStallGuard(30000); // 连通性测试 30 秒超时
          try {
            const reply = await callLLM(cfg, [
              { role: 'system', content: '你是连通性测试助手。' },
              { role: 'user', content: '请只回复两个字：连通' }
            ], { stream: false, guard });
            sendResponse({ ok: true, message: '连接成功，模型可用。' + (reply ? '（模型回复：' + reply.slice(0, 20) + '）' : '') });
          } finally {
            guard.stop();
          }
        } catch (e) {
          const msg = (e && e.name === 'AbortError')
            ? '请求超时（30 秒无响应），请检查 API 地址与网络。'
            : friendlyError(e);
          sendResponse({ ok: false, message: msg });
        }
        break;
      }
    }
  })();
  return true; // 异步 sendResponse
});

// ---------------- 快捷键 ----------------
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'summarize') {
    const content = await extractTabContent(tab.id);
    await startJob('summarize', { content, tabId: tab.id }, tab.id);
  } else if (command === 'explain') {
    const sel = await getTabSelection(tab.id);
    if (sel && sel.text) {
      await startJob('explain', {
        text: sel.text, title: sel.title, url: sel.url, tabId: tab.id,
        source: { title: sel.title, url: sel.url }
      }, tab.id);
    } else {
      await startJob('explain', {
        text: '', error: '请先选中要解释的文本，再使用快捷键。',
        title: tab.title, url: tab.url, tabId: tab.id
      }, tab.id);
    }
  }
});

// ---------------- 右键菜单 ----------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ps-summarize-page', title: 'PageSense：摘要此页面', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'ps-explain-selection', title: 'PageSense：解释选中内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ps-summarize-selection', title: 'PageSense：摘要选中内容', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'ps-summarize-page') {
    const content = await extractTabContent(tab.id);
    await startJob('summarize', { content, tabId: tab.id }, tab.id);
  } else if (info.menuItemId === 'ps-explain-selection' || info.menuItemId === 'ps-summarize-selection') {
    const kind = info.menuItemId === 'ps-explain-selection' ? 'explain' : 'summarize-selection';
    const text = (info.selectionText || '').trim();
    if (!text) return;
    await startJob(kind, {
      text, title: tab.title, url: tab.url, tabId: tab.id,
      source: { title: tab.title, url: tab.url }
    }, tab.id);
  }
});
