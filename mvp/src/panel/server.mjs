// 面板与管理 API：只回答三个问题（docs/01 §10）。
// 安全：只绑 127.0.0.1；写操作要求自定义请求头（挡掉浏览器跨站表单）；
// 飞书回调用 verification token 校验，不走自定义头。

import http from 'node:http';
import { URL } from 'node:url';
import { ADMIN_HTML } from './admin.mjs';
import { listPositions, positionForTask } from '../executor/positions.mjs';

const SECURITY_HEADER = 'x-superagent-request';

/** 工作台视图：把"谁在干什么、产出了什么、卡在哪"拼成一次响应 */
function workbenchView(runtime) {
  const status = runtime.status();
  const today = new Date().toISOString().slice(0, 10);
  const assignments = runtime.engine.listAssignments({ limit: 40 });
  const deliverables = runtime.engine.listAssets({ limit: 60 });
  const posUsage = runtime.engine.usageByPosition({ since: today });
  const recentCalls = runtime.engine.usageRecent(20);
  const gates = runtime.engine.listGates();

  const running = assignments.filter((a) => a.status === 'working');
  const queue = {
    working: running.length,
    queued: assignments.filter((a) => a.status === 'queued').length,
    blocked: runtime.engine.listTickets({ status: 'blocked', limit: 500 }).length,
    review: runtime.engine.listTickets({ status: 'review', limit: 500 }).length,
  };

  const positions = listPositions().map((p) => {
    const u = posUsage.find((x) => x.position === p.code);
    const pool = status.model.pools.find((x) => x.pool === p.pool) ?? null;
    const busy = running.find((a) => positionForTask(a.taskType)?.code === p.code) ?? null;
    const last = recentCalls.find((c) => c.position === p.code) ?? null;
    return {
      ...p,
      state: busy ? 'busy' : (pool ? 'idle' : 'unconfigured'),
      running: busy ? { ticketId: busy.ticketId, title: busy.title, startedAt: busy.startedAt } : null,
      lastCall: last,
      today: { tokens: u?.tokens ?? 0, calls: u?.calls ?? 0 },
      poolKeys: pool?.keys ?? 0,
      poolModels: pool?.models ?? [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    project: status.project,
    health: { exitCode: status.gateExitCode, reason: status.reason, errors: status.errors, source: status.source },
    policy: { acceptMode: status.policy.acceptMode, whitelist: status.policy.whitelist },
    queue,
    positions,
    assignments,
    deliverables,
    gates,
    usage: {
      tokens: status.usage?.tokens ?? 0,
      calls: status.usage?.calls ?? 0,
      byPool: status.usage?.byPool ?? [],
      since: today,
    },
    keyStore: status.model.keyStore ?? null,
  };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try { resolve(JSON.parse(text)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

export function createPanelServer({ runtime, host = '127.0.0.1', port = 8787 }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // 飞书事件回调
      if (req.method === 'POST' && path === '/feishu/event') {
        if (!runtime.source || runtime.sourceKind !== 'feishu') return send(res, 404, { error: '飞书来源未启用' });
        const body = await readBody(req);
        const out = await runtime.source.handleEvent(body);
        return send(res, 200, out);
      }

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        return send(res, 200, HTML, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && (path === '/admin' || path === '/admin.html')) {
        return send(res, 200, ADMIN_HTML, 'text/html; charset=utf-8');
      }

      if (path.startsWith('/api/')) {
        const isWrite = req.method !== 'GET';
        if (isWrite && req.headers[SECURITY_HEADER] !== '1') {
          return send(res, 403, { error: `写操作需要请求头 ${SECURITY_HEADER}: 1` });
        }
        if (req.method === 'GET' && path === '/api/state') return send(res, 200, runtime.panelData());
        if (req.method === 'GET' && path === '/api/workbench') return send(res, 200, workbenchView(runtime));

        // ---- 密钥管理：明文密钥永不出站；写操作走自定义头 + 127.0.0.1 ----
        if (path === '/api/keys' && req.method === 'GET') {
          return send(res, 200, {
            ...runtime.keys.snapshot(),
            usage: runtime.engine.usageByKey(),
            positions: listPositions(),
            runtime: { pools: runtime.pool?.describe() ?? [] },
          });
        }
        if (path === '/api/keys' && req.method === 'POST') {
          const body = await readBody(req) ?? {};
          try {
            const id = await runtime.keys.addKey(body);
            await runtime.reloadKeys();
            const pool = runtime.keys.snapshot().pools.find((p) => p.name === body.pool);
            return send(res, 201, { ok: true, id, warnings: pool?.problems ?? [] });
          } catch (err) { return send(res, 400, { error: err.message }); }
        }
        if (path === '/api/keys/budget' && req.method === 'PUT') {
          const body = await readBody(req) ?? {};
          try {
            const budget = await runtime.keys.setBudget(body);
            await runtime.reloadKeys();
            return send(res, 200, { ok: true, budget });
          } catch (err) { return send(res, 400, { error: err.message }); }
        }
        const testKeyMatch = /^\/api\/keys\/([^/]+)\/([^/]+)\/test$/.exec(path);
        if (testKeyMatch && req.method === 'POST') {
          try {
            const out = await runtime.keys.testKey({
              pool: decodeURIComponent(testKeyMatch[1]),
              id: decodeURIComponent(testKeyMatch[2]),
            });
            return send(res, 200, out);
          } catch (err) { return send(res, 400, { error: err.message }); }
        }
        const keyMatch = /^\/api\/keys\/([^/]+)\/([^/]+)$/.exec(path);
        if (keyMatch) {
          const pool = decodeURIComponent(keyMatch[1]);
          const id = decodeURIComponent(keyMatch[2]);
          if (req.method === 'PATCH') {
            const body = await readBody(req) ?? {};
            try {
              const next = await runtime.keys.updateKey({ pool, id, patch: body });
              await runtime.reloadKeys();
              return send(res, 200, { ok: true, key: { id: next.id, enabled: next.enabled, model: next.model ?? null } });
            } catch (err) { return send(res, 400, { error: err.message }); }
          }
          if (req.method === 'DELETE') {
            try {
              await runtime.keys.removeKey({ pool, id });
              await runtime.reloadKeys();
              return send(res, 200, { ok: true });
            } catch (err) { return send(res, 400, { error: err.message }); }
          }
        }

        if (req.method === 'GET' && path === '/api/health') {
          const s = runtime.status();
          return send(res, 200, { exitCode: s.gateExitCode, reason: s.reason, stats: s.stats, source: s.source });
        }
        if (req.method === 'GET' && path === '/api/tickets') {
          return send(res, 200, runtime.engine.listTickets({ limit: 100 }));
        }
        const tMatch = /^\/api\/tickets\/([A-Z0-9-]+)$/.exec(path);
        if (req.method === 'GET' && tMatch) {
          const h = runtime.engine.history(tMatch[1]);
          return h ? send(res, 200, h) : send(res, 404, { error: '工单不存在' });
        }
        const stopMatch = /^\/api\/tickets\/([A-Z0-9-]+)\/stop$/.exec(path);
        if (req.method === 'POST' && stopMatch) {
          const body = await readBody(req) ?? {};
          try {
            runtime.engine.stopTicket(stopMatch[1], { actor: body.by ?? 'panel', reason: body.reason ?? '面板撤回' });
            return send(res, 200, { ok: true });
          } catch (err) { return send(res, 409, { error: err.message }); }
        }
        if (req.method === 'GET' && path === '/api/gates') {
          return send(res, 200, runtime.engine.listGates());
        }
        const signMatch = /^\/api\/gates\/(G[1-5])\/sign$/.exec(path);
        if (req.method === 'POST' && signMatch) {
          const body = await readBody(req) ?? {};
          if (!body.openId) return send(res, 400, { error: '缺少 openId' });
          try {
            const g = runtime.engine.signGate(signMatch[1], { actorId: body.openId, note: body.note ?? null });
            return send(res, 200, g);
          } catch (err) {
            return send(res, err.code === 'gate/forbidden' ? 403 : 409, { error: err.message });
          }
        }
        const returnMatch = /^\/api\/gates\/(G[1-5])\/return$/.exec(path);
        if (req.method === 'POST' && returnMatch) {
          const body = await readBody(req) ?? {};
          if (!body.openId) return send(res, 400, { error: '缺少 openId' });
          try {
            const g = runtime.engine.returnGate(returnMatch[1], { actorId: body.openId, reason: body.reason ?? '退回' });
            return send(res, 200, g);
          } catch (err) { return send(res, 409, { error: err.message }); }
        }
        return send(res, 404, { error: '未知接口' });
      }

      return send(res, 404, { error: '未找到' });
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.message });
    }
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, host, () => {
      const actual = server.address().port;   // port=0 时由系统分配，测试靠这个避免端口冲突
      resolve({ url: `http://${host}:${actual}`, port: actual });
    })),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>electronics-superagent 面板</title>
<style>
  :root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6ea;--text:#1d2126;--muted:#6b7280;--ok:#1a7f4b;--warn:#a15c00;--bad:#b3261e;--accent:#1f5fa8}
  @media (prefers-color-scheme:dark){:root{--bg:#14171a;--panel:#1b1f23;--line:#2c3238;--text:#e6e9ec;--muted:#9aa3ad;--ok:#4ec98a;--warn:#e0a34a;--bad:#ef6b62;--accent:#69a8ea}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
  header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;background:var(--panel)}
  h1{font-size:16px;margin:0;font-weight:650}
  .muted{color:var(--muted);font-size:12.5px}
  main{padding:18px 22px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  h2{font-size:13px;margin:0 0 10px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:500;font-size:12px}
  .tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11.5px;border:1px solid var(--line)}
  .ok{color:var(--ok);border-color:currentColor}
  .warn{color:var(--warn);border-color:currentColor}
  .bad{color:var(--bad);border-color:currentColor}
  .kpi{display:flex;gap:18px;flex-wrap:wrap}
  .kpi div{min-width:74px}
  .kpi b{display:block;font-size:20px;font-weight:650}
  button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
  button:hover{border-color:var(--accent);color:var(--accent)}
  .empty{color:var(--muted);font-size:13px;padding:6px 0}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
</style></head>
<body>
<header>
  <h1>electronics-superagent</h1>
  <span class="muted" id="proj">加载中…</span>
  <span class="muted" id="mode"></span>
  <a href="/admin" style="margin-left:auto;color:var(--accent);text-decoration:none;font-size:13px">密钥与岗位 →</a>
</header>
<main>
  <section style="grid-column:1/-1">
    <h2>现在需要我做什么</h2>
    <div id="attention" class="empty">加载中…</div>
  </section>
  <section>
    <h2>系统健康</h2>
    <div id="health"></div>
  </section>
  <section>
    <h2>度量</h2>
    <div id="kpi" class="kpi"></div>
  </section>
  <section style="grid-column:1/-1">
    <h2>阶段门</h2>
    <div id="gates"></div>
  </section>
  <section style="grid-column:1/-1">
    <h2>最近工单</h2>
    <div id="tickets"></div>
  </section>
  <section style="grid-column:1/-1">
    <h2>最近评估（含拒绝原因）</h2>
    <div id="evals"></div>
  </section>
</main>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tag = (text, cls='') => '<span class="tag '+cls+'">'+esc(text)+'</span>';
const stCls = (s) => s==='released'||s==='closed'||s==='ready'?'ok':(s==='blocked'||s==='rejected'||s==='returned'?'bad':'warn');

async function load(){
  const r = await fetch('/api/state'); const d = await r.json();
  const s = d.status;
  document.getElementById('proj').textContent = s.project.code + ' · ' + s.project.name + ' · 阶段 ' + (s.project.stages||[]).join('/');
  document.getElementById('mode').textContent = '来源 '+s.source.kind+' · 策略 '+s.policy.acceptMode
    + ' · 白名单 '+s.policy.whitelist+' 人 · 模型池 '+(s.model.pools?.length || 0)+' 个';

  const att = [];
  for (const t of d.attention.tickets) att.push('<tr><td><code>'+esc(t.id)+'</code></td><td>'+esc(t.title)+'</td><td>'+tag(t.status, stCls(t.status))+'</td><td class="muted">'+esc(t.blocked_reason||'')+'</td></tr>');
  for (const g of d.attention.gates) att.push('<tr><td><code>'+esc(g.id)+'</code></td><td>'+esc(g.name)+'</td><td>'+tag(g.status, stCls(g.status))+'</td><td class="muted">'+(g.status==='pending'?'待签署':'检查未通过')+'</td></tr>');
  document.getElementById('attention').innerHTML = att.length
    ? '<table><thead><tr><th>编号</th><th>事项</th><th>状态</th><th>说明</th></tr></thead><tbody>'+att.join('')+'</tbody></table>'
    : '<div class="empty">没有需要你处理的事项。</div>';

  document.getElementById('health').innerHTML =
    '<table><tbody>'
    + '<tr><td>来源</td><td>'+tag(s.source.kind, s.source.ready?'ok':'bad')+'</td></tr>'
    + '<tr><td>策略版本</td><td><code>'+esc(s.policy.version)+'</code></td></tr>'
    + '<tr><td>模型网关</td><td>'+esc(s.model.gateway)+'</td></tr>'
    + '<tr><td>岗位池</td><td>'+(s.model.pools && s.model.pools.length
        ? s.model.pools.map(p => esc(p.pool)+'×'+p.keys+(p.models.length?'（'+esc(p.models.join('/'))+'）':'')).join('<br>')
        : '<span class="muted">未配置（文档只出骨架，不生成内容）</span>')+'</td></tr>'
    + '<tr><td>今日用量</td><td>'+(s.usage?.tokens ?? 0)+' tokens / '+(s.usage?.calls ?? 0)+' 次</td></tr>'
    + '<tr><td>退出码</td><td>'+tag(String(s.gateExitCode), s.gateExitCode===0?'ok':(s.gateExitCode===3?'warn':'bad'))+'</td></tr>'
    + '<tr><td>说明</td><td class="muted">'+esc(s.reason)+'</td></tr>'
    + (s.recovered?.recoveredAssignments ? '<tr><td>恢复</td><td class="muted">'+s.recovered.recoveredAssignments+' 个中断派工已重新入队</td></tr>' : '')
    + '</tbody></table>';

  const st = s.stats;
  document.getElementById('kpi').innerHTML = [
    ['工单', st.tickets], ['进行中', st.openTickets], ['待签署', st.pendingSignatures],
    ['文档', st.assets], ['拒绝', st.rejected], ['待发消息', st.outboxPending],
  ].map(([k,v]) => '<div><b>'+v+'</b><span class="muted">'+k+'</span></div>').join('');

  const gs = d.gates.map(g => '<tr><td><code>'+esc(g.id)+'</code></td><td>'+esc(g.name)+'</td><td>'+tag(g.status, stCls(g.status))+'</td><td class="muted">'+(g.checks||[]).map(c => (c.ok?'✅ ':'❌ ')+esc(c.id)).join('　')+'</td><td class="muted">'+esc(g.signed_by||'')+'</td></tr>');
  document.getElementById('gates').innerHTML = gs.length
    ? '<table><thead><tr><th>门</th><th>名称</th><th>状态</th><th>检查</th><th>签署人</th></tr></thead><tbody>'+gs.join('')+'</tbody></table>'
    : '<div class="empty">尚未启用阶段门。</div>';

  const ts = d.recent.map(t => '<tr><td><code>'+esc(t.id)+'</code></td><td>'+esc(t.title)+'</td><td>'+esc(t.task_type)+'</td><td>'+esc(t.stage)+'</td><td>'+tag(t.status, stCls(t.status))+'</td></tr>');
  document.getElementById('tickets').innerHTML = ts.length
    ? '<table><thead><tr><th>编号</th><th>标题</th><th>类型</th><th>阶段</th><th>状态</th></tr></thead><tbody>'+ts.join('')+'</tbody></table>'
    : '<div class="empty">还没有工单。在群里 @ 机器人 或在收件箱放一条消息。</div>';

  const es = d.evals.map(e => '<tr><td><code>'+esc(e.id)+'</code></td><td>'+esc(e.task_type||'-')+'</td><td>'+tag(e.status, stCls(e.status))+'</td><td class="muted">'+esc(e.reason||'')+'</td></tr>');
  document.getElementById('evals').innerHTML = es.length
    ? '<table><thead><tr><th>评估</th><th>类型</th><th>结论</th><th>依据</th></tr></thead><tbody>'+es.join('')+'</tbody></table>'
    : '<div class="empty">暂无评估记录。</div>';
}
load().catch(e => { document.getElementById('attention').textContent = '加载失败：'+e.message; });
setInterval(() => load().catch(()=>{}), 5000);
</script></body></html>`;
