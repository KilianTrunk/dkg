#!/usr/bin/env node
/**
 * inject-inbox.mjs
 *
 * Cursor `beforeSubmitPrompt` + Claude Code `UserPromptSubmit` hook
 * that auto-injects unread agent-to-agent chat messages into the
 * operator's next prompt. Lets the receiving Cursor agent see "Alice's
 * agent asked X" on every prompt without the operator having to ask
 * "any messages?" first.
 *
 * Phase 1.5 of the agent debug chat RFC — Phase 1 is the two MCP
 * tools (`dkg_send_message` / `dkg_check_inbox`). This hook sits on
 * top of those: it calls `GET /api/messages?since=<last-seen>` directly
 * via the daemon HTTP API and rewrites the prompt input.
 *
 * Output contract (per Cursor hook event cheat sheet):
 *   - `beforeSubmitPrompt` supports `updated_input` and the
 *     standard permission/messages. We use `updated_input` to
 *     PREFIX the operator's prompt with a `<dkg-inbox>...</dkg-inbox>`
 *     block. This is visible to both operator and agent — the
 *     operator sees that the inbox was checked, and the agent gets
 *     the context for free without an extra MCP tool call.
 *
 * Design principles (mirrors capture-chat.mjs):
 *   1. FAIL OPEN — any error returns `{}` so the prompt goes through
 *      unchanged. Errors go to /tmp/dkg-inject-inbox.log.
 *   2. NO NEW CONFIG SURFACE — reads `DKG_HOME/config.json` or walks
 *      cwd for `.dkg/config.yaml`, same precedence as
 *      `packages/mcp-dkg/src/config.ts`.
 *   3. NO SIDE EFFECTS BEYOND CACHE — writes a last-seen-ts to
 *      `~/.cache/dkg-mcp/inbox-cursor.json` so repeated hook
 *      invocations don't re-surface the same messages.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = process.env.DKG_INBOX_LOG ?? '/tmp/dkg-inject-inbox.log';
const STATE_FILE = path.join(os.homedir(), '.cache', 'dkg-mcp', 'inbox-cursor.json');
const DEFAULT_API = 'http://localhost:9200';
// Don't even bother fetching more than this many messages per hook
// invocation — at this point we're not an inbox, we're an archive.
const MAX_FETCH = 25;

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* never crash the hook just because we can't log */
  }
}

// ── Config loading ───────────────────────────────────────────────
// Mirrors `loadConfigFromDkgHome` in packages/mcp-dkg/src/config.ts
// (the daemon-config translator) PLUS the cwd-walk fallback for
// `.dkg/config.yaml`. Kept dependency-free (no `yaml` import) so the
// hook stays a pure stdlib .mjs script.

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function parseDotDkgConfig(text) {
  // Minimal indentation-based parser, copied from capture-chat.mjs to
  // stay dependency-free. Only handles the workspace shape we actually
  // care about (node.api, node.token, node.tokenFile).
  const lines = text.split('\n');
  const cfg = {};
  const stack = [cfg];
  const indents = [-1];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    while (indents.length > 1 && indent <= indents[indents.length - 1]) {
      stack.pop();
      indents.pop();
    }
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2];
    const parent = stack[stack.length - 1];
    if (valRaw === '' || valRaw === undefined) {
      parent[key] = {};
      stack.push(parent[key]);
      indents.push(indent);
    } else {
      const val = valRaw.replace(/^["']|["']$/g, '').trim();
      if (val === 'true') parent[key] = true;
      else if (val === 'false') parent[key] = false;
      else if (/^-?\d+$/.test(val)) parent[key] = parseInt(val, 10);
      else parent[key] = val;
    }
  }
  return cfg;
}

function findWorkspaceConfig(start) {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.dkg', 'config.yaml');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function tokenFromFile(filePath) {
  const raw = readIfExists(filePath);
  if (!raw) return null;
  const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return line ? line.trim() : null;
}

function loadDaemonConfig() {
  const envApi = process.env.DKG_API ?? process.env.DEVNET_API;
  const envToken =
    process.env.DKG_TOKEN ?? process.env.DEVNET_TOKEN ?? process.env.DKG_AUTH;
  const dkgHome = process.env.DKG_HOME?.trim() || null;

  // Path A: DKG_HOME/config.json (daemon-config shape) — what
  // `dkg mcp setup` writes for GUI clients launched without inheriting
  // shell env.
  if (dkgHome) {
    const jsonPath = path.join(dkgHome, 'config.json');
    if (fs.existsSync(jsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const apiPort = typeof parsed.apiPort === 'number' ? parsed.apiPort : 9200;
        const tokenPath = path.join(dkgHome, 'auth.token');
        const fileToken = fs.existsSync(tokenPath) ? tokenFromFile(tokenPath) : null;
        return {
          api: envApi ?? `http://localhost:${apiPort}`,
          token: envToken ?? fileToken ?? '',
          source: jsonPath,
        };
      } catch (err) {
        log(`DKG_HOME config.json parse failed: ${err?.message ?? err}`);
        // fall through to workspace lookup
      }
    }
  }

  // Path B: walk cwd for .dkg/config.yaml (the workspace shape).
  const cwd = process.env.DKG_WORKSPACE ?? process.cwd();
  const cfgPath = findWorkspaceConfig(cwd);
  let fromFile = { node: {} };
  if (cfgPath) {
    const raw = readIfExists(cfgPath);
    if (raw) {
      try {
        fromFile = parseDotDkgConfig(raw);
      } catch (err) {
        log(`could not parse ${cfgPath}: ${err?.message ?? err}`);
      }
    }
  }

  let token = envToken ?? fromFile.node?.token ?? '';
  if (!token && fromFile.node?.tokenFile && cfgPath) {
    const raw = fromFile.node.tokenFile;
    const expanded =
      raw === '~'
        ? os.homedir()
        : raw.startsWith('~/')
          ? path.join(os.homedir(), raw.slice(2))
          : raw;
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(path.dirname(cfgPath), expanded);
    token = tokenFromFile(abs) ?? '';
  }

  return {
    api: fromFile.node?.api ?? envApi ?? DEFAULT_API,
    token,
    source: cfgPath,
  };
}

// ── Last-seen-ts state ───────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { lastSeen: 0 };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`state save failed: ${err?.message ?? err}`);
  }
}

// ── stdin (Cursor / Claude Code hook payload) ────────────────────
async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf-8').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { rawPayload: text };
    }
  } catch (err) {
    log(`stdin read failed: ${err?.message ?? err}`);
    return {};
  }
}

function extractPrompt(payload) {
  // Cursor wraps the user prompt in different shapes across versions;
  // do a best-effort deep search. Falls back to empty string so we can
  // still detect the no-text case and exit gracefully.
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['prompt', 'input', 'text', 'message', 'content', 'user_input'];
  function recurse(node, depth) {
    if (depth > 4 || !node || typeof node !== 'object') return undefined;
    for (const k of keys) {
      if (typeof node[k] === 'string' && node[k].trim()) return node[k];
    }
    for (const v of Object.values(node)) {
      if (typeof v === 'object') {
        const got = recurse(v, depth + 1);
        if (got) return got;
      }
    }
    return undefined;
  }
  return recurse(payload, 0) ?? '';
}

function shortPeer(peerId) {
  return peerId && peerId.length > 8 ? `…${peerId.slice(-8)}` : peerId ?? '';
}

function formatTs(ts) {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(ts);
  }
}

function renderInbox(messages) {
  // Match the on-screen shape of dkg_check_inbox so operator + agent
  // see consistent formatting whether the inbox arrived via hook or
  // tool call.
  const lines = messages.map((m) => {
    const who = m.peerName ? `${m.peerName} (${shortPeer(m.peer)})` : shortPeer(m.peer);
    return `- ${who} · ${formatTs(m.ts)}\n    ${(m.text ?? '').replace(/\n/g, '\n    ')}`;
  });
  const header = `${messages.length} unread peer message${messages.length === 1 ? '' : 's'}:`;
  return `<dkg-inbox>\n${header}\n\n${lines.join('\n')}\n\nReply via dkg_send_message({ to, text }).\n</dkg-inbox>`;
}

async function fetchInbox(cfg, since) {
  const params = new URLSearchParams({
    limit: String(MAX_FETCH),
  });
  if (since) params.set('since', String(since));
  const url = `${cfg.api.replace(/\/$/, '')}/api/messages?${params.toString()}`;
  const headers = { Accept: 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /api/messages → ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data?.messages) ? data.messages : [];
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const payload = await readStdinJson();
  const userPrompt = extractPrompt(payload);

  let cfg;
  try {
    cfg = loadDaemonConfig();
  } catch (err) {
    log(`loadDaemonConfig failed: ${err?.message ?? err}`);
    process.stdout.write('{}');
    return;
  }

  const state = loadState();
  const since = state.lastSeen || 0;

  let messages;
  try {
    messages = await fetchInbox(cfg, since);
  } catch (err) {
    // Daemon offline, auth fail, etc. — silently pass through, the
    // operator's prompt should never be blocked by an inbox check.
    log(`fetchInbox failed: ${err?.message ?? err}`);
    process.stdout.write('{}');
    return;
  }

  const inbound = messages.filter((m) => m.direction === 'in');
  if (inbound.length === 0) {
    // Even if nothing new, advance lastSeen using any outbound rows the
    // daemon sent us so future runs don't repeatedly fetch the same
    // outbound history. Cheap and bounded by MAX_FETCH.
    const highWater = messages.reduce((max, m) => Math.max(max, m.ts ?? 0), since);
    if (highWater > since) saveState({ lastSeen: highWater });
    process.stdout.write('{}');
    return;
  }

  const highWater = inbound.reduce((max, m) => Math.max(max, m.ts ?? 0), since);
  saveState({ lastSeen: highWater });

  const block = renderInbox(inbound);
  // Prefix the operator's prompt with the inbox block. Putting it
  // BEFORE the prompt makes it natural for the model to read "you have
  // unread messages: X. The operator now says: Y." and surface the
  // inbox before processing Y.
  const updatedInput = userPrompt ? `${block}\n\n${userPrompt}` : block;

  process.stdout.write(
    JSON.stringify({
      updated_input: updatedInput,
    }),
  );
}

main().catch((err) => {
  log(`unhandled: ${err?.stack ?? err?.message ?? err}`);
  // FAIL OPEN — always exit 0 with an empty object so the prompt
  // proceeds unmodified.
  process.stdout.write('{}');
});
