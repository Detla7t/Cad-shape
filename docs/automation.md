# Automation bridge

`scripts/automation-bridge.mjs` lets Claude Code, or a shell, drive a running Chili3D tab. It can do
anything the user can do: move the camera, run commands, click and drag in the viewport, press keys,
use any panel or dialog, read state and take screenshots. The tools are the in-app assistant's own
registry (`packages/ai/src/tools`, `buildTools("automation")`), so the two never drift apart. Every
call runs in the tab through the same code path as the user's input. Each call is recorded in the
tab's `OperationLog` as an `automation.call` event, with its source.

## Enable it in the app

- **Persistent:** Preferences ▸ Automation ▸ "Let the local automation bridge drive this app", then
  Save. The bridge URL defaults to `http://127.0.0.1:7782`.
- **One session:** add `?automation=1` to the address. For example,
  `http://localhost:8080/?automation=1&template=end-cap-configurator`. Use `?automation=7790` to
  pick another port.

The tab connects out to the bridge and reconnects with backoff. While it is connected, a small
badge in the bottom right reads "Automation connected" and shows the last remote tool. Its
**Disconnect** button ends the connection until the page reloads or the preference is saved again.

## Connect Claude Code

The project's `.mcp.json` registers the bridge as the `chili3d` MCP server
(`node scripts/automation-bridge.mjs`). Claude Code starts it over stdio, and the same process also
opens the HTTP listener. When the port is already taken by another bridge (a second Claude
session, or `npm run automation`), the new instance shares that bridge as a client. If the owner
exits, the client takes over the port.

The MCP tools are:

- the connected tab's tools;
- `list_sessions`: the connected tabs, and which one calls go to;
- `use_session`: send later calls to another tab.

Images (screenshots) come back as MCP image content.

## Drive it from a shell

```bash
npm run automation        # HTTP only; prints the token
TOKEN=$(node -p 'require(`${process.env.XDG_RUNTIME_DIR || require("os").tmpdir()}/chili3d-automation-7782.json`).token')
H="Authorization: Bearer $TOKEN"

curl -s -H "$H" http://127.0.0.1:7782/sessions
curl -s -H "$H" http://127.0.0.1:7782/tools | jq '.tools[].name'
curl -s -H "$H" -X POST http://127.0.0.1:7782/call -d '{"tool":"get_app_state"}'
curl -s -H "$H" -X POST http://127.0.0.1:7782/call -d '{"tool":"rotate_view","args":{"view":"iso"}}'
curl -s -H "$H" -X POST http://127.0.0.1:7782/call -d '{"tool":"execute_command","args":{"command":"create.box"}}'
curl -s -H "$H" -X POST http://127.0.0.1:7782/call -d '{"tool":"view_pointer","args":{"action":"click","x":600,"y":400}}'
curl -s -H "$H" -X POST http://127.0.0.1:7782/call -d '{"tool":"ui_click","args":{"text":"Fillet","role":"button"}}'
curl -s -H "$H" -X POST http://127.0.0.1:7782/call -d '{"tool":"capture_screenshot"}' \
  | jq -r '.images[0].data' | base64 -d > shot.png
```

`POST /call` takes `{ tool, args?, session?, timeoutMs? }` and answers
`{ ok, session, content, images: [{ mediaType, data }], isError }`. Here `content` is the tool's
JSON text. `GET /health` needs no token.

## Security model

- The bridge listens on 127.0.0.1 only and checks the `Host` header, which blocks DNS rebinding.
- **Tab routes** (`/tab/*`) accept only the app's browser origins: `localhost` and `127.0.0.1` on
  ports 8080 and 8081, plus the 8096 preview. Add more with `--origin <url>` or `CHILI3D_ORIGINS`
  (comma-separated). Each tab gets a per-connection key. Only that key can register tools or answer
  calls for the tab.
- **Caller routes** (`/sessions`, `/tools`, `/call`) need the per-run token, sent as
  `Authorization: Bearer` or `X-Chili3d-Token`.
  - They refuse any request that carries an `Origin` header, so no web page can call them, even
    with the token.
  - The token is printed at start. It is also written to `chili3d-automation-<port>.json` (mode
    0600) in `$XDG_RUNTIME_DIR`, or in the OS temp directory, and removed on exit.
- Tools run only in tabs whose user turned automation on.
- `evaluate_script` is marked `availability: "external"`. It is offered over the bridge (MCP stdio
  and the authenticated HTTP endpoint) and never to the in-app assistant.
- Model edits go through the app's commands and transactions, so Undo works as for the user.
- The offline preview's CSP (`scripts/serve-offline.mjs`) allows `connect-src` to
  `127.0.0.1:7782`.

## Tools

The assistant's existing tools: `get_document_state`, `get_selection`, `get_ribbon`, node, property,
material and variable tools, `capture_screenshot`, `fit_content`, `isolate_view`, `rotate_view`,
`set_camera_type`, `click_view`, `select_nodes`, `export_nodes`, `run_program`, `run_parametric`,
`undo`, `redo`, `load_skill`, `ask_user`.

Extended tools:

- **`capture_screenshot`** also takes `region` (a crop of the viewport) or an element target
  (`ref` / `selector` / `label` / `text`), for a best-effort picture of any panel or of the whole
  window.
- **`rotate_view`** takes every view-cube face, edge and corner (`"top front right"`, `iso`), plus
  `animate`.

| Tool | What it does |
| --- | --- |
| `get_camera` | Eye, target, up, direction, distance, projection, field of view, visible height, viewport size, matching view-cube name |
| `set_camera` | Set eye / target / up / direction / distance / viewHeight / projection exactly |
| `pan_zoom_view` | Pan as a pan drag by pixels; zoom by a factor around the target |
| `list_commands` | Every registered command: id, localized name, ribbon place, hotkey |
| `execute_command` | Run a command by id, as its button does; reports `finished`, or `waiting` with the prompt |
| `get_command_state` | The running command, its prompt, open operations, recent toasts and errors |
| `cancel_command` | Cancel the running command |
| `view_pointer` | Viewport move / down / up / click / double_click / drag / wheel, in view pixels, normalized 0..1, or a projected world point; any button and modifiers |
| `press_key` | Key or combo (`"Ctrl+Z"`) to a target, the viewport, or the focused element |
| `ui_snapshot` | Visible interactive UI with stable refs, roles, names, values and state; filters `query`, `role`, `within` |
| `ui_click` / `ui_focus` | Click (or double / right click) or focus an element by ref, selector, label or text |
| `ui_type` | Type into an input, textarea, contenteditable or code editor; `submit` presses Enter |
| `ui_select` | Pick an option in a `<select>` or a custom dropdown or menu |
| `ui_read` | Text and field values of a panel, a dialog (by default the topmost one) or the page |
| `get_app_state` | Documents, active view, element tabs, selection with sub-shapes, undo/redo stacks, running command |
| `list_documents` / `activate_document` | Open and saved documents; switch to or open one |
| `open_element` | Show the Part Studio or an element tab (Feature, Variable or CAM Studio, a drawing, …) |
| `get_operation_log` | The latest OperationLog events, filtered by operation, outcome, or `afterSequence` |
| `wait_for` | Wait for `idle`, `command_finished`, `element`, `element_gone`, `text` or `log_event`, with a timeout |
| `evaluate_script` | JavaScript in the page with `app`, `core`, `view` and `doc` in scope (bridge only) |

A typical loop is to act, then wait and verify:

1. Act: `execute_command`, then `view_pointer` for its picks.
2. Wait: `wait_for` with `command_finished`.
3. Verify: `get_operation_log` with `operation: "command."`, then `capture_screenshot`.
