#!/usr/bin/env node
/**
 * inject-session-context.mjs
 *
 * Cursor `beforeSubmitPrompt` + Claude Code `UserPromptSubmit` hook
 * that prepends a `<dkg-session-context>` block to every prompt so
 * the agent can author structured annotations (Decision / Finding /
 * Task / Question / code-ref) carrying a proper graph edge back to
 * the `chat:Turn` capture-chat.mjs will write after the response.
 *
 * Why this hook exists (the gap it closes)
 * ----------------------------------------
 * The V9 prompt-injection sub-system (`sessionStart` additionalContext
 * with "Your session ID: <id>") was retired in the V10 MCP consolidation
 * (#381) and the subsequent R3 capture-chat reduction (commit 0e7abdf9).
 * Without it, the agent has no reliable input carrying its own `conversation_id`,
 * so it cannot compute the predictable URI
 *
 *   urn:dkg:chat:session:<sessionKey>#turn:<idx>
 *
 * that capture-chat.mjs writes deterministically after the response.
 * Annotations written during the turn end up orphaned (no graph edge
 * back to the Turn that produced them). This hook restores that input
 * via the `updated_input` channel (the only V10-supported prompt
 * injection mechanism), so annotations can include edges like
 *
 *   <turn-uri> chat:proposes  <finding-uri>
 *   <turn-uri> chat:mentions  <file-uri>
 *
 * and the capture-chat write that lands after the response completes
 * the JOIN.
 *
 * Hook ordering (.cursor/hooks.json)
 * ----------------------------------
 *   1. capture-chat.mjs (beforeSubmitPrompt) — stashes the ORIGINAL
 *      prompt before any hook mutates it, and persists session state
 *      (turnIndex, pendingPrompt).
 *   2. inject-session-context.mjs (this hook) — reads the persisted
 *      state, computes next-turn index, prepends the block.
 *   3. inject-inbox.mjs — prepends inbox notice if unread peer
 *      messages exist. Sees prompt-with-session-context as its input
 *      and prepends ABOVE it, producing final order:
 *         <dkg-inbox-notice>      (most urgent)
 *         <dkg-session-context>   (administrative metadata)
 *         <operator prompt>       (the actual ask)
 *
 * Output contract
 * ---------------
 *   { updated_input: "<dkg-session-context>...\n\n<operator prompt>" }
 * or `{}` on any failure (fail-open per hook convention).
 *
 * Security model
 * --------------
 * Both injected fields come from the local trust boundary:
 *   - `sessionKey` is Cursor's `conversation_id` from the hook payload
 *     (a value Cursor itself mints; never peer-controlled).
 *   - `nextTurnIndex` comes from `~/.cache/dkg-mcp/sessions/<sessionKey>.json`,
 *     which only capture-chat.mjs writes on this machine.
 *   - `agentUri` is read from `.dkg/config.yaml` (local).
 *
 * No peer-controlled data is inlined. Same posture as inject-inbox.mjs,
 * which explicitly forbids peer text in the prompt; we route around
 * that constraint by injecting only locally-controlled identifiers.
 *
 * Design principles (mirror capture-chat.mjs / inject-inbox.mjs)
 * -------------------------------------------------------------
 *   1. FAIL OPEN. Any error → `{}` on stdout (no modification). The
 *      hook must never block the operator's prompt.
 *   2. FAIL CLOSED on prompt extraction. If we cannot identify the
 *      operator's prompt, we must NOT emit `updated_input` (would
 *      silently REPLACE the prompt with just our block).
 *   3. NO NEW CONFIG SURFACE. Reads `.dkg/config.yaml` walking
 *      upward from cwd for `agent.uri`.
 *   4. STDLIB ONLY. No npm imports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = process.env.DKG_SESSION_CTX_LOG ?? '/tmp/dkg-inject-session-context.log';
const STATE_DIR = path.join(os.homedir(), '.cache', 'dkg-mcp', 'sessions');

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* never crash the hook just because we can't log */
  }
}

// Generic deep-search for the first matching key. Same pattern as
// sibling hooks; lets us tolerate field-name drift across Cursor /
// Claude Code / future tools without per-tool branching.
function pick(obj, candidates, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== 'object') return undefined;
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, c)) {
      const v = obj[c];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const nested = pick(v, candidates, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function sanitiseSlug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
}

// Mirror capture-chat.mjs `extractSessionKey` so both hooks compute
// the same `sessionKey` for the same payload — any drift here would
// silently produce a turn URI the capture hook never writes.
export function extractSessionKey(payload) {
  const id = pick(payload, [
    'conversation_id', 'session_id', 'thread_id', 'chat_id',
    'conversationId', 'sessionId', 'threadId', 'chatId', 'convId', 'id',
  ]);
  if (id) return sanitiseSlug(id);
  // Anon-session fallback identical to capture-chat.mjs: read the
  // per-process index file. capture-chat's `anonSessionKey()` writes
  // it; we only read.
  try {
    const stateDir = path.join(os.homedir(), '.dkg', 'hook-state');
    const idxFile = path.join(stateDir, `anon-session-${process.ppid || process.pid}.txt`);
    if (fs.existsSync(idxFile)) {
      const buf = fs.readFileSync(idxFile, 'utf-8').trim();
      if (buf) return sanitiseSlug(buf);
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function extractPrompt(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.rawPayload === 'string' && payload.rawPayload.trim()) {
    return payload.rawPayload;
  }
  return pick(payload, [
    'prompt', 'input', 'text', 'message', 'content', 'user_input',
  ]) ?? '';
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

// Read the single `agent.uri` field from the workspace YAML. We deliberately
// don't reuse the full parsers from sibling hooks — they each carry their own
// stripped-down parser for the same reason: stdlib-only + small footprint.
export function parseAgentUri(yamlText) {
  const lines = yamlText.split('\n');
  let inAgent = false;
  let agentIndent = -1;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    if (!inAgent && /^agent\s*:\s*$/.test(line.trim())) {
      inAgent = true;
      agentIndent = indent;
      continue;
    }
    if (inAgent && indent <= agentIndent) {
      // dedented out of the `agent:` block before finding `uri`
      inAgent = false;
    }
    if (inAgent) {
      const m = line.trim().match(/^uri\s*:\s*(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  return null;
}

function loadAgentUri() {
  const fromEnv = process.env.DKG_AGENT_URI?.trim();
  if (fromEnv) return fromEnv;
  const cwd = process.env.DKG_WORKSPACE ?? process.cwd();
  const cfgPath = findWorkspaceConfig(cwd);
  if (!cfgPath) return null;
  try {
    return parseAgentUri(fs.readFileSync(cfgPath, 'utf-8'));
  } catch (err) {
    log(`agent.uri parse failed: ${err?.message ?? err}`);
    return null;
  }
}

// Read-only consumer of capture-chat's session state. We never write
// this file — capture-chat owns the writes; we only need `turnIndex`
// to predict the next turn URI.
function loadTurnIndex(sessionKey) {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, `${sessionKey}.json`), 'utf-8');
    const state = JSON.parse(raw);
    return typeof state.turnIndex === 'number' ? state.turnIndex : 0;
  } catch {
    // Missing state file → first turn of a fresh session. capture-chat
    // creates the state file in its own beforeSubmitPrompt handler, which
    // runs BEFORE this hook per .cursor/hooks.json ordering, so this
    // branch only fires when (a) it's literally turn 1, or (b)
    // capture-chat errored out on this turn (in which case fail-open is
    // the right move — emit nextTurnIndex=1 and the capture hook will
    // self-heal on its next successful event).
    return 0;
  }
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf-8').trim();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { rawPayload: text }; }
  } catch (err) {
    log(`stdin read failed: ${err?.message ?? err}`);
    return {};
  }
}

export function renderBlock({ sessionKey, nextTurnIndex, turnUri, agentUri }) {
  // Wrapping tags make this a structured notice the agent's prompt
  // parser sees as metadata, not free text. Four fields keep the
  // prompt-budget hit minimal.
  return [
    '<dkg-session-context>',
    `  <session-id>${sessionKey}</session-id>`,
    `  <next-turn-index>${nextTurnIndex}</next-turn-index>`,
    `  <turn-uri>${turnUri}</turn-uri>`,
    `  <agent-uri>${agentUri ?? '(unknown)'}</agent-uri>`,
    '</dkg-session-context>',
  ].join('\n');
}

async function main() {
  const payload = await readStdinJson();
  const sessionKey = extractSessionKey(payload);
  const userPrompt = extractPrompt(payload);

  // FAIL CLOSED on missing inputs. If sessionKey is null we cannot
  // build a useful turn URI. If userPrompt is empty, emitting
  // updated_input would silently REPLACE the operator's prompt with
  // just our block — see the same guard in inject-inbox.mjs.
  if (!sessionKey || !userPrompt) {
    log(`skipping injection: sessionKey=${!!sessionKey} prompt=${!!userPrompt}`);
    process.stdout.write('{}\n');
    return;
  }

  const turnIndex = loadTurnIndex(sessionKey);
  const nextTurnIndex = turnIndex + 1;
  // Mirror capture-chat.mjs `turnUri(slug, idx)`. For sanitised slugs
  // encodeURIComponent is a no-op, but we keep it for byte-alignment
  // with the producer of the URI we're predicting.
  const turnUri = `urn:dkg:chat:session:${encodeURIComponent(sessionKey)}#turn:${nextTurnIndex}`;
  const agentUri = loadAgentUri();

  const block = renderBlock({ sessionKey, nextTurnIndex, turnUri, agentUri });
  const updatedInput = `${block}\n\n${userPrompt}`;

  process.stdout.write(JSON.stringify({ updated_input: updatedInput }) + '\n');
  log(`injected: session=${sessionKey} nextTurn=${nextTurnIndex} agent=${agentUri ?? '(none)'} promptLen=${userPrompt.length}`);
}

// Self-execute only when invoked directly (avoids running during
// import from a future unit test).
const isMainModule = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    log(`unexpected error: ${err?.stack ?? err?.message ?? err}`);
    process.stdout.write('{}\n');
  });
}
