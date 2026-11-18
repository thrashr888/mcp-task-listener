import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { resolveTasksUri, taskIdOf, newTasks, parseInboxResult, loadState, saveState, createListener } from '../mcp-task-listener.mjs';

test('resolveTasksUri substitutes {agentId} and accepts a function', () => {
  assert.equal(resolveTasksUri('tasks://agent/{agentId}/tasks', 'a1'), 'tasks://agent/a1/tasks');
  assert.equal(resolveTasksUri('tasks://shared/inbox'), 'tasks://shared/inbox');
  assert.equal(resolveTasksUri(id => `tasks://${id}`, 'b2'), 'tasks://b2');
  assert.throws(() => resolveTasksUri('tasks://agent/{agentId}/tasks'), /MCP_AGENT_ID is not set/);
  assert.throws(() => resolveTasksUri(undefined, 'a1'), /MCP_TASKS_URI is required/);
});

test('taskIdOf uses the configured field and falls back to id', () => {
  assert.equal(taskIdOf({ taskId: 't1' }), 't1');
  assert.equal(taskIdOf({ id: 'i1' }), 'i1');
  assert.equal(taskIdOf({ taskId: 't1', id: 'i1' }), 't1');
  assert.equal(taskIdOf({ uuid: 'u1' }, 'uuid'), 'u1');
  assert.equal(taskIdOf(null), null);
  assert.equal(taskIdOf({ taskId: 42 }), null);
});

test('newTasks returns only tasks whose id is not already seen', () => {
  const seen = ['a', 'b'];
  const tasks = [{ taskId: 'a' }, { taskId: 'c' }, { taskId: 'd' }, { taskId: null }, null];
  assert.deepEqual(newTasks(seen, tasks).map(t => t.taskId), ['c', 'd']);
  assert.deepEqual(newTasks([], []), []);
  assert.deepEqual(newTasks(null, [{ taskId: 'x' }]).map(t => t.taskId), ['x']);
  // Seen entries may be bare ids or task objects.
  assert.deepEqual(newTasks([{ taskId: 'a' }], [{ taskId: 'a' }, { taskId: 'b' }]).map(t => t.taskId), ['b']);
  // Custom id field.
  assert.deepEqual(newTasks(['u1'], [{ uuid: 'u1' }, { uuid: 'u2' }], 'uuid').map(t => t.uuid), ['u2']);
  // Falls back to id.
  assert.deepEqual(newTasks(['i1'], [{ id: 'i1' }, { id: 'i2' }]).map(t => t.id), ['i2']);
});

test('parseInboxResult accepts a bare array, an object field, or structuredContent', () => {
  const tasks = [{ taskId: 't1' }];
  assert.deepEqual(parseInboxResult({ content: [{ type: 'text', text: JSON.stringify({ tasks }) }] }), tasks);
  assert.deepEqual(parseInboxResult({ content: [{ type: 'text', text: JSON.stringify(tasks) }] }), tasks);
  assert.deepEqual(parseInboxResult({ structuredContent: { tasks } }), tasks);
  assert.deepEqual(parseInboxResult({ structuredContent: tasks }), tasks);
  assert.deepEqual(parseInboxResult({ content: [{ type: 'text', text: JSON.stringify({ items: tasks }) }] }, 'items'), tasks);
  assert.deepEqual(parseInboxResult({ content: [{ type: 'text', text: 'not json' }] }), []);
  assert.deepEqual(parseInboxResult({}), []);
});

test('state file round-trips seen task ids and starts empty when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-listener-state-'));
  try {
    const path = join(dir, 'state.json');
    assert.deepEqual(loadState(path), []);
    saveState(path, ['a', 'b', 'a']);
    assert.deepEqual(loadState(path), ['a', 'b']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')).seen, ['a', 'b']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listener subscribes to the tasks resource, reads the inbox on connect, and wakes only on new tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-listener-'));
  try {
    const stateFile = join(dir, 'state.json'), wakeFile = join(dir, 'woken.jsonl');
    const uri = resolveTasksUri('tasks://agent/{agentId}/tasks', 'agent-123');
    let handler = null, subscribed = null, inboxCalls = 0;
    const inboxResponses = [
      { tasks: [{ taskId: 't1', requestId: 'r1', instruction: 'first' }] },
      { tasks: [{ taskId: 't1', requestId: 'r1', instruction: 'first' }, { taskId: 't2', requestId: 'r2', instruction: 'second' }] },
    ];
    const fakeClient = {
      connect: async () => {},
      subscribeResource: async ({ uri: u }) => { subscribed = u; },
      setNotificationHandler: (_schema, h) => { handler = h; },
      callTool: async ({ name }) => {
        assert.equal(name, 'tasks_inbox');
        return { content: [{ type: 'text', text: JSON.stringify(inboxResponses[Math.min(inboxCalls++, inboxResponses.length - 1)]) }] };
      },
      close: () => {},
    };
    const listener = createListener({
      mcpUrl: 'https://example.test/mcp',
      tasksUri: 'tasks://agent/{agentId}/tasks',
      agentId: 'agent-123',
      token: 'test-token',
      wakeCommand: `cat >> ${wakeFile}`,
      stateFile,
      makeClient: () => ({ client: fakeClient, transport: {} }),
    });
    assert.equal(listener.uri, uri);
    await listener.connect();
    assert.equal(subscribed, uri);
    assert.equal(inboxCalls, 1, 'reads the inbox once on connect');
    let woken = readFileSync(wakeFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(woken.map(t => t.taskId), ['t1'], 'wakes only for the new task on connect');
    assert.deepEqual(listener.seen, ['t1']);
    assert.deepEqual(loadState(stateFile), ['t1']);

    // A notification for a different resource must not re-read the inbox.
    await handler({ method: 'notifications/resources/updated', params: { uri: 'tasks://agent/other/tasks' } });
    assert.equal(inboxCalls, 1);
    // A notification for our tasks resource re-reads the inbox and wakes only for the new task.
    await handler({ method: 'notifications/resources/updated', params: { uri } });
    assert.equal(inboxCalls, 2);
    woken = readFileSync(wakeFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(woken.map(t => t.taskId), ['t1', 't2'], 'does not wake twice for t1');
    assert.deepEqual(listener.seen, ['t1', 't2']);
    assert.deepEqual(loadState(stateFile), ['t1', 't2']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listener without a wake command logs tasks without consuming them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-listener-nowake-'));
  try {
    const stateFile = join(dir, 'state.json');
    const fakeClient = {
      connect: async () => {},
      subscribeResource: async () => {},
      setNotificationHandler: () => {},
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ tasks: [{ taskId: 't9', requestId: 'r9' }] }) }] }),
      close: () => {},
    };
    const listener = createListener({
      mcpUrl: 'https://example.test/mcp', tasksUri: 'tasks://agent/a9/tasks', token: 'test-token',
      stateFile, makeClient: () => ({ client: fakeClient, transport: {} }),
    });
    await listener.connect();
    assert.deepEqual(listener.seen, []);
    assert.deepEqual(loadState(stateFile), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listener requires an MCP URL, a tasks URI, and a token', () => {
  assert.throws(() => createListener({ tasksUri: 'tasks://x', token: 't' }), /MCP_URL is required/);
  assert.throws(() => createListener({ mcpUrl: 'https://x/mcp', token: 't' }), /MCP_TASKS_URI is required/);
  assert.throws(() => createListener({ mcpUrl: 'https://x/mcp', tasksUri: 'tasks://x' }), /no access token/);
});

test('live end-to-end: the real SDK listener wakes when the mock server pushes a task update', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-listener-mock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Minimal streamable-HTTP MCP server: initialize, subscribe, tools/call, SSE push.
  const inbox = { tasks: [{ taskId: 'm1', requestId: 'r1', instruction: 'mock first' }] };
  const sessions = new Map();
  let subscribedUri = null;
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const s = sessions.get(req.headers['mcp-session-id']);
      if (s) s.sseRes = res;
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') {
        const id = 'sess-' + Math.random().toString(36).slice(2);
        sessions.set(id, { sseRes: null });
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': id });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } } }));
        return;
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (msg.method === 'resources/subscribe') {
        subscribedUri = msg.params?.uri ?? null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        return;
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'tasks_inbox') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ tasks: inbox.tasks }) }] } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const wakeFile = join(dir, 'woken.jsonl'), stateFile = join(dir, 'state.json');
  const agentId = 'agent-mock';
  const tasksUri = `tasks://agent/${agentId}/tasks`;
  const listener = createListener({
    mcpUrl: `http://127.0.0.1:${port}/mcp`, tasksUri, agentId, token: 'mock-token',
    wakeCommand: `cat >> ${wakeFile}`, stateFile,
  });
  t.after(() => listener.stop());
  listener.start().catch(() => {});
  // The listener connects, subscribes, and reads the (one-task) inbox on start.
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(subscribedUri, tasksUri, 'subscribed to the tasks resource');
  assert.notEqual(listener.seen.length, 0, 'read the inbox on connect');
  let woken = [];
  try { woken = readFileSync(wakeFile, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { woken = []; }
  assert.deepEqual(woken.map(t => t.taskId), ['m1'], 'woke for the initial task');
  // A second task arrives; the server pushes a resources/updated notification.
  inbox.tasks.push({ taskId: 'm2', requestId: 'r2', instruction: 'mock second' });
  for (const s of sessions.values()) {
    if (s.sseRes && !s.sseRes.writableEnded) {
      s.sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: tasksUri } })}\n\n`);
    }
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { woken = readFileSync(wakeFile, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { woken = []; }
    if (woken.length >= 2) break;
  }
  assert.deepEqual(woken.map(t => t.taskId), ['m1', 'm2'], 'woke for the new task on the push, not again for the old one');
  assert.deepEqual(listener.seen, ['m1', 'm2']);
  listener.stop();
});

function recoveryFixture(t, { callTool, wakeTask }) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let handler;
  const client = { connect: async () => {}, subscribeResource: async () => {},
    setNotificationHandler: (_schema, callback) => { handler = callback; }, callTool, close: () => {} };
  const options = { mcpUrl: 'https://example.test/mcp', tasksUri: 'tasks://test', token: 'synthetic',
    stateFile: join(dir, 'state.json'), wakeTask, makeClient: () => ({ client, transport: {} }) };
  return { options, listener: createListener(options), notify: () => handler({ params: { uri: 'tasks://test' } }) };
}

test('failed wake remains pending and retries after reconnect without repeating successful work', async t => {
  const attempted = [];
  let fail = true;
  const fixture = recoveryFixture(t, { callTool: async () => ({ structuredContent: { tasks: [{ taskId: 'ok' }, { taskId: 'retry' }] } }),
    wakeTask: async task => { attempted.push(task.taskId); return task.taskId !== 'retry' || !fail; } });
  await fixture.listener.connect();
  assert.deepEqual(fixture.listener.seen, ['ok']);
  fail = false;
  await fixture.listener.connect();
  assert.deepEqual(fixture.listener.seen, ['ok', 'retry']);
  assert.deepEqual(attempted, ['ok', 'retry', 'retry']);
  const restarted = createListener(fixture.options);
  await restarted.connect();
  assert.deepEqual(attempted, ['ok', 'retry', 'retry'], 'persisted successes survive restart');
});

test('notification during wake causes another inbox read without overlapping wakes', async t => {
  let reads = 0, active = 0, peak = 0, fixture;
  const woken = [];
  fixture = recoveryFixture(t, { callTool: async () => ({ structuredContent: { tasks: ++reads === 1 ? [{ taskId: 'first' }] : [{ taskId: 'first' }, { taskId: 'second' }] } }),
    wakeTask: async task => { active++; peak = Math.max(peak, active); woken.push(task.taskId); if (task.taskId === 'first') await fixture.notify(); active--; return true; } });
  await fixture.listener.connect();
  assert.equal(reads, 2);
  assert.equal(peak, 1);
  assert.deepEqual(woken, ['first', 'second']);
});

test('no wake handler does not consume durable work', async t => {
  const fixture = recoveryFixture(t, { callTool: async () => ({ structuredContent: { tasks: [{ taskId: 'pending' }] } }) });
  await fixture.listener.connect();
  assert.deepEqual(fixture.listener.seen, []);
});

test('successful tasks persist before a later wake throws', async t => {
  const fixture = recoveryFixture(t, { callTool: async () => ({ structuredContent: { tasks: [{ taskId: 'ok' }, { taskId: 'bad' }] } }),
    wakeTask: async task => { if (task.taskId === 'bad') throw new Error('synthetic failure'); return true; } });
  await fixture.listener.connect();
  assert.deepEqual(loadState(fixture.options.stateFile), ['ok']);
});

test('real failed wake subprocess is not marked delivered', async t => {
  const fixture = recoveryFixture(t, { callTool: async () => ({ structuredContent: { tasks: [{ taskId: 'failed-process' }] } }) });
  const listener = createListener({ ...fixture.options, wakeCommand: 'exit 1' });
  await listener.connect();
  assert.deepEqual(listener.seen, []);
  assert.deepEqual(loadState(fixture.options.stateFile), []);
});

test('notification received during inbox read is not dropped', async t => {
  let reads = 0, fixture;
  fixture = recoveryFixture(t, { callTool: async () => {
    reads++;
    if (reads === 1) await fixture.notify();
    return { structuredContent: { tasks: [] } };
  }});
  await fixture.listener.connect();
  assert.equal(reads, 2);
});


test('wake exception drains a queued notification without needing a third event', async t => {
  let fixture, reads = 0, attempts = 0;
  const woke = [];
  fixture = recoveryFixture(t, {
    callTool: async () => ({ structuredContent: { tasks: ++reads === 1 ? [{ taskId: 'retry' }] : [{ taskId: 'retry' }, { taskId: 'arrived' }] } }),
    wakeTask: async task => {
      if (task.taskId === 'retry' && ++attempts === 1) {
        await fixture.notify();
        throw new Error('wake failed after new notification');
      }
      woke.push(task.taskId); return true;
    },
  });
  await fixture.listener.connect();
  assert.equal(reads, 2);
  assert.deepEqual(woke, ['retry', 'arrived']);
  assert.deepEqual(fixture.listener.seen, ['retry', 'arrived']);
});

test('persistent wake exception plus notification has bounded retries and preserves other work', async t => {
  let fixture, reads = 0, attempts = 0;
  fixture = recoveryFixture(t, {
    callTool: async () => { reads++; return { structuredContent: { tasks: [{ taskId: 'bad' }, { taskId: 'good' }] } }; },
    wakeTask: async task => {
      if (task.taskId === 'bad') { attempts++; await fixture.notify(); throw new Error('persistent'); }
      return true;
    },
  });
  await fixture.listener.connect();
  assert.equal(attempts, 2);
  assert.equal(reads, 3);
  assert.deepEqual(fixture.listener.seen, ['good']);
  await fixture.notify();
  assert.equal(attempts, 4, 'a later event permits a new bounded attempt cycle');
});


test('queued notification recovers a failed inbox read without a third event', async t => {
  let reads = 0, fixture;
  fixture = recoveryFixture(t, {
    callTool: async () => {
      reads++;
      if (reads === 2) { await fixture.notify(); throw new Error('transient read'); }
      return { structuredContent: { tasks: reads >= 3 ? [{ taskId: 'arrived' }] : [] } };
    },
    wakeTask: async () => true,
  });
  await fixture.listener.connect();
  await fixture.notify();
  assert.equal(reads, 3);
  assert.deepEqual(fixture.listener.seen, ['arrived']);
});

test('persistent inbox failure plus queued notifications is bounded', async t => {
  let reads = 0, fixture;
  fixture = recoveryFixture(t, {
    callTool: async () => { reads++; await fixture.notify(); throw new Error('persistent read'); },
    wakeTask: async () => true,
  });
  await assert.rejects(fixture.listener.connect(), /persistent read/);
  assert.equal(reads, 2);
  assert.deepEqual(fixture.listener.seen, []);
});


test('state save failure with queued notices is bounded and never marks seen', async t => {
  let fixture, wakes = 0;
  fixture = recoveryFixture(t, {
    callTool: async () => ({ structuredContent: { tasks: [{ taskId: 'unsaved' }] } }),
    wakeTask: async () => { wakes++; await fixture.notify(); return true; },
  });
  mkdirSync(fixture.options.stateFile); // force an actual filesystem write failure
  await assert.rejects(fixture.listener.connect(), /EISDIR/);
  assert.equal(wakes, 2, 'successful wake may repeat when persistence fails');
  assert.deepEqual(fixture.listener.seen, []);
});
