<div align="center">

<img src="docs/screenshots/multi-panes.png" alt="vMux — 6 Claude Code agents running in parallel" width="100%"/>

# vMux

**The Windows-native cmux alternative for AI coding agents.**
Run Claude Code, Codex, Aider, Cursor Agent and Gemini side by side — each isolated in its own git worktree, with native ConPTY terminals, tmux-style splits, embedded localhost preview and automatic event detection. No WSL. No Docker. No browser-based workaround.

[![Latest release](https://img.shields.io/github/v/release/vk1356/vmux?label=latest&color=f97316)](https://github.com/vk1356/vmux/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/vk1356/vmux/total?color=22c55e)](https://github.com/vk1356/vmux/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](#license)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-3b82f6)](#requirements)
[![Built with Electron](https://img.shields.io/badge/electron-41-9333ea)](https://www.electronjs.org/)

[Download](https://github.com/vk1356/vmux/releases/latest) ·
[Features](#features) ·
[vs cmux](#vmux-vs-cmux-vs-wmux-vs-raw-tmux) ·
[Quick start](#installation) ·
[Architecture](#architecture)

</div>

---

## vMux vs cmux vs wmux vs raw tmux

The agent-multiplexer space exploded in 2025–2026. Here's where vMux fits.

| | **vMux** | cmux | wmux | tmux + scripts |
|---|---|---|---|---|
| **Platform** | Windows 10/11 native | macOS only | Windows | Linux/macOS (WSL on Windows) |
| **Stack** | Electron 41 + React 19 | Swift / AppKit + libghostty | Windows-native port | Bash + shell glue |
| **Terminal backend** | node-pty + **ConPTY** | libghostty | ConPTY | native PTY |
| **Install** | NSIS installer, one click | DMG / brew | manual | package manager |
| **Auto-update** | ✅ differential (blockmap, ~few MB) | manual / brew | ❌ | n/a |
| **Multi-agent presets** | 6 built-in + custom overrides | works with any CLI | works with any CLI | manual |
| **Git worktree isolation** | ✅ per-session | ✅ per-workspace | ✅ | manual |
| **Tmux-style splits + auto-tile** | ✅ 2D / even-h / even-v / main-stack | ✅ | ✅ | ✅ (manual) |
| **Embedded localhost preview** | ✅ webview + DevTools console | ✅ scriptable browser | ❓ | ❌ |
| **Event detection** | server-ready / build / test / agent-done | OSC 9/99/777 | partial | ❌ |
| **Native OS notifications** | Windows toast + taskbar flash + custom sound | macOS Notification Center | ? | ❌ |
| **Sync-input broadcast** | ✅ `Ctrl+Shift+S` | ❌ | ❌ | ✅ |
| **Command palette** | ✅ `Ctrl+K` fuzzy search | ❌ | ❌ | ❌ |
| **i18n** | 🇬🇧🇫🇷🇩🇪🇪🇸🇨🇳🇯🇵🇹🇷 **7 languages** | English only | English only | n/a |
| **Live CPU/RAM per pane** | ✅ pidusage | ❌ | ❌ | manual |
| **CLI launcher** | `vmux new --agent claude-code --prompt "..."` | `cmux` | yes | tmux |
| **License** | MIT | MIT | MIT | ISC |

**TL;DR**
- You're on **macOS** → use [**cmux**](https://github.com/manaflow-ai/cmux). It's the original, native, and excellent.
- You're on **Linux** → raw tmux is still king for headless servers; cmux works in a VM.
- You're on **Windows** and want a polished desktop app with i18n, auto-update and an embedded preview → **vMux**.
- You're on **Windows** and want cmux socket-protocol compatibility → look at [wmux](https://github.com/amirlehmam/wmux).

vMux is **not** a port of cmux — it's a from-scratch Windows-first redesign with different defaults (Electron + React, built-in DevTools console, 7-language UI, differential auto-update). The two tools share a philosophy, not a codebase.

---

## Why vMux?

Modern AI coding agents are powerful but **hard to orchestrate**: each one wants its own terminal, its own working directory, its own branch. Running three of them in parallel without stepping on each other's toes means juggling worktrees, tmux panes, browser tabs and notifications.

On macOS, [cmux](https://github.com/manaflow-ai/cmux) already solved this elegantly. On Windows, the options were: run WSL2 (slow file I/O, broken Windows clipboard), spin up Docker (overkill), or duct-tape your own tmux config (good luck with ConPTY edge cases).

**vMux solves that in one native Windows window.** Spawn as many agent sessions as you want, each fenced inside its own git worktree, with terminal splits that auto-tile, an embedded browser for your dev server, and Windows-native push notifications when an agent needs your attention. No WSL. No Docker. No prefix keys.

<div align="center">
<img src="docs/screenshots/session-active.png" alt="Claude Code session running in vMux" width="100%"/>
<sub><i>A Claude Code agent running in its own worktree, with live CPU/memory stats and pane attention indicators.</i></sub>
</div>

---

## Features

### Multi-agent orchestration
- **6 preset agents**: Claude Code, Codex, Aider, Cursor Agent, Gemini, raw shell
- **Isolated sessions** — each agent runs inside its own dedicated git worktree, no branch collisions
- **PATH detection** with availability checking + install hints if an agent isn't found
- **Per-agent overrides** — remap commands/args/env from Settings without touching code

### Tmux-style splits + auto-tile
- `Ctrl+Shift+D` — add a pane → auto-tile in a balanced 2D grid
- `Ctrl+Shift+E` — manual vertical split
- `Ctrl+G` — re-tile current session
- `Ctrl+Shift+W` — close focused pane (session stays alive)
- `Alt+←/→/↑/↓` — navigate between panes
- **Layout presets**: tiled (2D), even-horizontal, even-vertical, main+stack
- Drag separators to resize live

### Embedded localhost preview
- **Auto-detection** of `localhost:XXXX`, `127.0.0.1:XXXX`, etc. from each pane's output (ANSI/box-drawing stripped)
- Embedded `<webview>` opens automatically when a URL is detected
- Toolbar: back / forward / reload / address bar / open external
- **Built-in DevTools console** with level filters (errors / warnings / logs), live capture, peek banner when errors occur, clear button, max 500 entries (FIFO)
- Persistent URL chips in the tab bar to re-open any detected URL

### Event detection + native notifications
- Patterns detected: `server-ready`, `build-success`, `build-error`, `test-results`, `agent-done`
- In-app toast with colored badge per kind
- **Native Windows notifications** with vMux icon when the app is in background
- **Taskbar flash** (`flashFrame`) when an agent needs an action
- **Custom notification sound** (configurable in Settings)
- Sidebar badges per session: 🚀 ready / ✓ build / ✗ error / 🌐 URL

### Auto-update from GitHub Releases
- Update check via GitHub Releases API on launch and every 4 hours (8s timeout, no hangs)
- **Differential download via blockmap** — only changed bytes (~few MB instead of 100 MB)
- One-click in-app install: download → install silently → app restarts itself
- Manual install fallback via integrated download (no browser opened)
- 7-language status messages

### Internationalization (7 languages)
- 🇬🇧 English (default) · 🇫🇷 Français · 🇩🇪 Deutsch · 🇪🇸 Español · 🇨🇳 中文 · 🇯🇵 日本語 · 🇹🇷 Türkçe
- Custom lightweight i18n system, switch live from **Settings → Appearance → Language**
- Fallback to English when a key is missing in a translation

### CLI: launch sessions from any terminal
The NSIS installer adds vMux to your `PATH` automatically:

```bash
vmux                                              # focus the running window
vmux new --agent claude-code --prompt "fix bug"   # spawn a new session
vmux new -a codex -d "C:\repos\my-app" -p "tests"
vmux help                                         # full reference
```

### Pro features
- **Command palette** `Ctrl+K` — fuzzy search over sessions, panes, actions, URLs, agents
- **Sync input** `Ctrl+Shift+S` — broadcast keystrokes to every terminal in the session (red border)
- **Drag & drop** a folder onto the window → opens the new-session dialog with the cwd pre-filled
- **Live process monitoring** — CPU % and memory (MB) per pane, plus PID, displayed in the status bar
- **Session rename** (double-click) and pane rename (right-click → Rename)
- **Pinning + grouping** — sessions are auto-grouped into Pinned / Active / Idle in the sidebar
- **Restart all idle panes** in a session in one click
- **Sidebar with filter** + agent avatars + last-event badges + custom session colors
- **Settings**: theme, font, size, scrollback, copy-on-selection, paste-on-right-click, WebGL, agent overrides, notification sound, preview behavior
- **Persistence**: sessions, layouts, window position, sidebar width survive restarts (cap 100 sessions)
- **ErrorBoundary** scoped per pane — a crashed pane never kills the whole app
- **Crash recovery** — graceful-shutdown flag detects unclean exits
- **Single-instance lock** — second `vmux.exe` invocations focus the existing window

### Terminal (xterm.js)
- WebGL renderer by default (5× faster on streaming output)
- `Ctrl+Shift+F` in-pane search
- Unicode 11 (full emoji support)
- Copy-on-selection + paste-on-right-click
- ConPTY native Windows terminal via `node-pty`
- Bracketed paste mode preserved

---

## Stack

| Layer | Tech |
|---|---|
| Shell | Electron 41 (Chromium + Node 22) |
| UI | React 19 + TypeScript 6 |
| Bundler | electron-vite 5 + Vite 7 (HMR) |
| PTY | node-pty 1.1 + ConPTY (Windows native) |
| Terminal | xterm.js 6 + addons (fit / web-links / search / unicode11 / webgl) |
| State | Zustand 5 |
| Persistence | electron-store 8 |
| Auto-update | electron-updater 6 + GitHub API fallback |
| Process monitoring | pidusage + pidtree |
| Logs | electron-log (`%APPDATA%\vMux\logs\`) |
| Icons | lucide-react |
| Tests | Vitest 4 |

---

## Requirements

- **Windows 10** (build 1809+) or **Windows 11**
- **Node.js 22 LTS** (for development only)
- **Git** in PATH (worktree management)
- **PowerShell 7** recommended (Windows PowerShell 5.1 also works)
- At least one agent installed in PATH for productive use (`claude`, `codex`, `aider`, `cursor-agent`, `gemini`)

---

## Installation

### For end-users

Download the latest installer from [Releases](https://github.com/vk1356/vmux/releases/latest):

- **`vMux-Setup-x.y.z-x64.exe`** — NSIS installer (creates desktop & start menu shortcuts, adds `vmux` to PATH, enables auto-update)
- **`vMux-Portable-x.y.z-x64.exe`** — standalone executable, no install required

After install, all future updates happen in-app automatically: **Settings → Updates → Check now → Download → Install and restart**.

### For developers

```bash
git clone https://github.com/vk1356/vmux.git
cd vmux
npm install
npm run dev    # opens with HMR (renderer on port 5183)
```

> If `node-pty` fails to compile (Python 3.12 distutils issue), the `node-gyp@^12` override in `package.json` handles it. **No Python build tools required** — the prebuilt NAPI binary works with Electron.

---

## Scripts

```bash
npm run dev          # dev server with HMR
npm run build        # bundle out/
npm run package      # NSIS installer + portable in release/
npm run release      # build + publish to GitHub Releases (needs GH_TOKEN)
npm run typecheck    # tsc --noEmit on main + preload + renderer
npm run test         # vitest run (46 tests on tree, layouts, url-detector, event-detector)
npm run icon         # regenerate build/icon.ico from build/icon.svg
```

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New session |
| `Ctrl+K` | Command palette |
| `Ctrl+,` | Settings |
| `Ctrl+W` | Close active session |
| `Ctrl+Shift+D` | Add a pane (auto-tile) |
| `Ctrl+Shift+E` | Manual vertical split |
| `Ctrl+Shift+W` | Close focused pane |
| `Ctrl+Shift+S` | Toggle sync-input on session |
| `Ctrl+Shift+F` | Search inside terminal |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+G` | Re-tile session |
| `Ctrl+1..9` | Switch to Nth session |
| `Alt+←/→/↑/↓` | Navigate between panes |
| `Esc` | Close dialog / palette |

---

## Architecture

```
src/
├── main/                      # Electron main process (Node)
│   ├── index.ts                     # Window, lifecycle, single-instance, auto-updater, CLI dispatch
│   ├── ipc.ts                       # ~35 IPC channels (session/pane/git/dialog/clipboard/notif/updater)
│   ├── pty-manager.ts               # Sessions + panes + per-pane PTY (ConPTY)
│   ├── pty-stats.ts                 # Live CPU/RAM monitoring via pidusage
│   ├── url-detector.ts              # Localhost URL regex (ANSI/box-drawing stripped)
│   ├── event-detector.ts            # Event regex + 2s dedup window
│   ├── worktree-manager.ts          # git worktree add/remove
│   ├── agent-check.ts               # where.exe + 30s cache
│   ├── settings-store.ts            # electron-store wrapper + session migration
│   ├── shell.ts                     # Detect pwsh / Windows PowerShell / cmd / bash
│   └── cli-args.ts                  # `vmux new --agent X` argument parser
├── preload/                   # Context-isolated bridge
│   └── index.ts                     # window.cmux typed API
├── shared/                    # Pure types + utils (testable)
│   ├── types.ts                     # Pane, PaneTree, Session, IPC channels, Lang, UpdateStatus
│   ├── tree.ts                      # splitAt, removePane, neighbors, paths
│   ├── layouts.ts                   # tiled (2D), even-h, even-v, main-stack
│   └── agents.ts                    # Agent presets + resolver (with overrides)
└── renderer/                  # React 19 UI
    └── src/
        ├── App.tsx
        ├── i18n/index.ts                # 7-language catalog + useT/useLocale hooks
        ├── components/
        │   ├── TitleBar.tsx              # Custom frameless window controls
        │   ├── Sidebar.tsx               # Sessions grouped (Pinned/Active/Idle), avatars, search
        │   ├── TabBar.tsx                # Panes of active session + context menu
        │   ├── PaneTreeView.tsx          # Recursive tree rendering with drag handles
        │   ├── TerminalPane.tsx          # xterm.js + WebGL + addons, restart overlay
        │   ├── PreviewPane.tsx           # <webview> + integrated DevTools console panel
        │   ├── NewSessionDialog.tsx
        │   ├── SettingsDialog.tsx        # 6 tabs: Appearance / Terminal / Notifs / Agents / Updates / Advanced
        │   ├── CommandPalette.tsx        # Ctrl+K fuzzy search
        │   ├── UpdateBanner.tsx          # Top banner with download progress + install button
        │   ├── UrlChips.tsx              # Detected URLs in tab-bar
        │   ├── Toast.tsx                 # In-app notifications
        │   ├── ErrorBoundary.tsx         # Scoped: app vs pane
        │   └── EmptyState.tsx            # Hero with feature cards
        ├── store/
        │   └── sessions.ts               # Zustand store (sessions, attention, stats, toasts)
        └── styles/
            └── global.css
```

---

## Customizing agents

Edit `src/shared/agents.ts`, or use **Settings → Agents** to override the command/args without touching code:

```ts
{
  id: 'my-agent',
  label: 'My Agent',
  description: 'Short description',
  command: 'my-agent-cli',
  args: ['--mode', 'interactive'],
  env: { CUSTOM_VAR: 'value' },
  color: '#a855f7',
  installUrl: 'https://example.com/install'
}
```

User overrides are merged at spawn time — you can remap `claude` → `claude-dev`, inject env vars, etc.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Agent doesn't launch | Check it's in PATH with `where.exe <command>`. Settings → Agents lists detected agents. |
| `node-pty` crash on launch | `npm run rebuild:native` (recompiles against Electron). |
| Preview blank / error | Verify your dev server is running on the displayed URL. The toolbar has a reload button. |
| Update check stays on "Checking…" | The check has an 8s hard timeout. If it persists, check `%APPDATA%\vMux\logs\main.log`. |
| TUI looks garbled on narrow split | The agent's bootLine waits for the renderer's first resize; press `Ctrl+L` to repaint manually. |
| `vmux` command not found | Open a **new** terminal after install (PATH only updates for new sessions). |

---

## Releasing a new version

```bash
# 1. Bump version in package.json
# 2. Commit + push
git add package.json
git commit -m "chore: bump 0.x.y → 0.x.z"
git push origin main

# 3. Build + publish (uses gh auth token)
export GH_TOKEN=$(gh auth token)
npm run release
```

The release script builds the NSIS installer + portable, signs them, generates the differential blockmap, and uploads everything to GitHub Releases as a new tag. Existing users will see the update banner on next launch.

---

## License

MIT — © [Vural Kutun](mailto:xlazvek@gmail.com)

---

<div align="center">

**If vMux makes you faster, star the repo ⭐ — it's the easiest way to keep this project alive.**

<sub>Made with ⚡ on Windows, for developers who run multiple AI agents at once.</sub>

</div>
