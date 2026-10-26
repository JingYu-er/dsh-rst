# dsh-rst

> One `/rst` restarts DSH, and the restarted DSH posts a receipt back into the very session you typed it in.

中文: [README.md](README.md) · [Install](#install) · [Screenshot](#screenshot) · [Quick start](#quick-start) · [Timeline](#timeline) · [Safety](#safety-boundaries) · [The receipt](#the-restart-receipt) · [Logs](#state-files-and-logs) · [Limitations](#compatibility-and-known-limitations)

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-rst?style=flat)](https://github.com/JingYu-er/dsh-rst)
![version](https://img.shields.io/badge/version-0.2.4-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-lightgrey)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## What it is

`dsh-rst` adds a **human-facing** slash command to DSH: type `/rst` in a session and DSH restarts itself, then — after it is back — appends a receipt card to the **same session** telling you how long it took and the new host PID.

What it does not do: it does not take over process management, does not switch your model or config, and does not touch your conversation (apart from that receipt card). It is a user command, not a model tool — the model cannot call it. Works in the desktop app and in CLI mode.

## Screenshot

After typing `/rst` in a session:

![`/rst` restarting and the completion receipt](docs/rst-restart.png)

The command card shows the launcher PID, the log path, and the expected downtime; a few seconds later the **same session** gets the receipt: "已重启完成：DSH 已经带着新配置回到这个会话（用时 X 秒，新 Host PID N）".

## Why this plugin exists

Restarting DSH by hand is not hard; doing it many times a day is what wears you down: installing or updating a plugin needs a restart to take effect, a one-line plugin edit needs a restart to be seen, a config change needs a restart to be trusted, an experiment ends and you want a clean slate — each time it is "close the app → wait for it to exit → double-click the icon → reopen the session you were in → remember what you were debugging". The steps are short, but after the twentieth repetition it is your attention that pays, not the few seconds.

`/rst` collapses all of that into one command:

- **No more manual dance after installing, editing, or configuring.** Type `/rst` in a session; seconds later the same session gets a receipt — "已重启完成（用时 X 秒，新 Host PID N）" — and the new host has already loaded what you just installed or edited. While iterating on a plugin this loop runs dozens of times a day, and that is where the plugin earns its keep.
- **The result comes back to where you were talking.** The receipt lands in the original session, so nothing is lost and you do not have to reconstruct which change you were verifying.
- **You can restart from anywhere.** Combined with remote-control plugins such as `@xmanrui/dsh-im`, sending `/rst` from your phone restarts DSH remotely (via the message fallback channel) — handy when the GUI hangs, the remote desktop is not connected, or you are away from the machine.

### Why the launcher must live outside the process tree (technical note)

A restart is three steps: stop the current host → wait for its web port to be released → start the same executable again with the same arguments. The host cannot do this itself:

1. **The command card runs inside the host, and the host dies mid-way.** Nothing guarantees the "wait for the port → relaunch" steps complete, so a process **outside the DSH process tree** has to own them.
2. **State cannot be requested back through `process.send` or preload.** The host and the Electron main process are two different processes; a restart must be driven from outside.
3. **There is no reverse channel.** Nothing notifies "restart complete" — that receipt can only be sent by the **new host**, after it is up.

So the work is split three ways: the plugin takes the command, writes the handoff file, and posts the receipt; a detached plain-Node launcher (`relaunch.cjs`) performs the restart; the new host reads `pending.json` and delivers the receipt.

## Install

### From npm (recommended)

```powershell
dsh plugin --profile desktop add dsh-rst
```

### From GitHub

```powershell
dsh plugin --profile desktop add github:JingYu-er/dsh-rst#main
```

Then **restart DSH once** so the bundle layer takes effect. Verify readiness with:

```
/rst --dry-run
```

It prints the plan (parent / host PID, executable to relaunch, web port, log path) and **touches no process**.

For local development use a link:

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-rst
```

No manual restart is needed after editing code: the host started by the next `/rst` loads the new code (the plugin bootstraps itself).

## Quick start

| Usage | Behaviour |
|-------|-----------|
| `/rst` | Restart DSH and report the launcher PID plus log path |
| `/rst --dry-run` | Print the plan only; kill nothing, launch nothing |

## Timeline

```
you: /rst
 │
 ├─ plugin (inside the host) immediately returns a "restarting" command card
 │    └─ writes %LOCALAPPDATA%\dsh-rst\pending.json
 │       (sessionId / startedAt / shellPid / hostPid)
 │
 ├─ spawns relaunch.cjs with process.execPath + ELECTRON_RUN_AS_NODE=1 (detached)
 │    └─ launcher: wait 2 s → safety gate → graceful stop of the host
 │       → wait for host exit → wait for the web port → launch the same exe
 │       → write restart-<ts>.log
 │
 └─ new host is up, DSH restores the session
      └─ plugin polls sessions.get(sessionId) every 500 ms, up to 180 s
         └─ session goes live → append the receipt (command/run + command/done)
            → delete pending.json
```

## Safety boundaries

A restart means killing processes, so the boundaries are deliberately narrow:

- **Safety gate**: right before killing, one `tasklist` call confirms the target PID's **image name** matches the executable recorded in the plan (case-insensitive). On a mismatch it aborts — logs only, **no process is killed**.
- **PID only, never `/T`**: no killing by name, and no collateral damage to child processes (Vite, build tooling, your terminal are out of scope).
- **Every step is recorded**: start / gate / wait / kill / spawn / abort all land in `restart-<ts>.log`; on abort the command result says so honestly ("已中止：shell 不是 …").
- **No fake success**: if the relaunch fails, the result is failed with the log path — never silently swallowed.
- **`--dry-run` has zero side effects**: prints the plan, touches no process, writes no `pending.json`.

## The restart receipt

The receipt is a handoff across the restart:

1. `/rst` writes `pending.json` (session id, start time, PIDs).
2. After `apply`, the plugin in the new host polls `sessions.get(sessionId)` every 500 ms for up to 180 s.
3. The first poll where the session is live again appends two events to the original session:
   - `command/run` — the command card (name `rst`, `source` user)
   - `command/done` — kind `success`, text "已重启完成：DSH 已经带着新配置回到这个会话（用时 X 秒，新 Host PID N）。"
4. On success `pending.json` is deleted; on timeout only the log records it.

**Only command cards are written — no assistant/message events, no synthetic turns.** This is a hard-won conclusion: an early version injected assistant events into the session log and pushed a message into the current turn so the receipt would "show up in the conversation", which broke session parsing outright (wrong turn count, non-zero parseFail, dropped frames). The session log is DSH's persistence format and must stay parseable by DSH itself; command cards are a supported write surface, so the receipt uses that.

A receipt timeout is **not** a failed restart: if you never reopen that session within 180 s, the pending file stays and is retried on the next startup (logged honestly as a timeout).

## State files and logs

All under `%LOCALAPPDATA%\dsh-rst\`:

| File | Contents |
|------|----------|
| `loaded.log` | Plugin loaded by a host (pid, electron version, whether the commands service was available) |
| `invocations.log` | Every trigger (command or message, session, context) |
| `host-trace.log` | Host-side traces; separates "command never arrived" from "launcher never started" |
| `announce.log` | Receipt polling detail: start / attempt / appended / timeout |
| `pending.json` | Pending receipt (done only when appended; deleted on success) |
| `restart-<ts>.log` | Per-restart launcher step log |

## Implementation notes

| Aspect | Desktop mode | CLI mode |
|--------|--------------|----------|
| Detection | `process.versions.electron` present and `process.send` is a function | everything else |
| What gets stopped | `taskkill /PID <Electron main>` (graceful first, forced after 2 s) | launcher calls `process.exit(0)` |
| What gets relaunched | the same exe with `ELECTRON_RUN_AS_NODE` removed from env | same node binary, same argv |
| Port wait | port parsed from `DSH_WEB_URL`, waits up to 10 s | none |
| Failure surface | command card reports launcher PID and log path | same |

Launcher arguments: `--shell --host --exe --workdir --log --delay --grace [--port] [--exeargs]`; defaults are `delay=2000ms` (time for the command card to be persisted) and `grace=2000ms` (graceful shutdown allowance). A failed launch is retried up to 3 times, checking survival 1 s after each spawn.

Environment: `DSH_WEB_URL` (web port), `LOCALAPPDATA` (state dir, falling back to `TEMP` / the user profile).

**Message fallback**: when a remote-control plugin such as `@xmanrui/dsh-im` delivers messages, `/rst` arrives as a plain message. The plugin listens on `session/event` globally and, on a match of `^/rst(\s|$)` with a 5 s debounce, runs the same flow.

## Compatibility and known limitations

- Process enumeration and termination rely on `tasklist` / `taskkill`: **Windows 10/11 only** for now.
- Desktop and CLI modes only. TUI mode has no web port, so the launcher does not wait for one.
- The receipt requires the session to be live again within 180 s; on timeout only the log knows, the session shows nothing.
- A restart interrupts any in-flight turn — do not `/rst` mid-turn.
- The command name is fixed to `rst`; rename it if another plugin uses it.
- A timed-out `pending.json` is not cleaned up: it retries on the next startup, and if that session no longer exists you get a few timeout lines in the log (harmless).

## Troubleshooting

1. **`/rst` is not in completions** → the plugin is not loaded. Check for a fresh `loaded.log` line and that the profile's `package.json` has both the link dependency and the `bundles` entry.
2. **"找不到重启器脚本" (launcher script not found)** → incomplete package: `relaunch.cjs` was left out of `files`.
3. **The app does not come back** → find where `restart-<ts>.log` stops. `abort: shell … is not …` means the safety gate stopped it (the parent process was not DSH).
4. **No receipt** → `announce.log` has only start/attempt lines: the session never came back live. Open that session and wait up to 180 s, or let the next startup retry.
5. **Session log reports dropped frames / parseFail** → should no longer happen: the receipt writes only command cards, never assistant messages.

## Repository layout

```
dsh-rst/
├── index.js          plugin entry: name / apply / command registration / receipt handoff
├── relaunch.cjs      launcher (plain Node, spawned detached, outside the DSH tree)
├── relaunch.ps1      early PowerShell launcher (deprecated, kept for reference)
├── cordis.patch.yml  bundle layer declaration: mounts the plugin into the loader tree
├── package.json
├── README.md / README_EN.md
└── LICENSE
```

## Development

`index.js` is the only host-side entry; `relaunch.cjs` has no DSH dependency and uses only the Node standard library, so it can be debugged on its own.

Verify changes by simply running `/rst` — the new host loads the new code from the workspace. Before touching anything, run `/rst --dry-run` to confirm which process you are about to stop.

## License

[MIT](LICENSE)
