import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AgentAvailability,
  type AgentPreset,
  type AgentRunState,
  type AppSettings,
  type ClipboardRichResult,
  type CreateSessionInput,
  type DetectedEvent,
  type GitRepoInfo,
  type IpcResult,
  type McpServer,
  type PaneAttentionLevel,
  type PaneId,
  type PaneStatSample,
  type PtySize,
  type SystemStatsSample,
  type Session,
  type Snippet,
  type SplitPaneInput,
  type TerminalPane,
  type UpdateStatus
} from '@shared/types';
import type { TreePath } from '@shared/tree';
import type { LayoutPreset } from '@shared/layouts';

/**
 * Helper d'inscription IPC main→renderer. Centralise :
 *  - Typage du listener (IpcRendererEvent, pas `unknown`).
 *  - Un seul pattern de subscribe + unsubscribe → moins de surface pour rater
 *    le cleanup. Renvoie systématiquement la fonction de désinscription.
 *
 * Le callback fourni reçoit uniquement le payload (l'event Electron est
 * masqué : le renderer n'a pas à manipuler `sender`/`ports`).
 *
 * Note sécurité : on n'expose JAMAIS `ipcRenderer.on` brut ni `ipcRenderer` lui-même
 * via contextBridge — chaque channel est explicitement listé dans `api` ci-dessous.
 */
type Unsubscribe = () => void;

function subscribe<Args extends readonly unknown[]>(
  channel: string,
  cb: (...args: Args) => void
): Unsubscribe {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => {
    // Le typage est garanti par la déclaration du caller (chaque appel à
    // `subscribe<[...]>(...)` fixe la shape attendue). On évite un parsing
    // runtime systématique (hot path : paneData ≈ 100/s). Le main est de
    // confiance — la défense en profondeur est côté ipcMain.
    cb(...(args as unknown as Args));
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.off(channel, listener);
  };
}

const api = {
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
    maximize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowIsMaximized),
    /** Ouvre une fenêtre Electron séparée pour cette session (multi-écran).
     *  Idempotent : si une fenêtre détachée existe déjà pour cette session,
     *  elle sera focusée au lieu d'en créer une nouvelle. */
    detachSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.windowDetachSession, sessionId),
    onMaximizedChanged: (cb: (maximized: boolean) => void): Unsubscribe =>
      subscribe<[boolean]>(IPC.windowMaximizedChanged, cb)
  },

  agents: {
    list: (): Promise<AgentPreset[]> => ipcRenderer.invoke(IPC.agentsList),
    check: (): Promise<AgentAvailability[]> => ipcRenderer.invoke(IPC.agentsCheck)
  },

  sessions: {
    list: (): Promise<Session[]> => ipcRenderer.invoke(IPC.sessionList),
    create: (input: CreateSessionInput): Promise<IpcResult<Session>> =>
      ipcRenderer.invoke(IPC.sessionCreate, input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionRemove, id),
    rename: (id: string, name: string): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.sessionRename, id, name),
    restartAll: (id: string): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.sessionRestartAll, id),
    togglePin: (id: string): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.sessionTogglePin, id),
    setColor: (id: string, color: string | null): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.sessionSetColor, id, color),

    onUpdate: (cb: (session: Session) => void): Unsubscribe =>
      subscribe<[Session]>(IPC.sessionUpdate, cb),
    /** Subscribe à une demande de focus venant du main (ex. clic sur une notif
     *  natif). Le renderer doit switcher activeSessionId puis focus le pane. */
    onFocusRequest: (cb: (sessionId: string, paneId: PaneId) => void): Unsubscribe =>
      subscribe<[string, PaneId]>(IPC.sessionFocusRequest, cb)
  },

  panes: {
    split: (input: SplitPaneInput): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.paneSplit, input),
    close: (sessionId: string, paneId: PaneId): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.paneClose, sessionId, paneId),
    focus: (sessionId: string, paneId: PaneId): Promise<void> =>
      ipcRenderer.invoke(IPC.paneFocus, sessionId, paneId),
    restart: (sessionId: string, paneId: PaneId): Promise<IpcResult<TerminalPane | null>> =>
      ipcRenderer.invoke(IPC.paneRestart, sessionId, paneId),
    resizeSplit: (
      sessionId: string,
      splitPath: TreePath,
      sizes: number[]
    ): Promise<void> => ipcRenderer.invoke(IPC.paneResizeSplit, sessionId, splitPath, sizes),
    setUrl: (sessionId: string, paneId: PaneId, url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.paneSetUrl, sessionId, paneId, url),
    relayout: (sessionId: string, preset: LayoutPreset): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.paneRelayout, sessionId, preset),
    rename: (
      sessionId: string,
      paneId: PaneId,
      label: string
    ): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.paneRename, sessionId, paneId, label),
    removeUrl: (
      sessionId: string,
      paneId: PaneId,
      url: string
    ): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.paneRemoveUrl, sessionId, paneId, url),
    openPreview: (
      sessionId: string,
      terminalPaneId: PaneId,
      url: string
    ): Promise<IpcResult<Session | null>> =>
      ipcRenderer.invoke(IPC.paneOpenPreview, sessionId, terminalPaneId, url),

    write: (paneId: PaneId, data: string): void => {
      ipcRenderer.send(IPC.paneWrite, paneId, data);
    },
    resize: (paneId: PaneId, size: PtySize): void => {
      ipcRenderer.send(IPC.paneResize, paneId, size);
    },

    onData: (cb: (paneId: PaneId, data: string) => void): Unsubscribe =>
      subscribe<[PaneId, string]>(IPC.paneData, cb),
    onStatus: (
      cb: (sessionId: string, paneId: PaneId, pane: TerminalPane) => void
    ): Unsubscribe => subscribe<[string, PaneId, TerminalPane]>(IPC.paneStatus, cb),
    onUrls: (cb: (paneId: PaneId, urls: string[]) => void): Unsubscribe =>
      subscribe<[PaneId, string[]]>(IPC.urlsDetected, cb),
    onEvent: (cb: (event: DetectedEvent) => void): Unsubscribe =>
      subscribe<[DetectedEvent]>(IPC.eventDetected, cb),
    onAttention: (cb: (paneId: PaneId, level: PaneAttentionLevel) => void): Unsubscribe =>
      subscribe<[PaneId, PaneAttentionLevel]>(IPC.paneAttention, cb),
    onAgentState: (cb: (paneId: PaneId, state: AgentRunState) => void): Unsubscribe =>
      subscribe<[PaneId, AgentRunState]>(IPC.paneAgentState, cb),
    onStats: (cb: (samples: PaneStatSample[]) => void): Unsubscribe =>
      subscribe<[PaneStatSample[]]>(IPC.paneStats, cb),
    onSystemStats: (cb: (sample: SystemStatsSample) => void): Unsubscribe =>
      subscribe<[SystemStatsSample]>(IPC.systemStats, cb)
  },

  git: {
    inspect: (path: string): Promise<IpcResult<GitRepoInfo>> =>
      ipcRenderer.invoke(IPC.gitInspect, path)
  },

  dialog: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickDirectory),
    pickRepo: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickRepo),
    pickSoundFile: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.dialogPickSoundFile),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.dialogOpenExternal, url)
  },

  notif: {
    onPlaySound: (cb: (path: string) => void): Unsubscribe =>
      subscribe<[string]>(IPC.notifPlaySound, cb)
  },

  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead),
    write: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWrite, text),
    readRich: (): Promise<ClipboardRichResult> => ipcRenderer.invoke(IPC.clipboardReadRich)
  },

  fs: {
    /**
     * Récupère le chemin disque absolu d'un objet File (drag & drop depuis l'OS).
     * Disponible uniquement via preload car contextIsolation masque webUtils
     * au renderer principal.
     */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    /** Détecte si un chemin pointe sur un dossier — utilisé pour le drag-drop
     *  de dossier sur la window (ouvre New Session avec ce cwd pré-rempli). */
    isDirectory: (path: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.fsIsDirectory, path)
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch)
  },

  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsList),
    save: (s: Snippet): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsSave, s),
    remove: (id: string): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsDelete, id)
  },

  diagnostic: {
    export: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke(IPC.diagnosticExport)
  },

  updater: {
    check: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheck),
    download: (): Promise<void> => ipcRenderer.invoke(IPC.updateDownload),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
    onStatus: (cb: (status: UpdateStatus) => void): Unsubscribe =>
      subscribe<[UpdateStatus]>(IPC.updateStatus, cb)
  },

  app: {
    version: (): Promise<string> => ipcRenderer.invoke(IPC.appVersion)
  },

  mcp: {
    list: (): Promise<IpcResult<McpServer[]>> => ipcRenderer.invoke(IPC.mcpList),
    add: (s: McpServer): Promise<IpcResult<McpServer[]>> => ipcRenderer.invoke(IPC.mcpAdd, s),
    remove: (name: string): Promise<IpcResult<McpServer[]>> =>
      ipcRenderer.invoke(IPC.mcpRemove, name),
    toggle: (name: string): Promise<IpcResult<McpServer[]>> =>
      ipcRenderer.invoke(IPC.mcpToggle, name),
    configPath: (): Promise<string> => ipcRenderer.invoke(IPC.mcpConfigPath)
  }
} as const;

export type CmuxApi = typeof api;

try {
  contextBridge.exposeInMainWorld('cmux', api);
} catch (err) {
  console.error('[preload] expose failed', err);
}
