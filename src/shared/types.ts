// Types partagés entre main, preload et renderer.
// Toute structure qui traverse l'IPC doit être déclarée ici.

export type AgentId =
  | 'claude-code'
  | 'codex'
  | 'aider'
  | 'cursor-agent'
  | 'gemini'
  | 'shell';

export interface AgentPreset {
  id: AgentId;
  label: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  color: string;
  installUrl?: string;
}

export interface AgentAvailability {
  id: AgentId;
  found: boolean;
  resolvedPath?: string;
}

// ============================================================
// Panes (tmux-style)
// ============================================================

export type PaneId = string;

export type PaneStatus = 'starting' | 'running' | 'idle' | 'exited' | 'error';

export interface TerminalPane {
  id: PaneId;
  kind: 'terminal';
  agentId: AgentId;
  status: PaneStatus;
  cwd: string;
  pid?: number;
  exitCode?: number;
  initialInput?: string;
  /** Label utilisateur (renommage manuel). */
  label?: string;
  /** URLs localhost détectées récemment (max 10, plus récentes en dernier). */
  recentUrls?: string[];
  createdAt: number;
  lastStartedAt?: number;
  /** Timestamp du dernier output PTY (heartbeat, sert au stale detection). */
  lastOutputAt?: number;
}

export interface PreviewPane {
  id: PaneId;
  kind: 'preview';
  url: string;
  /** Label utilisateur. */
  label?: string;
  /** Si défini : ce preview suit l'URL active du terminal pane référencé. */
  followsPaneId?: PaneId;
}

export type Pane = TerminalPane | PreviewPane;

export type SplitDirection = 'horizontal' | 'vertical';

export type PaneTree =
  | { kind: 'leaf'; paneId: PaneId }
  | {
      kind: 'split';
      direction: SplitDirection;
      /** Pourcentages 0..100, somme = 100. Longueur = children.length. */
      sizes: number[];
      /** Au moins 2 enfants. Permet flatten quand on split dans la même direction. */
      children: PaneTree[];
    };

// ============================================================
// Sessions
// ============================================================

export interface Session {
  id: string;
  name: string;
  cwd: string;
  branch?: string;
  ephemeralWorktree?: boolean;
  sourceRepo?: string;
  panes: Record<PaneId, Pane>;
  tree: PaneTree;
  activePaneId?: PaneId;
  createdAt: number;
  /** Épinglée : remonte en haut de la sidebar. */
  pinned?: boolean;
  /** Override la couleur de l'agent pour cette session (hex). */
  colorOverride?: string;
}

export interface CreateSessionInput {
  name: string;
  agentId: AgentId;
  cwd: string;
  newWorktree?: {
    branch: string;
    base?: string;
    parentDir?: string;
  };
  initialInput?: string;
}

export interface SplitPaneInput {
  sessionId: string;
  paneId: PaneId;
  direction: SplitDirection;
  /** Si fourni, crée un terminal pane avec cet agent. Sinon : pane preview. */
  agentId?: AgentId;
  cwd?: string;
  /** Pour un preview pane. */
  url?: string;
  /** Suivre l'URL active de ce terminal. */
  followsPaneId?: PaneId;
}

export interface PtySize {
  cols: number;
  rows: number;
}

export interface GitRepoInfo {
  isRepo: boolean;
  path: string;
  currentBranch?: string;
  branches: string[];
  hasUncommitted: boolean;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  content: string;
  /** Tags pour filtrage. */
  tags?: string[];
  createdAt: number;
}

export type Lang = 'en' | 'fr' | 'de' | 'es' | 'zh' | 'ja' | 'tr';

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  language: Lang;
  fontFamily: string;
  fontSize: number;
  defaultShell: string;
  scrollback: number;
  cursorBlink: boolean;
  copyOnSelection: boolean;
  pasteOnRightClick: boolean;
  webglRenderer: boolean;
  sidebarWidth: number;
  /** Toast quand une URL localhost est détectée. */
  previewToastEnabled: boolean;
  /** Ouvrir automatiquement le preview embarqué dès qu'une URL est détectée. */
  previewAutoOpen: boolean;
  /** Notif système quand fenêtre en arrière-plan + event détecté. */
  notificationsEnabled: boolean;
  /** Son joué pour les notifs Windows. `custom` joue le fichier `notificationSoundPath`. */
  notificationSound: 'default' | 'silent' | 'custom';
  /** Chemin absolu vers un .wav/.mp3 quand `notificationSound === 'custom'`. */
  notificationSoundPath?: string;
  /** Lance vMux automatiquement au démarrage de Windows (en --hidden). */
  autoLaunch: boolean;
  /** Pourcentage du split quand on ouvre un preview (terminal | preview). */
  previewDefaultSplit: number;
  agentOverrides: Partial<Record<AgentId, Partial<Pick<AgentPreset, 'command' | 'args' | 'env'>>>>;
  /** True quand l'utilisateur a complété (ou skip) le tutoriel de premier lancement.
   *  False/undefined → l'overlay onboarding s'affiche au boot. */
  onboardingCompleted?: boolean;
  /** True : au démarrage, vMux relance automatiquement les PTY de toutes les
   *  sessions qui tournaient au shutdown précédent. False : sessions restaurées
   *  mais en idle (l'user clique restart). Défaut: true. */
  autoRestoreOnBoot: boolean;
  /** Dernière session active — restaurée comme `activeSessionId` au boot.
   *  null si l'user n'a jamais ouvert de session ou si elle a été supprimée. */
  lastActiveSessionId: string | null;
  /** Expose le Chrome DevTools Protocol sur localhost (port `cdpPort`) au boot.
   *  Permet à chrome-devtools-mcp et tout autre outil DevTools de driver le
   *  <webview> (preview pane) embarqué — clic, type, snapshot, JS eval.
   *  Désactiver si tu n'utilises pas ces intégrations. Default: true. */
  cdpEnabled: boolean;
  /** Port d'écoute du Chrome DevTools Protocol. Default: 9222 (standard). */
  cdpPort: number;
  /** Installer automatiquement le slash-command `/vmux:orchestrate` dans
   *  `~/.claude/commands/vmux/orchestrate.md` au premier lancement. Décompose
   *  une tâche et spawn N panes Claude Code en parallèle via le CLI vmux.
   *  Default: true. L'install est idempotente (overwrite si version vMux plus récente). */
  claudeCommandsEnabled: boolean;
  /** Mode "performance" : désactive le recalcul de contraste WCAG par glyphe
   *  et le rescale des glyphes débordants (Nerd Fonts). Gain CPU ~10-20%
   *  sous spew d'agent au prix d'un rendu légèrement moins fidèle.
   *  Default: false (qualité visuelle privilégiée). */
  performanceMode?: boolean;
  /** Taille max du pool de contextes WebGL — perf phase 4. Chromium plafonne
   *  à ~16 contextes par document avant cascade de loss ; on borne le pool
   *  pour qu'au-delà de cette limite, les panes excédentaires basculent
   *  proprement sur le renderer DOM au lieu de subir la perte de contexte.
   *  Default: 6. Borne pratique [1, 16]. Ignoré si webglRenderer:false. */
  webglPoolSize?: number;
  /** Expérimental — route les bytes PTY directement host→renderer via un
   *  MessageChannel zero-copy au lieu de passer par le main process. Élimine
   *  un structured-clone par flush 60Hz (la taille moyenne d'un flush sous
   *  spew agent peut atteindre 100KB+). Risque : si Electron drop les
   *  ArrayBuffer transférés sur ta version, le terminal n'affiche plus rien
   *  jusqu'à ce que tu désactives ce flag. Default: false. */
  experimentalZeroCopyIpc?: boolean;
}

// ============================================================
// Events détectés dans la sortie d'un PTY
// ============================================================

export type DetectedEventKind =
  | 'server-ready'
  | 'build-success'
  | 'build-error'
  | 'test-results'
  | 'agent-done'
  /** Notification explicite émise par l'agent/CLI via OSC escape sequence
   *  (OSC 9 iTerm, OSC 777 urxvt). Le `title` du DetectedEvent porte le
   *  texte fourni par l'agent ; le `message` peut être un body séparé. */
  | 'notify';

/** Niveau d'attention requis sur un pane non-actif (style tmux monitor-activity). */
export type PaneAttention = 'idle' | 'activity' | 'alert' | 'needs-input';

/** Sous-ensemble de PaneAttention émis sur l'IPC `pane:attention` (l'`idle`
 *  est implicite : on n'émet que les transitions vers un niveau actif). */
export type PaneAttentionLevel = Exclude<PaneAttention, 'idle'>;

/** État live de l'agent IA inféré du PTY (style "Idle / Generating / Thinking" Warp).
 *  Orthogonal à `PaneStatus` (qui est l'état du process) — un pane peut être
 *  `running` côté process tout en étant `idle` côté agent (prompt visible). */
export type AgentRunState = 'idle' | 'thinking' | 'generating' | 'needs-input';

/** Échantillon CPU/RAM pour un pane à un instant donné. */
export interface PaneStatSample {
  paneId: PaneId;
  /** CPU% — 0..100*vcore (8 cœurs ⇒ jusqu'à ~800). */
  cpu: number;
  /** RAM en octets. */
  memory: number;
  timestamp: number;
  /** Nombre de cœurs logiques de la machine — utile pour normaliser le CPU
   *  côté UI (`cpu / cores` = % machine). Constant durant la session, envoyé
   *  pour économiser un IPC séparé. */
  cores: number;
  /** False sur le 1er sample d'un pane fraîchement spawn — pidusage a besoin
   *  de 2 ticks pour calculer un delta CPU. L'UI affiche "calculating…". */
  primed: boolean;
}

/** Stats globales de la machine — pollées en parallèle des stats par pane. */
export interface SystemStatsSample {
  /** CPU% machine — 0..100. */
  cpu: number;
  /** RAM utilisée en octets. */
  memoryUsed: number;
  /** RAM totale en octets. */
  memoryTotal: number;
  /** Somme CPU% de tous les panes vMux trackés (déjà en %machine). */
  vmuxCpu: number;
  /** Somme RAM en octets de tous les panes vMux trackés. */
  vmuxMemory: number;
  /** Nombre de cœurs logiques. */
  cores: number;
  timestamp: number;
}

export interface DetectedEvent {
  paneId: PaneId;
  kind: DetectedEventKind;
  message: string;
  url?: string;
  /** Titre custom — utilisé par les events `notify` (OSC) où l'agent fournit
   *  son propre titre. Si absent, le notif-service retombe sur le titre i18n
   *  pour le `kind`. */
  title?: string;
  timestamp: number;
}

// ============================================================
// MCP servers (Model Context Protocol)
// ============================================================

/** Type de transport d'un serveur MCP. `stdio` = process local lancé via
 *  command/args. `http` / `sse` = serveur distant accessible via URL. */
export type McpServerType = 'stdio' | 'http' | 'sse';

/** Définition d'un serveur MCP — stockée dans `~/.claude.json` sous
 *  la clé `mcpServers` (servers actifs) ou `mcpServersDisabled` (gérée par
 *  vMux pour permettre toggle on/off sans perte de config). */
export interface McpServer {
  name: string;
  type: McpServerType;
  /** stdio : exécutable. Vide pour http/sse. */
  command?: string;
  /** stdio : arguments. */
  args?: string[];
  /** Variables d'env pour le process stdio. */
  env?: Record<string, string>;
  /** http/sse : URL du serveur distant. */
  url?: string;
  /** Si true, le serveur est désactivé (déplacé dans mcpServersDisabled). */
  disabled?: boolean;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Résultat d'un `clipboard:read-rich` — texte simple ou image sauvegardée. */
export type ClipboardRichResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string };

// ============================================================
// Canaux IPC
// ============================================================

export const IPC = {
  // Window
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizedChanged: 'window:maximized-changed',
  /** Renderer → main : ouvre la session dans une fenêtre Electron séparée
   *  (multi-écran, Alt+Tab natif). Idempotent : focus la fenêtre détachée
   *  existante si déjà ouverte pour cette session. */
  windowDetachSession: 'window:detach-session',

  // Sessions
  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionRemove: 'session:remove',
  sessionUpdate: 'session:update',
  /** Main → renderer : demande au renderer de focuser la session+pane spécifiés
   *  (ex. clic sur une notif système). Le renderer met à jour activeSessionId
   *  puis appelle `panes.focus`. */
  sessionFocusRequest: 'session:focus-request',

  // Panes
  paneSplit: 'pane:split',
  paneClose: 'pane:close',
  paneFocus: 'pane:focus',
  paneRestart: 'pane:restart',
  paneResizeSplit: 'pane:resize-split',
  paneOpenPreview: 'pane:open-preview',
  paneSetUrl: 'pane:set-url',
  paneRelayout: 'pane:relayout',
  paneRename: 'pane:rename',
  paneRemoveUrl: 'pane:remove-url',
  sessionRename: 'session:rename',
  sessionRestartAll: 'session:restart-all',
  sessionTogglePin: 'session:toggle-pin',
  sessionSetColor: 'session:set-color',
  sessionExport: 'session:export',
  paneWrite: 'pane:write',
  paneResize: 'pane:resize',
  paneData: 'pane:data',
  paneStatus: 'pane:status',
  /** Main → renderer : transports a MessagePortMain (in event.ports[0]) so the
   *  renderer can receive PTY byte frames directly from the PTY Host (zero-copy
   *  via ArrayBuffer transfer). The IPC channel is the carrier; the actual
   *  hot path is the port itself. Sent once per window after `did-finish-load`,
   *  re-sent after a host crash respawn. */
  paneDataPort: 'pane:data-port',

  // URLs détectées
  urlsDetected: 'urls:detected',

  // Events détectés
  eventDetected: 'event:detected',

  // Attention détectée (bell, needs-input, etc.)
  paneAttention: 'pane:attention',

  // État live de l'agent (idle / thinking / generating / needs-input)
  paneAgentState: 'pane:agent-state',

  // Stats CPU/RAM par pane (push depuis main toutes les 2s)
  paneStats: 'pane:stats',

  // Stats globales machine + somme vMux (push depuis main toutes les 2s)
  systemStats: 'pane:system-stats',

  // Agents
  agentsList: 'agents:list',
  agentsCheck: 'agents:check',

  // Git
  gitInspect: 'git:inspect',
  gitListWorktrees: 'git:list-worktrees',

  // Dialog / shell
  dialogPickDirectory: 'dialog:pick-directory',
  dialogPickRepo: 'dialog:pick-repo',
  dialogOpenExternal: 'dialog:open-external',

  // Clipboard
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
  clipboardReadRich: 'clipboard:read-rich',

  // Settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // Snippets
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsDelete: 'snippets:delete',

  // Diagnostic
  diagnosticExport: 'diagnostic:export',

  // Auto-update (electron-updater)
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  // App version (read-only)
  appVersion: 'app:version',

  // Notif sound (main → renderer pour custom .wav playback)
  notifPlaySound: 'notif:play-sound',

  // Sound file picker (renderer → main)
  dialogPickSoundFile: 'dialog:pick-sound-file',

  // Filesystem
  fsIsDirectory: 'fs:is-directory',

  // MCP servers
  mcpList: 'mcp:list',
  mcpAdd: 'mcp:add',
  mcpRemove: 'mcp:remove',
  mcpToggle: 'mcp:toggle',
  mcpConfigPath: 'mcp:config-path'
} as const;

// ============================================================
// Auto-update
// ============================================================

/** Codes d'erreur traduisibles côté renderer. Si présent, l'UI ignore `message`
 *  et utilise la traduction de la clé. */
export type UpdateErrorCode =
  | 'install-no-download'
  | 'no-installer-url'
  | 'github-api-failed'
  | 'no-response'
  | 'dev-mode'
  /** Émis quand electron-updater fire son event `error` (signature mismatch,
   *  blockmap corrompu, 404 sur l'asset…). UI peut afficher un bouton Retry. */
  | 'updater-error';

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string; releaseNotes?: string }
  | { kind: 'error'; message: string; code?: UpdateErrorCode };

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
