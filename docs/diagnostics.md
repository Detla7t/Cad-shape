# Diagnostics log

Chili3D keeps a bounded, structured log of **wide events** rather than a diary of what the code did
(after [loggingsucks.com](https://loggingsucks.com/)). One event per completed operation carries
everything a bug report needs to reproduce the situation. The rail button "Download diagnostic logs"
exports it as NDJSON; `OperationLog.snapshot()` reads it in code.

## Event shape (schema 2)

| Field | What it holds |
| --- | --- |
| `sequence` | Order the operations finished in, per session. |
| `operationId`, `parentId` | Causal structure: the operation that was still open when this one began — a command is the parent of the transactions it runs, a transaction of the feature rebuilds it triggers. |
| `operation` | `command.execute`, `model.transaction`, `feature.rebuild`, `sketch.session`, `sketch.commit`, `ui.error`, `app.unhandledError`, `app.unhandledRejection`. |
| `outcome`, `durationMs`, `error` | Success / cancelled / error / rolled back; the error with its stack. |
| `session` | Static per page load: `sessionId`, `appVersion`, `documentSchema`, `userAgent`, `platform`, `language`, `devicePixelRatio`, `screen`, `hardwareConcurrency`, `production`. |
| `context` | What the operation itself knows: the command key (and the key that was requested before routing), its `param.*` values, selection counts at start, the transaction's action and record names, the feature id and type, the sketch's entity/constraint counts, DOFs and solve result. |
| `state` | The application at finish, from registered providers: active document id/name/units, node count, selection counts, undo/redo depth, version-control branch and head and pending operations, the view's camera type, mode and size, the running command, snap/autosave/navigation preferences, the sketch being edited and its solve state. |
| `steps` | Named points inside the operation with their offset: each pick a sketch tool made (`pick.point` with entity and point index, `pick.entity`, `pick.position` with uv). |

Design rules:

- **No per-frame or per-pointer logging.** Interaction detail goes on the operation it belongs to, as a step.
- **State is captured once, at finish**, by providers registered with `OperationLog.addContextProvider`. A provider that throws loses only its own fields (`state.providerError`).
- **Errors are events too.** Every `displayError` becomes a `ui.error`; window errors and unhandled rejections become `app.unhandled*`, both with the current state and the open command as parent.
- **Retention is tail-sampled.** The buffer keeps 2000 events; when it trims, the oldest fast successful event goes first, so failures, roll-backs and operations over 250 ms survive long sessions.
- **Export is NDJSON** with a session header line (`kind: "session"`, open operations at export time), then the events in sequence order.

## Reproducing from a log

1. Read the header for the build and platform.
2. Filter `operation: "command.execute"` in `sequence` order: that is the sequence of user actions, each with its parameters and the selection it started from.
3. For a failing one, follow `parentId` from the `ui.error` / `feature.rebuild` event up to the command, and read `state` on the error for the document, history head, units and sketch state at that moment.
4. Sketch problems: `sketch.session` lists every pick as a step; `sketch.commit` gives counts, DOFs and the solver result after each edit.

Adding context: call `operation.add({...})` as a command learns more, `operation.step(name, {...})` for a
stage worth timing, and register a provider for state that every event should carry.
