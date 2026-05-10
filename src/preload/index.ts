import { contextBridge, ipcRenderer, webUtils } from 'electron';
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

const api = {
  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    maximize: () => ipcRenderer.invoke(IPC.windowMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowIsMaximized),
    /** Ouvre une fenêtre Electron séparée pour cette session (multi-écran).
     *  Idempotent : si une fenêtre détachée existe déjà pour cette session,
     *  elle sera focusée au lieu d'en créer une nouvelle. */
    detachSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.windowDetachSession, sessionId),
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_: unknown, m: boolean): void => cb(m);
      ipcRenderer.on(IPC.windowMaximizedChanged, listener);
      return (): void => {
        ipcRenderer.off(IPC.windowMaximizedChanged, listener);
      };
    }
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

    onUpdate: (cb: (session: Session) => void): (() => void) => {
      const listener = (_: unknown, s: Session): void => cb(s);
      ipcRenderer.on(IPC.sessionUpdate, listener);
      return (): void => {
        ipcRenderer.off(IPC.sessionUpdate, listener);
      };
    },
    /** Subscribe à une demande de focus venant du main (ex. clic sur une notif
     *  natif). Le renderer doit switcher activeSessionId puis focus le pane. */
    onFocusRequest: (
      cb: (sessionId: string, paneId: PaneId) => void
    ): (() => void) => {
      const listener = (_: unknown, sId: string, pId: PaneId): void => cb(sId, pId);
      ipcRenderer.on(IPC.sessionFocusRequest, listener);
      return (): void => {
        ipcRenderer.off(IPC.sessionFocusRequest, listener);
      };
    }
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

    onData: (cb: (paneId: PaneId, data: string) => void): (() => void) => {
      const listener = (_: unknown, paneId: PaneId, data: string): void => cb(paneId, data);
      ipcRenderer.on(IPC.paneData, listener);
      return (): void => {
        ipcRenderer.off(IPC.paneData, listener);
      };
    },
    onStatus: (cb: (sessionId: string, paneId: PaneId, pane: TerminalPane) => void): (() => void) => {
      const listener = (_: unknown, sId: string, pId: PaneId, p: TerminalPane): void =>
        cb(sId, pId, p);
      ipcRenderer.on(IPC.paneStatus, listener);
      return (): void => {
        ipcRenderer.off(IPC.paneStatus, listener);
      };
    },
    onUrls: (cb: (paneId: PaneId, urls: string[]) => void): (() => void) => {
      const listener = (_: unknown, paneId: PaneId, urls: string[]): void => cb(paneId, urls);
      ipcRenderer.on(IPC.urlsDetected, listener);
      return (): void => {
        ipcRenderer.off(IPC.urlsDetected, listener);
      };
    },
    onEvent: (cb: (event: DetectedEvent) => void): (() => void) => {
      const listener = (_: unknown, event: DetectedEvent): void => cb(event);
      ipcRenderer.on(IPC.eventDetected, listener);
      return (): void => {
        ipcRenderer.off(IPC.eventDetected, listener);
      };
    },
    onAttention: (
      cb: (paneId: PaneId, level: 'activity' | 'alert' | 'needs-input') => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        paneId: PaneId,
        level: 'activity' | 'alert' | 'needs-input'
      ): void => cb(paneId, level);
      ipcRenderer.on(IPC.paneAttention, listener);
      return (): void => {
        ipcRenderer.off(IPC.paneAttention, listener);
      };
    },
    onAgentState: (cb: (paneId: PaneId, state: AgentRunState) => void): (() => void) => {
      const listener = (_: unknown, paneId: PaneId, state: AgentRunState): void =>
        cb(paneId, state);
      ipcRenderer.on(IPC.paneAgentState, listener);
      return (): void => {
        ipcRenderer.off(IPC.paneAgentState, listener);
      };
    },
    onStats: (cb: (samples: PaneStatSample[]) => void): (() => void) => {
      const listener = (_: unknown, samples: PaneStatSample[]): void => cb(samples);
      ipcRenderer.on(IPC.paneStats, listener);
      return (): void => {
        ipcRenderer.off(IPC.paneStats, listener);
      };
    },
    onSystemStats: (cb: (sample: SystemStatsSample) => void): (() => void) => {
      const listener = (_: unknown, s: SystemStatsSample): void => cb(s);
      ipcRenderer.on(IPC.systemStats, listener);
      return (): void => {
        ipcRenderer.off(IPC.systemStats, listener);
      };
    }
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
    onPlaySound: (cb: (path: string) => void): (() => void) => {
      const listener = (_: unknown, p: string): void => cb(p);
      ipcRenderer.on(IPC.notifPlaySound, listener);
      return (): void => {
        ipcRenderer.off(IPC.notifPlaySound, listener);
      };
    }
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
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_: unknown, s: UpdateStatus): void => cb(s);
      ipcRenderer.on(IPC.updateStatus, listener);
      return (): void => {
        ipcRenderer.off(IPC.updateStatus, listener);
      };
    }
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
};

export type CmuxApi = typeof api;

try {
  contextBridge.exposeInMainWorld('cmux', api);
} catch (err) {
  console.error('[preload] expose failed', err);
}
