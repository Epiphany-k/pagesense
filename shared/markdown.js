// PageSense 共享 Markdown 渲染器（极简实现：先转义 HTML 防注入，再替换标记）
// 被 content（manifest 注入）与其他扩展页面（<script>）共用

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// streaming=true 时在文末追加打字机光标
function renderMarkdown(src, streaming) {
  const lines = escapeHtml(src).split('\n');
  let html = '', inCode = false, codeBuf = [], inList = false;
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (let line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) { html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>'; codeBuf = []; inCode = false; }
      else { if (inList) { html += '</ul>'; inList = false; } inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const t = line.trim();
    if (!t) { if (inList) { html += '</ul>'; inList = false; } continue; }
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      if (inList) { html += '</ul>'; inList = false; }
      const lv = m[1].length;
      html += '<h' + (lv + 1) + '>' + inline(m[2]) + '</h' + (lv + 1) + '>';
      continue;
    }
    if ((m = t.match(/^[-*]\s+(.*)$/))) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inline(m[1]) + '</li>';
      continue;
    }
    if (/^&gt;\s?/.test(t)) {
      html += '<blockquote>' + inline(t.replace(/^&gt;\s?/, '')) + '</blockquote>';
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(t) + '</p>';
  }
  if (inCode) html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
  if (inList) html += '</ul>';
  if (streaming) html += '<span class="ps-cursor"></span>';
  return html;
}
