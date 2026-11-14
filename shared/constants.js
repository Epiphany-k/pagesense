// PageSense 共享常量：消息类型、存储键、默认配置
// 被 background（importScripts）、content（manifest 注入）、各扩展页面（<script>）共用

// 消息类型
// 任务类消息（JOB_START/LLM_CHUNK/LLM_DONE/LLM_ERROR）由 background
// 通过 chrome.tabs.sendMessage 定向发往对应标签页的悬浮窗（content script）
const MSG = {
  // 触发类（content/popup → background）
  SUMMARIZE_PAGE: 'SUMMARIZE_PAGE',           // 摘要整页
  SUMMARIZE_SELECTION: 'SUMMARIZE_SELECTION', // 摘要选中内容
  EXPLAIN_SELECTION: 'EXPLAIN_SELECTION',     // 解释选中内容
  REGENERATE: 'REGENERATE',                   // 悬浮窗 → background：重新生成
  CANCEL_JOB: 'CANCEL_JOB',                   // 悬浮窗 → background：停止当前任务
  OPEN_OPTIONS: 'OPEN_OPTIONS',               // 任意 → background：打开设置页
  TEST_API: 'TEST_API',                       // options → background：测试 API 连通性
  SAVE_CLIP: 'SAVE_CLIP',                     // 悬浮窗 → background：收藏当前结果到收藏本
  ADD_TERM: 'ADD_TERM',                       // 悬浮窗 → background：把解释结果存为术语
  // 提取类（background ↔ content）
  EXTRACT_CONTENT: 'EXTRACT_CONTENT',         // background → content：请求提取正文
  GET_SELECTION: 'GET_SELECTION',             // background → content：请求当前选区
  // 任务广播（background → 悬浮窗）
  JOB_START: 'JOB_START',                     // 新任务开始
  LLM_CHUNK: 'LLM_CHUNK',                     // 流式片段
  LLM_DONE: 'LLM_DONE',                       // 流结束
  LLM_ERROR: 'LLM_ERROR',                     // 出错（clearText=true 表示进度文本应清除）
  LLM_CANCELLED: 'LLM_CANCELLED'              // 用户停止，保留已生成的部分内容
};

// 存储键
const CONFIG_KEY = 'pagesense_config';
const CLIPS_KEY = 'pagesense_clips'; // 收藏本（收藏的摘要/解释结果）
const MAX_CLIPS = 50;                // 收藏本容量上限（超出丢弃最旧）
const LAUNCHER_ICON_KEY = 'pagesense_launcher_icon'; // 悬浮球形象（桌宠）：{type:'default'|'emoji'|'image', value, lastImage}

// 默认配置
const DEFAULT_CONFIG = {
  baseUrl: '',        // 兼容 OpenAI Chat Completions 格式的接口地址
  apiKey: '',
  model: '',
  temperature: 0.3,
  style: 'standard',  // brief | standard | detailed | custom
  customStyle: '',    // 自定义摘要风格指令（style=custom 时生效）
  language: 'zh',     // zh | en | auto
  reminderMinutes: 0, // 阅读提醒间隔（分钟），0 = 关闭
  launcherEnabled: true,  // 页面常驻悬浮球开关
  glossary: []        // 术语本：[{term, note}]，摘要/解释时注入 prompt 提供用户的术语语境
};

// 长文本处理阈值（按字符估算，1 token ≈ 2 字符）
const SEGMENT_CHARS = 9000;    // 单段摘要上限
const MAX_TOTAL_CHARS = 60000; // 正文处理硬上限
