import { useEffect, useState } from 'react';
import type { Lang } from '@shared/types';
import { useSessionStore } from '../store/sessions';

/** Catalogue des chaînes traduites. EN est la source de vérité — les autres
 *  langues peuvent omettre des clés, on retombe alors sur EN. */
export type TKey = keyof typeof EN;

const EN = {
  // App / window
  appTagline: 'AI multi-agent orchestrator',

  // Hero / EmptyState
  heroTitleA: 'Multiple AI agents,',
  heroTitleB: 'one window.',
  heroLead:
    "vMux orchestrates Claude Code, Codex, Aider and more in parallel — each in its own git worktree. No branch collisions, just agents working in silence.",
  heroCta: 'New session',
  heroCtaHint: 'or press',
  heroFeatureSplitsTitle: 'Tmux-style splits',
  heroFeatureSplitsBody:
    'Split horizontally, vertically, or auto-tile in a 2D grid — one shortcut.',
  heroFeaturePreviewTitle: 'Localhost preview',
  heroFeaturePreviewBody:
    'URL detected → embedded preview inside the window, no flow break.',
  heroFeatureWorktreesTitle: 'Git worktrees',
  heroFeatureWorktreesBody:
    'Each agent in its own worktree — isolated branches, zero collisions.',
  heroFeatureMultiAgentTitle: 'Multi-agent',
  heroFeatureMultiAgentBody:
    'Claude Code, Codex, Aider, Cursor, Gemini — all from the same window.',
  heroFeatureNotifsTitle: 'Native notifications',
  heroFeatureNotifsBody:
    'Windows push + taskbar flash when an agent needs attention in the background.',
  heroFeaturePtyTitle: 'Native ConPTY',
  heroFeaturePtyBody:
    'Native Windows terminal via node-pty — performance and shell compatibility.',
  shortcutNewSession: 'New session',
  shortcutAddPane: 'Add pane',
  shortcutRetile: 'Retile',
  shortcutPalette: 'Palette',
  shortcutSettings: 'Settings',

  // Settings dialog
  settingsTitle: 'Settings',
  settingsClose: 'Close',
  settingsSavingHint: 'Saving…',
  settingsLiveHint: 'Changes applied live.',
  tabAppearance: 'Appearance',
  tabTerminal: 'Terminal',
  tabNotifications: 'Notifications',
  tabAgents: 'Agents',
  tabUpdates: 'Updates',
  tabAdvanced: 'Advanced',

  // Settings → Appearance
  fieldLanguage: 'Language',
  fieldTheme: 'Theme',
  themeDark: 'Dark',
  themeLight: 'Light (coming)',
  themeSystem: 'System',
  themeLightHint: "Light mode isn't styled yet — stay on dark.",
  fieldFont: 'Font',
  fieldFontSize: 'Font size',
  fieldCursorBlink: 'Blinking cursor',

  // Settings → Terminal
  fieldShell: 'Default shell',
  fieldShellHint: 'Used for new shell panes. Agent sessions keep their own command.',
  fieldScrollback: 'Scrollback',
  scrollbackUnit: 'lines',
  fieldCopyOnSelect: 'Copy selection automatically',
  fieldPasteRightClick: 'Paste on right-click',
  fieldWebgl: 'WebGL renderer (perf++)',
  fieldWebglHint: 'restart the app to apply',

  // Settings → Notifications
  fieldNotifs: 'Windows system notifications',
  fieldNotifsHint:
    'Receive a push notification (with vMux icon) when an agent needs an action or an event (build, server, tests) is detected in the background.',
  sectionPreviewLocalhost: 'Localhost preview',
  fieldPreviewToast: 'Show a toast when a localhost URL is detected',
  fieldPreviewAutoOpen: 'Open the embedded preview automatically',
  fieldPreviewSplit: 'Preview split size',
  fieldPreviewSplitHint:
    'Percentage taken by the terminal vs the preview when opening a preview.',

  // Settings → Agents
  agentsHint:
    'Overrides are saved but not yet applied to spawn (coming).',
  agentNotInstalled: 'not installed',

  // Settings → Updates
  fieldInstalledVersion: 'Installed version',
  fieldStatus: 'Status',
  updateCheck: 'Check now',
  updateDownload: 'Download v',
  updateInstall: 'Install and restart',
  updateAutoHint:
    'vMux automatically checks for new versions at startup and every 4 hours. Updates are published on GitHub Releases.',
  updateSeeAll: 'See all versions',
  updateNoCheck: 'No recent check.',
  updateChecking: 'Checking…',
  updateUpToDate: 'Up to date',
  updateAvailable: 'New version available',
  updateDownloading: 'Downloading',
  updateReady: 'Update ready to install',
  updateError: 'Error',
  errInstallNoDownload:
    'Download not completed yet — re-run download or install manually from the website.',
  errNoInstallerUrl: 'Installer URL not found in the latest release.',
  errGithubApiFailed: 'GitHub API call failed. Check your connection.',
  errNoResponse: 'No response from update server. Check your internet connection.',
  errDevMode: 'Available only in the installed app, not in dev mode.',

  // Settings → Advanced
  fieldDiagnostic: 'Diagnostic',
  diagnosticBtn: 'Export diagnostic (.json)',
  diagnosticHint:
    'Generates a report (versions, agents, sessions, recent logs) to attach to bug reports. Agent overrides are anonymized.',
  fieldSource: 'Source',
  sourceBtn: 'Open GitHub repo',

  // Update banner
  bannerAvailable: 'Update available',
  bannerAvailableBody: 'Version {version} is ready to download.',
  bannerDownloading: 'Downloading… {pct}%',
  bannerReady: 'Update ready',
  bannerReadyBody: 'Version {version} — restart to install.',
  bannerError: 'Update failed',
  bannerLater: 'Later',
  bannerDownloadBtn: 'Download',
  bannerInstallBtn: 'Install and restart',

  // StatusBar
  statusActive: 'active',
  statusAttentionCount:
    '{n} session(s) need attention — click to switch',

  // Sidebar
  sidebarTitle: 'Sessions',
  sidebarFilter: 'Filter…',
  sidebarEmptyTitle: 'No session yet',
  sidebarEmptyBody: 'Create one to launch an AI agent in its own worktree.',
  sidebarEmptyCta: 'New session',
  sidebarNoResults: 'No results',
  sidebarNoResultsBody: 'No session matches "{q}".',

  // Sidebar groups
  groupPinned: 'Pinned',
  groupActive: 'Active',
  groupIdle: 'Idle',
  agentsActive: '{n} agents active',
  agentActive: '{n} agent active',
  noAgentActive: 'No agent active',

  // Sidebar actions
  actionSettings: 'Settings (Ctrl+,)',
  actionNewSession: 'New session (Ctrl+N)',
  actionPin: 'Pin',
  actionUnpin: 'Unpin',
  actionRestartIdle: 'Restart idle panes',
  actionCloseSession: 'Close session',
  actionRenameHint: 'Double-click to rename',
  actionClearFilter: 'Clear',
  actionResetColor: 'Reset color',

  // Session item misc
  pinnedLabel: 'Pinned',
  attentionNeedsInputLabel: 'Needs an action',
  attentionAlertLabel: 'Agent done / alert',
  attentionActivityLabel: 'Activity',
  agentStateIdle: 'Idle',
  agentStateThinking: 'Thinking',
  agentStateGenerating: 'Generating',
  agentStateNeedsInput: 'Need input',
  urlDetectedLabel: 'Localhost URL detected',
  avatarHint: '{agent} — right-click to change color',

  // Footer stats
  footerSessions: 'sessions',
  footerActives: 'active',
  footerPinned: 'pinned',

  // TitleBar
  windowMinimize: 'Minimize',
  windowMaximize: 'Maximize',
  windowRestore: 'Restore',
  windowClose: 'Close',

  // NewSessionDialog
  newSessionTitle: 'New session',
  newSessionAgent: 'Agent',
  newSessionCwd: 'Working directory',
  newSessionCwdPick: 'Pick a folder…',
  newSessionName: 'Session name',
  newSessionWorktree: 'Create a new worktree',
  newSessionBranch: 'New branch',
  newSessionBaseBranch: 'Base branch',
  newSessionInitialPrompt: 'Initial prompt (optional)',
  newSessionInitialPromptPlaceholder: 'What the agent should do first',
  newSessionCreate: 'Create session',
  newSessionCancel: 'Cancel',
  newSessionAgentNotInstalled: 'Not detected in PATH',

  // PreviewPane
  previewBack: 'Back',
  previewForward: 'Forward',
  previewReload: 'Reload',
  previewOpenExternal: 'Open in browser',
  previewClose: 'Close preview',
  previewConsoleShow: 'Show console',
  previewConsoleHide: 'Hide console',
  previewConsoleClear: 'Clear console',
  previewConsoleEmpty:
    'No console message yet. Load the page to see logs.',
  previewConsoleEmptyFiltered: 'No message in this filter.',
  previewLoadFailed: 'Failed to load {url}',
  previewLoadFailedHint: "The server may not be ready yet. Retry in a few seconds.",

  // TerminalPane
  searchPrev: 'Previous (Shift+Enter)',
  searchNext: 'Next (Enter)',
  paneIdle: 'Pane idle',
  paneExited: 'Pane exited (code {code})',
  paneError: 'Error (code {code})',
  paneIdleHint: "PTY doesn't survive restarts — relaunch to resume.",
  paneExitedHint: 'Click to relaunch this pane with the same parameters.',
  paneRestart: 'Restart',
  paneStarting: 'Starting…',

  // PaneHeader (header strip above each pane)
  paneCloseTitle: 'Close this pane',
  paneCloseAria: 'Close pane',
  paneDetachWindowLabel: 'Detach',
  paneDetachWindowTitle: 'Pop this session into its own window (multi-screen / Alt+Tab)',
  paneDetachWindowAria: 'Detach session into a new window',
  paneStartedAgo: 'Started {uptime} ago',
  paneStaleHint: 'No recent output — agent may be idle',
  paneTypingTitle: 'Agent typing…',
  paneTypingAria: 'Agent typing',

  // NotificationCenter
  notificationsTitle: 'Notifications',
  notificationsEmpty: 'No event yet',
  notificationsClear: 'Clear all',
  notificationsMarkRead: 'Mark all as read',

  // CommandPalette
  paletteTitle: 'Command palette',
  palettePlaceholder: 'Type a command…',
  paletteNoResults: 'No results for "{q}"',
  cmdNewSession: 'New session',
  cmdSettings: 'Settings',
  cmdShortcuts: 'Keyboard shortcuts',
  cmdToggleSidebar: 'Toggle sidebar',
  cmdSplitHorizontal: 'Split pane horizontally',
  cmdSplitVertical: 'Split pane vertically',
  cmdRetile: 'Auto-tile panes',
  cmdRestartIdleAll: 'Restart all idle panes',
  cmdNotifications: 'Open notifications',
  cmdSnippets: 'Open snippets',
  cmdDiagnostic: 'Export diagnostic',
  cmdCheckUpdate: 'Check for updates',

  // SnippetsPicker
  snippetsTitle: 'Snippets',
  snippetsEmpty: 'No snippet',
  snippetsTagsPlaceholder: 'tags (comma-separated)',
  snippetsEmptyHint: 'Create one with the {plus} button.',
  snippetsEdit: 'Edit',
  snippetsInsertHint: 'insert',
  snippetsDelete: 'Delete',
  snippetsName: 'Name',
  snippetsContent: 'Content',
  snippetsSave: 'Save',
  snippetsCancel: 'Cancel',
  snippetsNew: 'New snippet',

  // ShortcutsOverlay
  shortcutsTitle: 'Keyboard shortcuts',
  shortcutsClose: 'Close',
  shortcutsCloseHint: '{q} or {esc} to close',
  shortcutsGroupSessions: 'Sessions',
  shortcutsGroupPanes: 'Panes',
  shortcutsGroupTerminal: 'Terminal',
  shortcutsGroupShellEdit: 'Shell editing (PSReadLine)',
  shortcutsItemNewSession: 'New session',
  shortcutsItemCloseSession: 'Close active session',
  shortcutsItemPalette: 'Command palette',
  shortcutsItemSettings: 'Settings',
  shortcutsItemAddPane: 'Add pane (auto-tile)',
  shortcutsItemSplitVertical: 'Manual vertical split',
  shortcutsItemClosePane: 'Close focused pane',
  shortcutsItemRetile: 'Retile session',
  shortcutsItemNavigatePanes: 'Navigate between panes',
  shortcutsItemSyncInput: 'Toggle sync input (broadcast)',
  shortcutsItemSearchPane: 'Search inside pane',
  shortcutsItemDragFile: 'Drop a file',
  shortcutsItemInsertPath: 'Inserts the file path',
  shortcutsItemPasteButton: '📋 button',
  shortcutsItemPasteHint: 'Paste image or clipboard text',
  shortcutsItemHomeKey: 'Beginning of line',
  shortcutsItemEndKey: 'End of line',
  shortcutsItemDeleteWord: 'Delete previous word',
  shortcutsItemDeleteHome: 'Delete to beginning',
  shortcutsItemDeleteEnd: 'Delete to end',
  shortcutsItemHistory: 'Command history',

  // CommandPalette extra labels
  cmdGroupSessions: 'Sessions',
  cmdGroupPanes: 'Panes',
  cmdGroupSnippets: 'Snippets',
  cmdGroupAgents: 'Agents',
  cmdGroupOther: 'Other',
  cmdGroupUrls: 'Detected URLs',
  cmdLaunchAgent: 'Launch session with {agent}',

  // ErrorBoundary
  errPaneCrashed: '{label} crashed',
  errAppCrashed: 'vMux encountered an error',
  errRetry: 'Retry',

  // Toast
  toastOpenPreview: 'Open preview',
  toastInBrowser: 'In browser',
  toastClose: 'Close',

  // NotificationCenter time + filter
  notifFilterAll: 'All',
  notifFilterReady: '🚀 Ready',
  notifFilterBuild: '✓ Build',
  notifFilterErrors: '✗ Errors',
  notifFilterTests: '🧪 Tests',
  notifEmptyHint: 'Detected events (server ready, build, tests…) will appear here.',
  notifKindServerReady: 'Server ready',
  notifKindBuildSuccess: 'Build successful',
  notifKindBuildError: 'Build error',
  notifKindTests: 'Tests',
  notifKindAgentDone: 'Agent done',
  notifKindNotify: 'Notification',

  // ComposeDialog
  composeSendTo: 'Send to',
  composePlaceholder:
    "Type your message — edit, delete, copy/paste freely.\nCtrl+Enter to send.",
  composeSendHint: 'send',
  composeCancelHint: 'cancel',

  // NewSessionDialog gaps
  newSessionFailedToCreate: 'Failed to create session.',
  newSessionAgentNotDetectedTip: 'Not detected in PATH',
  newSessionRepoDetected: 'Git repo detected · current branch:',
  newSessionUncommitted: 'uncommitted changes',
  newSessionNotARepo: 'Not a Git repo — the session will start in this folder without a worktree.',
  newSessionCreateWorktreeFull: 'Create a new git worktree to isolate this agent',
  newSessionInitialPromptHint: 'Sent as stdin right after the agent starts.',
  newSessionCreating: 'Creating…',
  newSessionLaunch: 'Launch session',

  // Search overlay (TerminalPane)
  searchClose: 'Close (Esc)',

  // Settings — new fields (notification sound + auto-launch)
  fieldNotifSound: 'Notification sound',
  fieldNotifSoundHint: 'Sound played when a Windows notification is shown.',
  notifSoundDefault: 'Default Windows sound',
  notifSoundSilent: 'Silent (no sound)',
  notifSoundCustom: 'Custom file…',
  notifSoundPick: 'Pick a sound file (.wav/.mp3)',
  notifSoundCurrent: 'Current:',
  notifSoundClear: 'Reset',
  fieldAutoLaunch: 'Launch vMux at Windows startup',
  fieldAutoLaunchHint:
    'vMux starts minimized when you log in. Only available in the installed app, not in dev mode.',
  fieldAutoLaunchDevDisabled: 'Disabled in dev mode (path is not the installed exe).',

  // Common labels (placeholders, etc.)
  agentCommandPlaceholder: 'command',
  agentArgsPlaceholder: 'space-separated arguments',

  // Agent descriptions (per agent id, used in NewSessionDialog cards)
  'agentDesc.claude-code': 'Official Anthropic CLI — Claude coding agent',
  'agentDesc.codex': 'OpenAI Codex CLI',
  'agentDesc.cursor-agent': 'Cursor CLI agent',
  'agentDesc.aider': 'AI pair programmer in your CLI',
  'agentDesc.gemini': 'Google Gemini CLI',
  'agentDesc.shell': 'Raw PowerShell, no agent',

  // Onboarding (first-launch tutorial)
  fieldReplayTutorial: 'Tutorial',
  replayTutorialBtn: 'Replay onboarding',
  replayTutorialHint: 'Re-runs the first-launch tour. The window reloads.',
  onboardingSkip: 'Skip',
  onboardingNext: 'Next',
  onboardingPrev: 'Back',
  onboardingFinish: 'Get started',
  onboardingStepCount: 'Step {current} of {total}',
  onboardingWelcomeTitle: 'Welcome to vMux',
  onboardingWelcomeBody:
    "Run multiple AI coding agents side by side, each in its own git worktree. Two minutes — let's tour the basics.",
  onboardingAgentsTitle: 'Pick your agents',
  onboardingAgentsBody:
    'Claude Code, Codex, Cursor CLI, Aider, Gemini, or plain PowerShell. Each new session spawns one agent in an isolated workspace. Press Ctrl+N to start.',
  onboardingSplitsTitle: 'Split panes anywhere',
  onboardingSplitsBody:
    'Ctrl+Shift+D adds a pane and auto-tiles. Ctrl+Shift+E splits manually. Alt+arrows jump between panes. You can have a 2D grid of agents in one window.',
  onboardingPreviewTitle: 'Localhost preview, free',
  onboardingPreviewBody:
    'When an agent starts a dev server, vMux detects the URL and opens an embedded preview pane next to the terminal. No alt-tabbing.',
  onboardingShortcutsTitle: 'Discover shortcuts anytime',
  onboardingShortcutsBody:
    "Press ? to see all shortcuts. Ctrl+K opens the command palette. Ctrl+, opens settings. You're set — happy hacking.",

  // Workspace persistence (Settings → Advanced)
  fieldAutoRestore: 'Restore sessions on startup',
  fieldAutoRestoreHint:
    'When enabled, vMux relaunches the PTY of each open session on startup, and restores the last active session.',

  // MCP manager
  mcpTitle: 'MCP servers',
  mcpHint:
    'Configure Model Context Protocol servers used by Claude Code. Changes are saved to your user config.',
  mcpEmpty: 'No MCP server configured',
  mcpEmptyHint: 'Add a server to extend Claude Code with new tools.',
  mcpAdd: 'Add server',
  mcpAddTitle: 'Add an MCP server',
  mcpEditTitle: 'Edit MCP server',
  mcpEdit: 'Edit',
  mcpRemove: 'Remove',
  mcpToggleEnable: 'Enable',
  mcpToggleDisable: 'Disable',
  mcpDisabledLabel: 'Disabled',
  mcpFieldName: 'Name',
  mcpFieldType: 'Type',
  mcpFieldCommand: 'Command',
  mcpFieldArgs: 'Arguments',
  mcpFieldArgsHint: 'Space-separated. Use the Claude CLI for arguments containing spaces.',
  mcpFieldEnv: 'Environment variables',
  mcpFieldEnvHint: 'One per line, format KEY=value.',
  mcpFieldUrl: 'URL',
  mcpTypeStdio: 'Local process (stdio)',
  mcpTypeHttp: 'Remote (HTTP)',
  mcpTypeSse: 'Remote (SSE)',
  mcpSave: 'Save',
  mcpCancel: 'Cancel',
  mcpConfigPathLabel: 'Config:',
  mcpFooterHint: 'Restart your agents to pick up the changes.',
  cmdMcpServers: 'Manage MCP servers'
} as const;


export const LANG_LABELS: Record<Lang, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
  ja: '日本語',
  tr: 'Türkçe'
};

/** Lazy-loaded catalog. EN est inline (fallback toujours dispo, ~25KB).
 *  Les autres langues sont des chunks séparés via import.meta.glob — Vite
 *  crée un fichier par locale, fetché on-demand quand l'user change la langue.
 *  Cold start : on charge UNIQUEMENT le catalogue de la langue active.
 *
 *  Avant : 2200 lignes de strings packed → ~80KB minifié dans le bundle main.
 *  Après : EN inline + 1 chunk de la lang active à la 1re demande. */
const LOCALE_LOADERS = import.meta.glob<{ default: Record<string, string> }>(
  './locales/*.ts'
);

/** Catalog déjà chargé en mémoire. EN est toujours présent (inline).
 *  Mutation directe — on bump `version` pour signaler aux subscribers. */
const loaded: Partial<Record<Lang, Partial<Record<TKey, string>>>> = { en: EN };
let version = 0;
const subscribers = new Set<() => void>();
const inflight = new Map<Lang, Promise<void>>();

function notify(): void {
  version++;
  for (const sub of subscribers) sub();
}

async function ensureLoaded(lang: Lang): Promise<void> {
  if (lang === 'en' || loaded[lang]) return;
  let p = inflight.get(lang);
  if (p) return p;
  const key = `./locales/${lang}.ts`;
  const loader = LOCALE_LOADERS[key];
  if (!loader) return; // langue inconnue → fallback EN silencieux
  p = loader().then((mod) => {
    loaded[lang] = mod.default as Partial<Record<TKey, string>>;
    inflight.delete(lang);
    notify();
  });
  inflight.set(lang, p);
  return p;
}

/** Renvoie la traduction d'une clé dans la langue donnée, fallback EN.
 *  Supporte une simple substitution `{var}` via `vars`. Si la locale n'est
 *  pas encore loaded, fallback transparent à EN — quand le chunk arrive,
 *  les composants se rerendent (via useT). */
export function translate(
  lang: Lang,
  key: TKey,
  vars?: Record<string, string | number>
): string {
  const fromLang = loaded[lang]?.[key];
  const raw = (fromLang ?? EN[key]) as string;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

/** Type de la fonction t() retournée par `useT()`. Réutilisable pour passer
 *  t à des helpers extraits hors du composant. */
export type TFunction = (key: TKey, vars?: Record<string, string | number>) => string;

/** Hook : renvoie une fonction `t(key, vars?)` qui se met à jour automatiquement
 *  quand la langue change dans le store ET quand le catalogue lazy-loaded
 *  arrive. Pendant le fetch, on rend en EN (fallback transparent). */
export function useT(): TFunction {
  const lang = useSessionStore((s) => (s.settings?.language ?? 'en') as Lang);
  // Subscribe au version counter : trigger re-render quand un nouveau
  // catalog est chargé. useState pour l'état local, useEffect pour
  // (dés)inscrire et déclencher le load.
  const [, setV] = useState(version);
  useEffect(() => {
    const sub = (): void => setV((v) => v + 1);
    subscribers.add(sub);
    void ensureLoaded(lang);
    // Sync `<html lang>` côté DOM pour que les screen readers prononcent
    // l'UI dans la bonne langue. Sans ça, le `lang="en"` figé dans
    // index.html persiste même quand l'user passe en FR/JA/ZH.
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    }
    return () => {
      subscribers.delete(sub);
    };
  }, [lang]);
  return (key, vars) => translate(lang, key, vars);
}

/** Renvoie la lang BCP47 courante — utilisée pour `Intl.NumberFormat`,
 *  `Intl.RelativeTimeFormat`, etc. Pour `zh` on retourne `zh-CN` car les
 *  chaînes sont en chinois simplifié. */
export function useLocale(): string {
  const lang = useSessionStore((s) => s.settings?.language ?? 'en');
  return lang === 'zh' ? 'zh-CN' : lang;
}
