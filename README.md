# mcp-task-listener

A small, persistent MCP client that wakes your agent the moment a task
arrives. It uses the standard MCP subscription mechanism
(`resources/subscribe` + `notifications/resources/updated`), not polling:
your MCP server pushes a notification when the tasks resource changes, and
this listener acts on it within seconds.

## What it does

- Connects to an MCP server (streamable HTTP) as your agent and subscribes
  to a tasks resource (`MCP_TASKS_URI`).
- Reads the inbox once on connect (live notices are not replayed).
- On a task notification it re-reads the inbox (via `MCP_INBOX_TOOL`), and
  for each **new** task it runs your wake command (`WAKE_COMMAND`) with the
  task JSON on stdin. With no wake command it logs the task without marking it delivered.
- On a 401 it refreshes the access token (if a refresh token is configured)
  and reconnects; otherwise it exits so systemd/launchd restarts it.

Any MCP server works, as long as it exposes a subscribable tasks resource
and an inbox tool that returns a list of tasks. The task shape is
configurable: the id field (`MCP_TASK_ID_FIELD`, default `taskId`, falls
back to `id`) and the field holding the array in the inbox result.

## Install

```sh
npm install -g mcp-task-listener
```

Or run it without installing:

```sh
npx mcp-task-listener
```

Or clone this repo and run `mcp-task-listener.mjs` directly (Node 24+,
`npm install` first for `@modelcontextprotocol/client`).

## Prerequisites

- Node 24+.
- An MCP server with a tasks resource and an inbox tool, and a bearer token
  for it. Put the token in a JSON file:
  `{"access_token": "...", "refresh_token": "...", "client_id": "..."}`.
  Keep that file mode 600 — it is a credential. If you only have an access
  token, `MCP_TOKEN` works too (no automatic refresh).

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MCP_URL` | yes | — | MCP endpoint |
| `MCP_TASKS_URI` | yes | — | Resource URI to subscribe to. May contain a `{agentId}` placeholder, filled from `MCP_AGENT_ID`. |
| `MCP_AGENT_ID` | no | — | The agent's ID (for the `{agentId}` placeholder) |
| `MCP_INBOX_TOOL` | no | `tasks_inbox` | Tool that lists tasks |
| `MCP_INBOX_ARGS` | no | `{}` | JSON arguments for the inbox tool |
| `MCP_TASK_ID_FIELD` | no | `taskId` | Field that identifies a task (falls back to `id`) |
| `MCP_TOKEN` | no* | — | Bearer access token |
| `MCP_TOKEN_FILE` | no* | — | JSON token file (see above) |
| `MCP_TOKEN_URL` | no | `<MCP_URL origin>/oauth/token` | OAuth token endpoint for refresh |
| `WAKE_COMMAND` | no | — | Shell command run per new task, task JSON on stdin |
| `MCP_STATE_FILE` | no | `./mcp-task-listener-state.json` | Seen-task state file |

\* One of `MCP_TOKEN` or `MCP_TOKEN_FILE` is required.

## Setup (Linux, systemd)

```sh
sudo mkdir -p /usr/local/share/mcp-task-listener
sudo cp mcp-task-listener.mjs /usr/local/share/mcp-task-listener/
mkdir -p ~/.config/mcp-task-listener
# write the token file above to ~/.config/mcp-task-listener/token.json (mode 600)
cp mcp-task-listener.service ~/.config/systemd/user/
# edit the service: set MCP_URL, MCP_TASKS_URI, MCP_AGENT_ID, MCP_INBOX_TOOL
systemctl --user daemon-reload
systemctl --user enable --now mcp-task-listener
systemctl --user status mcp-task-listener
```

## Setup (macOS, launchd)

```sh
sudo mkdir -p /usr/local/share/mcp-task-listener
sudo cp mcp-task-listener.mjs /usr/local/share/mcp-task-listener/
mkdir -p ~/.config/mcp-task-listener
# write the token file above to ~/.config/mcp-task-listener/token.json (mode 600)
cp mcp-task-listener.plist ~/Library/LaunchAgents/io.mcp-task-listener.plist
# edit the plist: set MCP_URL, MCP_TASKS_URI, MCP_AGENT_ID, MCP_INBOX_TOOL
launchctl load ~/Library/LaunchAgents/io.mcp-task-listener.plist
```

## Wake command

`WAKE_COMMAND` is a shell command run once per new task, with the task JSON
on stdin. Wire it to whatever starts your agent. For a Pi agent, a small
script that messages the Pi RPC server (127.0.0.1:18999) works: read the
task from stdin and tell Pi to check its inbox. If you leave it unset, the
listener logs new tasks and your agent picks them up on its next own check
— still better than nothing, but not real-time.

## Example: Guildworks

Guildworks is one server this works with. Its tasks resource is
`guildworks://agent/<agent id>/tasks` and its inbox tool is
`gw_tasks_inbox` (tasks carry `taskId` and `requestId`).

```sh
MCP_URL=https://dev.guildworks.io/mcp \
MCP_TASKS_URI='guildworks://agent/{agentId}/tasks' \
MCP_AGENT_ID=<agent id> \
MCP_INBOX_TOOL=gw_tasks_inbox \
MCP_TOKEN_FILE=~/.config/mcp-task-listener/token.json \
MCP_STATE_FILE=~/.config/mcp-task-listener/state.json \
mcp-task-listener
```

## Verify it works

1. Check the logs: you should see `connected` and `subscribed to
   <your tasks URI>`.
2. Have someone send your agent a test task.
3. The listener should log the new task within seconds and run the wake
   command.

## Running it by hand

```sh
MCP_URL=https://example.test/mcp \
MCP_TASKS_URI='tasks://agent/{agentId}/tasks' \
MCP_AGENT_ID=<agent id> \
MCP_TOKEN_FILE=~/.config/mcp-task-listener/token.json \
mcp-task-listener
```

## Tests

```sh
npm test
```

Covers the URI resolution, task diff, inbox-result parsing, state file,
and the subscribe → notify → inbox → wake flow against a fake MCP client,
plus a live mock-MCP-server test proving the real SDK client subscribes
and wakes on a push (no live server needed).

## Future work

- A more involved sidecar: richer agent integration than a single wake
  command (for example, a sidecar that talks to the agent's own protocol
  directly instead of shelling out).
- An installer: one command that sets up the listener, the token file,
  and the systemd/launchd unit for you.

## Delivery and recovery guarantees

A task is recorded as seen only after the wake handler returns success. Failed
launches and nonzero exits remain eligible on the next notification or reconnect.
Notices arriving during an inbox read or wake are coalesced into another inbox
read. If a read or state save throws with a queued notice, one immediate
retry is allowed; a second check failure exits the drain. Recovery then waits
for a later notification or reconnect, not an automatic retry timer. Successful tasks are saved individually, so a later
failed wake does not discard earlier progress.

This is at-least-once wake delivery, not exactly-once task execution. A crash
between a successful wake and saving state can wake the task again. The agent
must reconcile the durable task state and claim it through the server before
working; never treat a notification as authorization. No periodic inbox polling
is introduced. A failed wake is retried by later notifications or reconnect, not
by an unbounded immediate loop. A queued notification permits one immediate retry
per failed task; further attempts wait for another notification or reconnect.
Wake exceptions do not prevent other tasks or queued notices from being handled.
A failed state save can repeat a successful wake during the bounded retry; the
server-side claim remains necessary.

The state file still uses a non-atomic write and has no multi-process lock. A
crash during that write or multiple listeners sharing one file may lose dedup
state and repeat wakes. This patch does not provide crash-safe persistence.
Reconnect recovery tests currently exercise explicit reconnection with a fake
client; the real SDK test covers initial connection and a live push, not transport
loss and resubscription. Do not infer verified real-network recovery from those
tests.

Embedding hosts may supply an async `wakeTask(task)` callback instead of a shell
command. Return `true` only when the native wake has succeeded; return `false` or
throw on failure. This is a host adapter, not proof of built-in support in an
agent application.
