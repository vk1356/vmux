import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC,
  type AgentAvailability,
  type AgentPreset,
  type AppSettings,
  type ClipboardRichResult,
  type CreateSessionInput,
  type DetectedEvent,
  type GitRepoInfo,
  type IpcResult,
  type PaneId,
  type PtySize,
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
    }
  },

  git: {
    inspect: (path: string): Promise<IpcResult<GitRepoInfo>> =>
      ipcRenderer.invoke(IPC.gitInspect, path)
  },

  dialog: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickDirectory),
    pickRepo: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickRepo),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.dialogOpenExternal, url)
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
    }
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
  }
};

export type CmuxApi = typeof api;

try {
  contextBridge.exposeInMainWorld('cmux', api);
} catch (err) {
  console.error('[preload] expose failed', err);
}
