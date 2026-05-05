# vMux — Windows edition

> Orchestrateur multi-agents IA pour Windows. Lance Claude Code, Codex, Aider, Cursor Agent et Gemini en parallèle, chacun isolé dans son propre **git worktree**, avec des terminaux **ConPTY** natifs, du **split tmux-style**, un **preview localhost embarqué** et de la **détection d'événements** automatique.

## Fonctionnalités

### Orchestration multi-agents
- **Sessions** isolées : chaque agent IA tourne dans son propre git worktree
- 6 agents preset : Claude Code, Codex, Cursor Agent, Aider, Gemini, shell brut
- Détection automatique de la présence d'un agent dans le PATH
- Override des commandes/args par agent dans les Settings

### Splits tmux-style + auto-tile
- **Ctrl+Shift+D** : ajouter un pane → auto-tile en grid 2D équilibré
- **Ctrl+Shift+E** : split vertical manuel
- **Ctrl+G** : re-tiler la session
- **Ctrl+Shift+W** : fermer le pane focusé (la session reste)
- **Alt+←/→/↑/↓** : naviguer entre panes
- Layouts presets : tiled (2D), even-horizontal, even-vertical, main+stack
- Drag des séparateurs pour redimensionner

### Preview localhost embarqué
- Détection automatique des URLs `localhost:XXXX`, `127.0.0.1:XXXX`, etc. dans la sortie de chaque pane
- **Ouverture auto** du preview embarqué (`<webview>`) dès qu'une URL est détectée
- Toolbar : back / forward / reload / address bar / open external
- **Chips persistants** dans la tab bar pour ré-ouvrir n'importe quelle URL détectée
- Auto-suivi des nouvelles URLs

### Détection d'événements + notifications
- Patterns détectés : `server-ready`, `build-success`, `build-error`, `test-results`, `agent-done`
- **Toast** in-app avec badge de couleur
- **Notification système Windows** quand vMux est en arrière-plan
- Badges dans la sidebar : 🚀 ready / ✓ build / ✗ error / 🌐 URL

### Pro features
- **Command palette Ctrl+K** : fuzzy search sur sessions, panes, actions, URLs, agents
- **Pane sync input** Ctrl+Shift+S : broadcast à tous les terminaux de la session (bord rouge)
- **Renommage** sessions (double-click) et panes (right-click → Rename)
- **Restart all** sur les sessions avec panes inactifs
- **Sidebar** avec filtre + agent avatars + badges last-event
- **Settings** : font, taille, scrollback, copy-on-selection, paste-on-right-click, WebGL, agent overrides
- **Persistance** : sessions, layouts, position fenêtre, taille sidebar
- **ErrorBoundary** scopée par pane (un pane crashé ne tue pas l'app)
- **Migration** des sessions persistées (formats anciens nettoyés)

### Terminal (xterm.js)
- Renderer **WebGL** par défaut (5x plus rapide sur les flux d'output)
- **Search** Ctrl+Shift+F dans le pane
- Unicode 11 (emoji)
- **Copy-on-selection** + **paste-on-right-click**
- Theme orange/zinc cohérent

## Stack

- **Electron 41** (Chromium + Node 22)
- **React 19** + TypeScript 6
- **electron-vite 5** + Vite 7 (HMR)
- **node-pty 1.1** + ConPTY (Windows native)
- **xterm.js 5.5** + addons fit / web-links / search / unicode11 / webgl
- **Zustand 5** (state)
- **electron-store 8** (persistance settings + sessions + layouts)
- **electron-log** (logs persistés `%APPDATA%/vmux/logs/`)
- **lucide-react** (icônes)
- **Vitest 4** (tests utils purs)

## Prérequis

- **Windows 10 (build 1809+) ou Windows 11**
- **Node.js 22 LTS** (minimum)
- **Git** dans le PATH (gestion des worktrees)
- **PowerShell 7** recommandé (sinon Windows PowerShell 5.1 fonctionne)
- Au moins un agent installé dans le PATH (`claude`, `codex`, `aider`, `cursor-agent`, `gemini`)

## Installation

```powershell
npm install
```

> Si `node-pty` échoue à compiler (Python 3.12 distutils manquant) : l'override `node-gyp@12` dans `package.json` règle ça automatiquement. Pas de Python build tools requis.

## Développement

```powershell
npm run dev
```

L'app s'ouvre avec HMR sur le renderer (port **5183** — choisi pour ne pas collider avec les dev servers usuels).

## Tests

```powershell
npm run test         # vitest run (46 tests sur tree, layouts, url-detector, event-detector)
npm run test:watch   # mode watch
```

## Typecheck

```powershell
npm run typecheck    # vérifie main + preload + renderer
```

## Build production

```powershell
npm run build         # bundle out/
npm run package       # NSIS installer + portable dans release/
```

Artefacts générés :
- `release/vMux-0.1.0-x64.exe` — installeur NSIS (raccourcis bureau / menu démarrer)
- `release/vMux-0.1.0-x64-portable.exe` — version portable

## Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `Ctrl+N` | Nouvelle session |
| `Ctrl+K` | Command palette |
| `Ctrl+,` | Paramètres |
| `Ctrl+W` | Fermer la session active |
| `Ctrl+Shift+D` | Ajouter un pane (auto-tile) |
| `Ctrl+Shift+E` | Split vertical manuel |
| `Ctrl+Shift+W` | Fermer le pane focusé |
| `Ctrl+Shift+S` | Toggle sync input session |
| `Ctrl+Shift+F` | Recherche dans le terminal |
| `Ctrl+G` | Re-tiler la session |
| `Alt+←/→/↑/↓` | Naviguer entre panes |
| `Esc` | Fermer dialog / palette |

## Architecture

```
src/
├── main/                    # Process Node (Electron main)
│   ├── index.ts                   # Window, lifecycle, electron-log
│   ├── ipc.ts                     # Handlers IPC (~30 channels)
│   ├── pty-manager.ts             # Sessions + Panes + PTY (per-pane)
│   ├── url-detector.ts            # Regex localhost (strip ANSI/box-drawing)
│   ├── event-detector.ts          # Regex events + dedup window 2s
│   ├── worktree-manager.ts        # git worktree add/remove
│   ├── agent-check.ts             # where.exe + cache 30s
│   ├── settings-store.ts          # electron-store + migration sessions
│   └── shell.ts                   # Détection pwsh / Windows PowerShell
├── preload/                 # Bridge contextIsolated
│   └── index.ts                   # window.cmux API typée
├── shared/                  # Types + utils purs (testables)
│   ├── types.ts                   # Pane, PaneTree, Session, IPC channels
│   ├── tree.ts                    # splitAt, removePane, neighbors, paths
│   ├── layouts.ts                 # tiled (2D), even-h, even-v, main-stack
│   └── agents.ts                  # Presets + resolveAgent (overrides)
└── renderer/                # UI React 19
    └── src/
        ├── App.tsx
        ├── components/
        │   ├── TitleBar.tsx           # Custom frameless
        │   ├── Sidebar.tsx            # Sessions + filter + avatars
        │   ├── TabBar.tsx             # Panes de la session active + menu
        │   ├── PaneTreeView.tsx       # Rendu récursif de l'arbre
        │   ├── TerminalPane.tsx       # xterm.js + WebGL + addons
        │   ├── PreviewPane.tsx        # <webview> + toolbar
        │   ├── NewSessionDialog.tsx
        │   ├── SettingsDialog.tsx
        │   ├── CommandPalette.tsx     # Ctrl+K fuzzy search
        │   ├── UrlChips.tsx           # URLs détectées dans tab-bar
        │   ├── Toast.tsx              # Notifications in-app
        │   ├── ErrorBoundary.tsx      # Scopée: app vs pane
        │   └── EmptyState.tsx
        ├── store/
        │   └── sessions.ts        # Zustand store
        └── styles/
            └── global.css
```

## Personnaliser les agents

Édite [`src/shared/agents.ts`](src/shared/agents.ts) ou utilise **Settings** (Ctrl+,) → onglet **Agents** pour overrider la commande/args sans toucher au code :

```ts
{
  id: 'mon-agent',
  label: 'Mon Agent',
  description: 'Description courte',
  command: 'mon-agent-cli',
  args: ['--mode', 'interactive'],
  color: '#a855f7',
  installUrl: 'https://...'
}
```

Les overrides utilisateur sont mergés au spawn — l'utilisateur peut remapper `claude` → `claude-dev`, ajouter des env vars, etc.

## Dépannage

- **L'agent ne se lance pas** : vérifie qu'il est dans le PATH avec `where.exe <command>`. Le Settings dialog liste les agents trouvés.
- **node-pty crash au lancement** : `npm run rebuild:native` (recompile contre Electron).
- **Preview vide / erreur** : vérifie que ton dev server tourne sur l'URL affichée. La toolbar permet de réessayer.
- **TUI baveuse au split étroit** : le bootLine de l'agent attend le 1er resize du renderer ; en cas de doute, fais un Ctrl+L manuel.

## Licence

MIT — © Vural Kutun
