#!/usr/bin/env node
/**
 * mcp-task-listener — a generic MCP task listener.
 *
 * A small, persistent MCP client that subscribes to a tasks resource and
 * wakes your agent the moment a new task arrives. This is the standard MCP
 * subscription mechanism (resources/subscribe +
 * notifications/resources/updated), not polling: the server pushes a
 * notification when the resource changes, and this client acts on it.
 *
 * How it works:
 *  - Connects to an MCP server (streamable HTTP) as the agent.
 *  - Subscribes to the tasks resource (MCP_TASKS_URI).
 *  - On a resources/updated notification for that URI it calls the inbox
 *    tool (MCP_INBOX_TOOL), diffs the tasks against a state file, and for
 *    each NEW task runs the wake command (WAKE_COMMAND) with the task JSON
 *    on stdin. With no wake command it just logs the new task.
 *  - It also reads the inbox once on connect (live notices are not replayed).
 *  - On a 401 it refreshes the access token (if a refresh token is configured)
 *    and reconnects; otherwise it exits non-zero so systemd/launchd restarts it.
 *
 * Configuration (environment):
 *  MCP_URL           MCP endpoint (required)
 *  MCP_TASKS_URI     resource URI to subscribe to (required). May contain a
 *                    {agentId} placeholder, filled from MCP_AGENT_ID.
 *  MCP_AGENT_ID      the agent's ID (used for the {agentId} placeholder)
 *  MCP_INBOX_TOOL    tool that lists tasks (default tasks_inbox)
 *  MCP_INBOX_ARGS    JSON arguments for the inbox tool (default {})
 *  MCP_TASK_ID_FIELD field that identifies a task (default taskId; falls
 *                    back to id)
 *  MCP_TOKEN         bearer access token (or MCP_TOKEN_FILE)
 *  MCP_TOKEN_FILE    JSON file with {access_token, refresh_token, client_id,
 *                    token_url?, expires_at?}; read at start, updated on refresh
 *  MCP_TOKEN_URL     OAuth token endpoint for refresh (default: the MCP URL's
 *                    origin + /oauth/token)
 *  WAKE_COMMAND      shell command run per new task (task JSON on stdin);
 *                    unset means log only
 *  MCP_STATE_FILE    seen-task state file (default ./mcp-task-listener-state.json)
 *
 * Example (Guildworks): MCP_URL=https://dev.guildworks.io/mcp,
 * MCP_TASKS_URI=guildworks://agent/{agentId}/tasks,
 * MCP_INBOX_TOOL=gw_tasks_inbox. See README.md.
 *
 * Run it under systemd (mcp-task-listener.service) or launchd
 * (mcp-task-listener.plist) in this directory. See README.md for setup.
 *
 * Future work: a more involved sidecar (richer agent integration than a
 * single wake command) and an installer.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Resolve the tasks URI: a string (with an optional {agentId} placeholder) or a function. */
export function resolveTasksUri(tasksUri, agentId) {
  if (typeof tasksUri === 'function') return tasksUri(agentId);
  if (typeof tasksUri === 'string') {
    if (tasksUri.includes('{agentId}')) {
      if (!agentId) throw new Error('MCP_TASKS_URI contains {agentId} but MCP_AGENT_ID is not set');
      return tasksUri.replaceAll('{agentId}', agentId);
    }
    return tasksUri;
  }
  throw new Error('MCP_TASKS_URI is required');
}

/** The id of a task: the configured field, falling back to `id`. */
export function taskIdOf(task, idField = 'taskId') {
  if (!task || typeof task !== 'object') return null;
  const v = task[idField] ?? task.id;
  return typeof v === 'string' ? v : null;
}

/** Tasks in `tasks` whose id is not in `seen`. Pure; unit-tested. */
export function newTasks(seen, tasks, idField = 'taskId') {
  const known = new Set((seen ?? []).map(t => typeof t === 'string' ? t : taskIdOf(t, idField)).filter(Boolean));
  return (tasks ?? []).filter(t => {
    const id = taskIdOf(t, idField);
    return id !== null && !known.has(id);
  });
}

/**
 * Pull the task array out of an inbox tool result. Accepts a bare array, or
 * an object holding the array under `tasksField` (default 'tasks'). Prefers
 * structuredContent when the SDK provides it, else parses the text content.
 */
export function parseInboxResult(result, tasksField = 'tasks') {
  let data = result?.structuredContent ?? null;
  if (data === null || data === undefined) {
    const text = result?.content?.[0]?.text ?? '{}';
    try { data = JSON.parse(text); } catch { return []; }
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const tasks = data[tasksField];
    return Array.isArray(tasks) ? tasks : [];
  }
  return [];
}

export function loadState(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data.seen) ? data.seen : [];
  } catch { return []; }
}

export function saveState(path, seen) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify({ seen: [...new Set(seen)], updatedAt: Date.now() }, null, 2) + '\n');
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (level === 'error') console.error(line); else console.log(line);
}

function tokenUrlFor(mcpUrl, override) {
  if (override) return override;
  return new URL('/oauth/token', mcpUrl).href;
}

async function refreshAccessToken({ tokenFile, tokenUrl, refreshToken, clientId }) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (clientId) body.set('client_id', clientId);
  const res = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.access_token !== 'string') throw new Error('token refresh returned no access_token');
  const next = { access_token: data.access_token, refresh_token: data.refresh_token ?? refreshToken, client_id: clientId ?? undefined, token_url: tokenUrl, expires_at: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined };
  if (tokenFile) { mkdirSync(dirname(resolve(tokenFile)), { recursive: true }); writeFileSync(tokenFile, JSON.stringify(next, null, 2) + '\n'); }
  return next.access_token;
}

function runWakeCommand(command, task) {
  return new Promise(resolve => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(JSON.stringify(task) + '\n');
    child.on('error', err => { log('error', `wake command failed to start: ${err.message}`); resolve(false); });
    child.on('close', code => { if (code !== 0) log('error', `wake command exited ${code}`); resolve(code === 0); });
  });
}

export function createListener(config) {
  const {
    mcpUrl,
    tasksUri,
    agentId,
    inboxTool = 'tasks_inbox',
    inboxArgs = {},
    tasksField = 'tasks',
    taskIdField = 'taskId',
    token,
    tokenFile,
    tokenUrl,
    wakeCommand,
    wakeTask = wakeCommand ? task => runWakeCommand(wakeCommand, task) : null,
    stateFile = './mcp-task-listener-state.json',
    makeClient = defaultMakeClient,
  } = config ?? {};
  if (!mcpUrl) throw new Error('MCP_URL is required');
  const uri = resolveTasksUri(tasksUri, agentId);
  let accessToken = token ?? null;
  let refreshToken = null, clientId = null;
  if (tokenFile && existsSync(tokenFile)) {
    try {
      const saved = JSON.parse(readFileSync(tokenFile, 'utf-8'));
      accessToken = accessToken ?? saved.access_token ?? null;
      refreshToken = saved.refresh_token ?? null;
      clientId = saved.client_id ?? null;
    } catch (e) { log('error', `could not read token file ${tokenFile}: ${e.message}`); }
  }
  if (!accessToken) throw new Error('no access token: set MCP_TOKEN or MCP_TOKEN_FILE');
  let seen = loadState(stateFile);
  let client = null, stopped = false, checking = false, pendingCheck = false;

  function defaultMakeClient(bearer) {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const c = new Client({ name: 'mcp-task-listener', version: '1.0.0' }, { capabilities: {} });
    return { client: c, transport };
  }

  async function checkInbox() {
    if (!client || stopped) return;
    if (checking) { pendingCheck = true; return; }
    checking = true;
    const attempts = new Map();
    let failedChecks = 0;
    try {
      do {
        pendingCheck = false;
        try {
          const result = await client.callTool({ name: inboxTool, arguments: inboxArgs });
          const tasks = parseInboxResult(result, tasksField);
          const fresh = newTasks(seen, tasks, taskIdField);
          if (!fresh.length) log('info', 'inbox check: no new tasks');
          for (const task of fresh) {
            if (stopped) break;
            const id = taskIdOf(task, taskIdField) ?? '?';
            log('info', `new task ${id}`);
            if (!wakeTask) {
              log('info', `no wake command configured; task ${id} remains pending`);
              continue;
            }
            // Drain queued notices even when one wake throws. Bound immediate retries
            // per task so a failing handler that also notifies cannot spin forever.
            const count = attempts.get(id) ?? 0;
            if (count >= 2) continue;
            attempts.set(id, count + 1);
            let delivered = false;
            try { delivered = await wakeTask(task); }
            catch (e) { log('error', `wake failed for ${id}: ${e.message}`); }
            if (!delivered) continue;
            const nextSeen = [...seen, id];
            saveState(stateFile, nextSeen);
            seen = nextSeen;
          }
        } catch (e) {
          // A notice queued during a failed read/save deserves a bounded drain,
          // but persistent failure must return control rather than spin.
          failedChecks++;
          if (!pendingCheck || failedChecks >= 2 || stopped) throw e;
          log('error', `inbox check failed; draining queued notice: ${e.message}`);
        }
        // Coalesce notices arriving during inbox/wake work instead of losing them.
      } while (pendingCheck && !stopped);
    } catch (e) {
      log('error', `inbox check failed: ${e.message}`);
      throw e;
    } finally { checking = false; }
  }

  async function connectOnce() {
    const { client: c, transport } = makeClient(accessToken);
    client = c;
    client.setNotificationHandler('notifications/resources/updated', async notification => {
      if (notification?.params?.uri === uri) {
        log('info', `tasks resource updated: ${uri}`);
        try { await checkInbox(); } catch { /* already logged */ }
      }
    });
    await client.connect(transport);
    log('info', `connected to ${mcpUrl}`);
    await client.subscribeResource({ uri });
    log('info', `subscribed to ${uri}`);
    await checkInbox(); // live notices are not replayed; read once on connect
    return { client, transport };
  }

  async function start() {
    let delayMs = 1000;
    while (!stopped) {
      try {
        const { transport } = await connectOnce();
        // Wait until the transport closes (or the process is stopped).
        await new Promise(resolve => {
          const done = () => resolve();
          transport.onclose = done;
          transport.onerror = () => { log('error', 'transport error; reconnecting'); done(); };
        });
        if (stopped) break;
        log('info', 'connection closed; reconnecting');
      } catch (e) {
        const unauthorized = e?.code === 401 || /401|Unauthorized/i.test(String(e?.message ?? ''));
        if (unauthorized && refreshToken) {
          try {
            log('info', 'access token expired; refreshing');
            accessToken = await refreshAccessToken({ tokenFile, tokenUrl: tokenUrlFor(mcpUrl, tokenUrl), refreshToken, clientId });
            delayMs = 1000;
            continue;
          } catch (refreshErr) {
            log('error', `token refresh failed: ${refreshErr.message}; set a fresh MCP_TOKEN`);
            process.exitCode = 1;
            return;
          }
        }
        if (unauthorized) {
          log('error', 'access token rejected (401) and no refresh token is configured; set a fresh MCP_TOKEN');
          process.exitCode = 1;
          return;
        }
        log('error', `connect failed: ${e.message}; retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 60000);
        continue;
      }
      await new Promise(r => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 60000);
    }
  }

  function stop() { stopped = true; try { client?.close?.(); } catch {} }

  return { start, stop, connect: connectOnce, checkInbox, get seen() { return [...seen]; }, uri };
}

// Run as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  let inboxArgs = {};
  if (process.env.MCP_INBOX_ARGS) {
    try { inboxArgs = JSON.parse(process.env.MCP_INBOX_ARGS); }
    catch { console.error(`[error] MCP_INBOX_ARGS is not valid JSON`); process.exitCode = 1; }
  }
  const config = {
    mcpUrl: process.env.MCP_URL,
    tasksUri: process.env.MCP_TASKS_URI,
    agentId: process.env.MCP_AGENT_ID,
    inboxTool: process.env.MCP_INBOX_TOOL,
    inboxArgs,
    taskIdField: process.env.MCP_TASK_ID_FIELD,
    token: process.env.MCP_TOKEN,
    tokenFile: process.env.MCP_TOKEN_FILE,
    tokenUrl: process.env.MCP_TOKEN_URL,
    wakeCommand: process.env.WAKE_COMMAND,
    stateFile: process.env.MCP_STATE_FILE,
  };
  let listener;
  try {
    listener = createListener(config);
  } catch (e) {
    log('error', e.message);
    process.exitCode = 1;
  }
  if (listener) {
    const shutdown = () => { listener.stop(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    listener.start().catch(e => { log('error', `listener stopped: ${e.message}`); process.exitCode = 1; });
  }
}
