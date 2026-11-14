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
  task JSON on stdin. With no wake command it just logs the new task.
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
