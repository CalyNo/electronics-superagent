// 管理员工作台：一个页面回答四个问题
//   1) 现在谁在干活、卡在哪（运行状态 / 队列 / 岗位）
//   2) 干出了什么（交付物清单，含结构校验与 AI 参与标记）
//   3) 门禁到哪一步了（缺什么）
//   4) 密钥是否可用、钱花在哪（池 / key / 用量）
// 纯静态 HTML + 原生 JS，无构建、无依赖。

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>工作台 · electronics-superagent</title>
<style>
  :root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6ea;--text:#1d2126;--muted:#6b7280;--ok:#1a7f4b;--warn:#a15c00;--bad:#b3261e;--accent:#1f5fa8;--chip:#eef2f7}
  @media (prefers-color-scheme:dark){:root{--bg:#14171a;--panel:#1b1f23;--line:#2c3238;--text:#e6e9ec;--muted:#9aa3ad;--ok:#4ec98a;--warn:#e0a34a;--bad:#ef6b62;--accent:#69a8ea;--chip:#22282e}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
  header.top{padding:14px 22px;border-bottom:1px solid var(--line);background:var(--panel);display:flex;gap:14px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5}
  h1{font-size:16px;margin:0;font-weight:650}
  a.nav{color:var(--accent);text-decoration:none;font-size:13px}
  a.nav:hover{text-decoration:underline}
  .muted{color:var(--muted);font-size:12.5px}
  main{padding:16px 22px;display:grid;gap:14px;max-width:1240px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  h2{font-size:12.5px;margin:0 0 12px;color:var(--muted);letter-spacing:.03em;text-transform:uppercase;font-weight:600}
  h3{font-size:14px;margin:0;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{color:var(--muted);font-weight:500;font-size:12px;white-space:nowrap}
  tr:last-child td{border-bottom:0}
  code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  .tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11.5px;border:1px solid var(--line);white-space:nowrap}
  .ok{color:var(--ok);border-color:currentColor}
  .warn{color:var(--warn);border-color:currentColor}
  .bad{color:var(--bad);border-color:currentColor}
  .kpi{display:flex;gap:26px;flex-wrap:wrap}
  .kpi div{min-width:80px}
  .kpi b{display:block;font-size:22px;font-weight:650;line-height:1.3}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(215px,1fr))}
  .card{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--panel)}
  .card header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
  .card .role{font-size:12.5px;color:var(--muted)}
  .card .line{font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pool{border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px}
  .pool>header{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;margin-bottom:8px}
  input,select{font:inherit;padding:5px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
  input[type=number]{width:118px}
  button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
  button:hover{border-color:var(--accent);color:var(--accent)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.primary:hover{opacity:.92;color:#fff}
  button.danger{color:var(--bad);border-color:currentColor}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
  .editor{background:var(--chip);border-radius:8px;padding:10px;margin:6px 0}
  .notice{border-left:3px solid var(--warn);padding:6px 10px;background:var(--chip);border-radius:4px;font-size:12.5px;color:var(--muted)}
  .empty{padding:8px 0;color:var(--muted);font-size:13px}
  #toast{position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:9}
  #toast div{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);padding:8px 12px;border-radius:6px;font-size:13px;max-width:400px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
  #toast div.bad{border-left-color:var(--bad)}
  #toast div.ok{border-left-color:var(--ok)}
</style></head>
<body>
<header class="top">
  <h1>工作台</h1>
  <span class="mono" id="proj">加载中…</span>
  <span id="health"></span>
  <a class="nav" href="/">← 运行面板</a>
  <a class="nav" href="#" id="refresh">刷新</a>
  <span class="muted" id="stamp"></span>
</header>
<main>
  <section>
    <h2>概览</h2>
    <div class="kpi" id="kpi"></div>
    <div id="alerts"></div>
  </section>

  <section>
    <h2>岗位状态（谁在干活）</h2>
    <div class="grid" id="positions"></div>
  </section>

  <section>
    <h2>执行与队列</h2>
    <div id="assignments"></div>
  </section>

  <section>
    <h2>交付物（产出了什么）</h2>
    <div id="deliverables"></div>
  </section>

  <section>
    <h2>阶段门（卡在哪）</h2>
    <div id="gates"></div>
  </section>

  <section>
    <h2>密钥与池</h2>
    <div class="row" style="margin-top:0;margin-bottom:10px">
      <label class="muted">单工单 token 上限</label><input type="number" id="budgetTicket" min="1">
      <label class="muted">每日 token 上限</label><input type="number" id="budgetDay" min="1">
      <button class="primary" id="saveBudget">保存预算</button>
      <button id="refreshKeys">刷新密钥</button>
    </div>
    <div id="pools">加载中…</div>
    <div class="notice">密钥存于本机（权限 0600），接口只返回掩码。多人共用或需要审计时应改用 Vault/KMS + 本地网关。</div>
  </section>
</main>
<div id="toast"></div>
<script>
const H = { 'x-superagent-request': '1', 'content-type': 'application/json' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fnum = (n) => (n == null ? '-' : Number(n).toLocaleString('zh-CN'));
let WORK = null, KEYS = null, EDITING = null;

function toast(msg, kind) {
  const d = document.createElement('div');
  if (kind) d.className = kind;
  d.textContent = msg;
  document.getElementById('toast').appendChild(d);
  setTimeout(() => d.remove(), kind === 'bad' ? 6000 : 3200);
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: H }, opts || {}));
  let body = null;
  try { body = await res.json(); } catch (e) { body = { error: '响应不是 JSON' }; }
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

const stCls = (s) => (s === 'valid' || s === 'done' || s === 'released' || s === 'closed' || s === 'review') ? 'ok'
  : (s === 'invalid' || s === 'failed' || s === 'blocked' || s === 'returned' || s === 'rejected') ? 'bad' : 'warn';

function ago(iso) {
  if (!iso) return '-';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时前';
  return Math.round(sec / 86400) + ' 天前';
}

function renderWork() {
  const d = WORK;
  document.getElementById('proj').textContent = d.project.code + ' · ' + d.project.name;
  document.getElementById('stamp').textContent = '更新于 ' + d.generatedAt.slice(11, 19);

  const healthCls = d.health.exitCode === 0 ? 'ok' : (d.health.exitCode === 3 ? 'warn' : 'bad');
  document.getElementById('health').innerHTML =
    '<span class="tag ' + healthCls + '">退出码 ' + d.health.exitCode + ' · ' + esc(d.health.reason) + '</span>';

  const ks = d.keyStore || { totals: { active: 0, keys: 0 } };
  document.getElementById('kpi').innerHTML =
    '<div><b>' + d.queue.working + '</b><span class="muted">正在执行</span></div>'
    + '<div><b>' + d.queue.queued + '</b><span class="muted">排队</span></div>'
    + '<div><b>' + d.queue.review + '</b><span class="muted">待评审</span></div>'
    + '<div><b>' + d.queue.blocked + '</b><span class="muted">阻塞</span></div>'
    + '<div><b>' + fnum(d.usage.tokens) + '</b><span class="muted">今日 tokens</span></div>'
    + '<div><b>' + ks.totals.active + '/' + ks.totals.keys + '</b><span class="muted">可用 key</span></div>';

  const alerts = [];
  if (d.health.errors && d.health.errors.length) alerts.push('运行错误：' + d.health.errors.join('；'));
  if (!d.health.source || !d.health.source.ready) alerts.push('信息源未就绪：' + ((d.health.source && d.health.source.error) || '未知'));
  if (!ks.totals.keys) alerts.push('尚未配置任何密钥：文档只会生成骨架，不会调用模型。');
  if (d.policy.acceptMode === 'observe') alerts.push('当前为 observe 模式：只记录"本会接单"，不会实际开工。');
  document.getElementById('alerts').innerHTML = alerts.length
    ? '<div class="notice" style="margin-top:10px">' + alerts.map(esc).join('<br>') + '</div>' : '';

  const stateTag = (s) => s === 'busy' ? '<span class="tag ok">在干活</span>'
    : s === 'idle' ? '<span class="tag">空闲</span>' : '<span class="tag bad">无可用密钥</span>';

  document.getElementById('positions').innerHTML = d.positions.map(p =>
    '<div class="card"><header><h3>' + esc(p.code) + ' <span class="role">' + esc(p.name) + '</span></h3>' + stateTag(p.state) + '</header>'
    + '<div class="line muted">池 ' + esc(p.pool) + ' · ' + p.poolKeys + ' 把 key' + (p.poolModels.length ? ' · ' + esc(p.poolModels.join('/')) : '') + '</div>'
    + '<div class="line">' + (p.running
        ? '在做 <code>' + esc(p.running.ticketId) + '</code> <span class="muted">' + ago(p.running.startedAt) + '开始</span>'
        : '<span class="muted">当前空闲</span>') + '</div>'
    + '<div class="line muted">' + (p.lastCall
        ? '最近：' + esc((p.lastCall.purpose || '').replace('fill:', '生成 ')) + ' · ' + fnum(p.lastCall.tokens) + ' tokens · ' + ago(p.lastCall.at)
        : '今日还没有调用') + '</div>'
    + '<div class="line muted">今日 ' + fnum(p.today.tokens) + ' tokens / ' + p.today.calls + ' 次</div>'
    + '</div>').join('');

  const rows = d.assignments.map(a =>
    '<tr><td><code>' + esc(a.ticketId) + '</code></td>'
    + '<td>' + esc(a.title || '').slice(0, 36) + '</td>'
    + '<td>' + esc(a.taskType) + '</td>'
    + '<td><span class="tag ' + stCls(a.status) + '">' + esc(a.status) + '</span></td>'
    + '<td class="muted">' + (a.startedAt ? ago(a.startedAt) : '-') + '</td>'
    + '<td class="muted">' + esc((a.note || '').slice(0, 70)) + '</td></tr>').join('');
  document.getElementById('assignments').innerHTML = rows
    ? '<table><thead><tr><th>工单</th><th>标题</th><th>类型</th><th>状态</th><th>开始</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<div class="empty">没有派工记录。投一条消息试试。</div>';

  const drows = d.deliverables.map(x =>
    '<tr><td><code>' + esc(x.docType || x.kind) + '</code></td>'
    + '<td><code>' + esc(x.ticketId) + '</code></td>'
    + '<td>' + esc((x.title || x.ticketTitle || '')).slice(0, 34) + '</td>'
    + '<td>' + esc(x.stage || '-') + '</td>'
    + '<td><span class="tag ' + stCls(x.status) + '">' + esc(x.status) + '</span>'
    + (x.aiAssisted ? ' <span class="tag ok">AI 草稿</span>' : ' <span class="tag">骨架</span>') + '</td>'
    + '<td class="mono muted">' + esc(x.path) + '</td>'
    + '<td class="muted">' + ago(x.createdAt) + '</td></tr>').join('');
  document.getElementById('deliverables').innerHTML = drows
    ? '<table><thead><tr><th>类型</th><th>工单</th><th>标题</th><th>阶段</th><th>状态</th><th>路径</th><th>产出时间</th></tr></thead><tbody>' + drows + '</tbody></table>'
    : '<div class="empty">还没有交付物。</div>';

  const gs = d.gates.map(g => {
    const gaps = (g.checks || []).filter(c => !c.ok && !c.skipped);
    return '<tr><td><code>' + esc(g.id) + '</code></td><td>' + esc(g.name) + '</td>'
      + '<td><span class="tag ' + stCls(g.status) + '">' + esc(g.status) + '</span></td>'
      + '<td class="muted">' + (gaps.length ? esc(gaps.map(c => c.detail).join('；')).slice(0, 120) : '无缺口') + '</td>'
      + '<td class="muted">' + esc(g.signed_by || '-') + '</td></tr>';
  }).join('');
  document.getElementById('gates').innerHTML = gs
    ? '<table><thead><tr><th>门</th><th>名称</th><th>状态</th><th>缺口</th><th>签署人</th></tr></thead><tbody>' + gs + '</tbody></table>'
      + '<div class="notice" style="margin-top:8px">门禁只能由人签署，机器最多推进到「待签署」。到 <a class="nav" href="/">运行面板</a> 完成签署。</div>'
    : '<div class="empty">尚未生成门禁。</div>';
}

function renderKeys() {
  const d = KEYS;
  if (!d) return;
  document.getElementById('budgetTicket').value = d.budget.tokensPerTicket;
  document.getElementById('budgetDay').value = d.budget.tokensPerDay;

  const usageOf = (pool, id) => (d.usage || []).find(u => u.pool === pool && u.keyId === id);
  const pools = d.pools.slice().sort((a, b) => (b.keyCount - a.keyCount) || a.name.localeCompare(b.name));
  document.getElementById('pools').innerHTML = pools.map(p => {
    const rows = p.keys.map(k => {
      const u = usageOf(p.name, k.id);
      const state = !k.enabled ? '<span class="tag">已停用</span>'
        : (k.keyKind === 'env' && !k.envResolved) ? '<span class="tag bad">环境变量为空</span>'
        : '<span class="tag ok">可用</span>';
      const test = k.lastTest
        ? (k.lastTest.ok ? '<span class="tag ok">通过 ' + (k.lastTest.ms || 0) + 'ms</span>' : '<span class="tag bad" title="' + esc(k.lastTest.message) + '">失败</span>')
        : '<span class="muted">未测</span>';
      if (EDITING === p.name + '/' + k.id) {
        return '<tr><td colspan="7"><div class="editor">'
          + '<div class="row"><label class="muted">id</label><span class="mono">' + esc(k.id) + '</span>'
          + '<label class="muted">模型</label><input data-f="model" value="' + esc(k.model || '') + '" placeholder="留空继承池">'
          + '<label class="muted">baseUrl</label><input data-f="baseUrl" value="' + esc(k.baseUrl || '') + '" size="28" placeholder="留空继承池">'
          + '</div>'
          + '<div class="row"><label class="muted">换密钥</label><input data-f="apiKey" type="password" placeholder="留空则不修改" size="28">'
          + '<label class="muted">或环境变量名</label><input data-f="apiKeyEnv" placeholder="如 EA_WORKER_DS_02" size="18">'
          + '<label class="muted">备注</label><input data-f="note" value="' + esc(k.note || '') + '" size="16">'
          + '</div>'
          + '<div class="row"><button class="primary" data-act="save" data-pool="' + esc(p.name) + '" data-id="' + esc(k.id) + '">保存</button>'
          + '<button data-act="toggle" data-pool="' + esc(p.name) + '" data-id="' + esc(k.id) + '" data-enabled="' + (k.enabled ? '0' : '1') + '">' + (k.enabled ? '停用' : '启用') + '</button>'
          + '<button data-act="test" data-pool="' + esc(p.name) + '" data-id="' + esc(k.id) + '">测试</button>'
          + '<button class="danger" data-act="del" data-pool="' + esc(p.name) + '" data-id="' + esc(k.id) + '">删除</button>'
          + '<button data-act="cancel">收起</button></div></div></td></tr>';
      }
      return '<tr>'
        + '<td><span class="mono">' + esc(k.id) + '</span>' + (k.ownedBy === 'model.yml' ? ' <span class="tag">yml</span>' : '') + '</td>'
        + '<td><span class="mono">' + esc(k.keyMasked) + '</span></td>'
        + '<td>' + esc(k.model || '-') + '</td>'
        + '<td>' + state + '</td>'
        + '<td>' + (u ? fnum(u.tokens) + ' <span class="muted">/ ' + u.calls + ' 次</span>' : '<span class="muted">-</span>') + '</td>'
        + '<td>' + test + '</td>'
        + '<td><button data-act="edit" data-pool="' + esc(p.name) + '" data-id="' + esc(k.id) + '">编辑</button> '
        + '<button data-act="test" data-pool="' + esc(p.name) + '" data-id="' + esc(k.id) + '">测试</button></td>'
        + '</tr>';
    }).join('');

    return '<div class="pool"><header>'
      + '<h3>' + esc(p.name) + ' <span class="muted">' + esc(p.label) + '</span></h3>'
      + '<span class="muted">' + p.keyCount + ' 把 · ' + p.activeCount + ' 可用 · ' + esc(p.model || '-')
      + ((p.problems && p.problems.length) ? ' <span class="tag warn" title="' + esc(p.problems.join('；')) + '">配置不完整</span>' : '')
      + '</span></header>'
      + (p.keys.length
        ? '<table><thead><tr><th>id</th><th>密钥</th><th>模型</th><th>状态</th><th>累计用量</th><th>最近测试</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty">该池还没有密钥。</div>')
      + '<div class="row">'
      + '<input data-add="id" data-pool="' + esc(p.name) + '" placeholder="id（可选）" size="10">'
      + '<input data-add="apiKey" data-pool="' + esc(p.name) + '" type="password" placeholder="密钥（sk-...）" size="24">'
      + '<input data-add="apiKeyEnv" data-pool="' + esc(p.name) + '" placeholder="或环境变量名" size="16">'
      + '<input data-add="model" data-pool="' + esc(p.name) + '" placeholder="模型（留空继承池）" size="18">'
      + '<button class="primary" data-act="add" data-pool="' + esc(p.name) + '">新增密钥</button>'
      + '</div></div>';
  }).join('');
}

async function loadWork() {
  WORK = await api('/api/workbench');
  renderWork();
}

async function loadKeys() {
  KEYS = await api('/api/keys');
  renderKeys();
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.id === 'refresh') { ev.preventDefault(); await Promise.all([loadWork(), loadKeys()]); toast('已刷新'); return; }
  if (btn.id === 'refreshKeys') { await loadKeys(); toast('密钥已刷新'); return; }
  if (btn.id === 'saveBudget') {
    try {
      await api('/api/keys/budget', { method: 'PUT', body: JSON.stringify({
        tokensPerTicket: Number(document.getElementById('budgetTicket').value),
        tokensPerDay: Number(document.getElementById('budgetDay').value),
      }) });
      await Promise.all([loadKeys(), loadWork()]); toast('预算已保存', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
    return;
  }

  const act = btn.dataset.act;
  if (!act) return;
  const pool = btn.dataset.pool;
  const id = btn.dataset.id;
  try {
    if (act === 'edit') { EDITING = pool + '/' + id; renderKeys(); return; }
    if (act === 'cancel') { EDITING = null; renderKeys(); return; }
    if (act === 'add') {
      const get = (f) => document.querySelector('[data-add="' + f + '"][data-pool="' + pool + '"]').value.trim();
      const payload = { pool, id: get('id') || undefined, apiKey: get('apiKey'), apiKeyEnv: get('apiKeyEnv'), model: get('model') };
      if (!payload.apiKey && !payload.apiKeyEnv) throw new Error('密钥与环境变量名至少填一个');
      const r = await api('/api/keys', { method: 'POST', body: JSON.stringify(payload) });
      await Promise.all([loadKeys(), loadWork()]);
      if (r.warnings && r.warnings.length) toast('已新增，但该池仍不可用：' + r.warnings.join('；'), 'bad');
      else toast('已新增密钥 ' + r.id, 'ok');
      return;
    }
    if (act === 'toggle') {
      await api('/api/keys/' + encodeURIComponent(pool) + '/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify({ enabled: btn.dataset.enabled === '1' }),
      });
      await Promise.all([loadKeys(), loadWork()]); toast('状态已更新', 'ok'); return;
    }
    if (act === 'test') {
      btn.disabled = true; btn.textContent = '测试中…';
      const r = await api('/api/keys/' + encodeURIComponent(pool) + '/' + encodeURIComponent(id) + '/test', { method: 'POST', body: '{}' });
      await loadKeys();
      if (r.ok) toast(pool + '/' + id + ' 通过（' + (r.ms || 0) + ' ms）：' + (r.sample || ''), 'ok');
      else toast(pool + '/' + id + ' 失败：' + (r.message || ''), 'bad');
      return;
    }
    if (act === 'save') {
      const v = (f) => { const el = document.querySelector('[data-f="' + f + '"]'); return el ? el.value.trim() : ''; };
      const patch = { model: v('model'), baseUrl: v('baseUrl'), note: v('note') };
      if (v('apiKey')) patch.apiKey = v('apiKey');
      if (v('apiKeyEnv')) patch.apiKeyEnv = v('apiKeyEnv');
      await api('/api/keys/' + encodeURIComponent(pool) + '/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) });
      EDITING = null; await Promise.all([loadKeys(), loadWork()]); toast('已保存', 'ok'); return;
    }
    if (act === 'del') {
      if (!confirm('删除 ' + pool + '/' + id + ' ？该操作会写入密钥库文件。')) return;
      await api('/api/keys/' + encodeURIComponent(pool) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      EDITING = null; await Promise.all([loadKeys(), loadWork()]); toast('已删除', 'ok'); return;
    }
  } catch (e) {
    toast(e.message, 'bad');
    btn.disabled = false;
  }
});

Promise.all([loadWork(), loadKeys()]).catch(e => {
  document.getElementById('positions').textContent = '加载失败：' + e.message;
});
setInterval(() => { loadWork().catch(() => {}); }, 5000);
</script>
</body></html>`;
