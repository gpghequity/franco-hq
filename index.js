'use strict';
//
// Franco HQ — the single pane of glass.
//
// ANTI-DRIFT BY DESIGN: this file has ZERO tool-specific code. It reads
// registry.json (the only place tools are listed), polls each tool's statusUrl,
// and renders whatever comes back. Add/change/remove a tool = edit registry.json
// and nothing else. There is nothing per-tool here to drift.
//
// Read-only + a command box. It NEVER mutates another tool's data; the worst it
// can do is fail to load a tile. So it cannot break Franco or any other service.
//
// Zero dependencies (Node 18+ http + global fetch). Local-first, rollback-ready.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8088;
const ROOT = __dirname;
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'));
const CMD_LOG = path.join(ROOT, 'commands.jsonl');

// ── recent commands (in-memory, restored from disk) ─────────────────────────
let RECENT = [];
try {
  if (fs.existsSync(CMD_LOG)) {
    RECENT = fs.readFileSync(CMD_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-50);
  }
} catch (e) { console.error('[franco-hq] command log restore failed:', e.message); }

// ── poll one tool's status feed (best-effort, never throws) ─────────────────
async function pollTool(tool) {
  const base = { key: tool.key, label: tool.label, group: tool.group, url: tool.url, commandable: !!tool.commandUrl, actions: tool.actions || [] };
  if (!tool.statusUrl) return { ...base, hasFeed: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(tool.statusUrl, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return { ...base, hasFeed: true, ok: false, error: 'HTTP ' + r.status };
    const data = await r.json();
    return { ...base, hasFeed: true, ok: true, data };
  } catch (e) {
    clearTimeout(t);
    return { ...base, hasFeed: true, ok: false, error: (e.name === 'AbortError' ? 'timeout' : e.message) };
  }
}

async function getState() {
  const tools = await Promise.all(REGISTRY.tools.map(pollTool));
  return { generatedAt: new Date().toISOString(), groups: REGISTRY.groups, tools };
}

// ── capture a typed instruction; forward if the tool accepts commands ───────
async function handleCommand(body) {
  const target = String(body.target || '').trim();
  const text = String(body.text || '').trim();
  const action = String(body.action || '').trim();   // a real action to execute, vs freeform text
  if (!text && !action) return { ok: false, error: 'empty instruction' };
  const tool = REGISTRY.tools.find(t => t.key === target) || null;
  const entry = {
    ts: new Date().toISOString(),
    target: tool ? tool.key : (target || 'unrouted'),
    targetLabel: tool ? tool.label : '(no target — held for Franco)',
    text: text || ('[action] ' + action),
    action: action || undefined,
    forwarded: false
  };
  // An action with a commandUrl gets EXECUTED on the tool (this is the "do", not "report").
  if (tool && tool.commandUrl && action) {
    try {
      const r = await fetch(tool.commandUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'franco-hq', action, text })
      });
      const out = await r.json().catch(() => ({}));
      entry.forwarded = r.ok && out.ok !== false;
      entry.result = out;
      if (!entry.forwarded) entry.forwardError = out.error || ('HTTP ' + r.status);
    } catch (e) { entry.forwardError = e.message; }
  }
  try { fs.appendFileSync(CMD_LOG, JSON.stringify(entry) + '\n'); } catch (e) { /* non-fatal */ }
  RECENT.push(entry); if (RECENT.length > 50) RECENT = RECENT.slice(-50);
  return { ok: true, entry };
}

// ── tiny router ─────────────────────────────────────────────────────────────
function send(res, code, type, body) { res.writeHead(code, { 'content-type': type }); res.end(body); }
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/hq')) {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'franco-hq' });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await getState());
    if (req.method === 'GET' && url.pathname === '/api/commands') return json(res, 200, { commands: RECENT.slice().reverse() });
    if (req.method === 'POST' && url.pathname === '/api/command') {
      let raw = ''; req.on('data', c => raw += c);
      req.on('end', async () => { try { return json(res, 200, await handleCommand(JSON.parse(raw || '{}'))); } catch (e) { return json(res, 400, { ok: false, error: e.message }); } });
      return;
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
});

server.listen(PORT, () => console.log(`[franco-hq] listening on :${PORT} — single pane over ${REGISTRY.tools.length} tools`));
