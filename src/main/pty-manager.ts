import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import { app } from 'electron';
import log from 'electron-log/main';
import type {
  AgentRunState,
  CreateSessionInput,
  DetectedEvent,
  Pane,
  PaneId,
  PaneStatus,
  PreviewPane,
  PtySize,
  Session,
  SplitPaneInput,
  TerminalPane
} from '@shared/types';
import { findAgent, resolveAgent } from '@shared/agents';
import { allPaneIds, firstLeaf, removePane, setSplitSizes, splitAt, type TreePath } from '@shared/tree';
import { applyLayout, type LayoutPreset } from '@shared/layouts';
import { buildAgentBootLine, getInteractiveShell } from './shell';
import { createWorktree, removeWorktree } from './worktree-manager';
import { getSettings, loadSessions, saveSessions } from './settings-store';
import { extractUrlsFromStripped, mergeUrls, stripAnsi } from './url-detector';
import { clearDetector, detectEventsFromStripped } from './event-detector';
import { detectOscEvents } from './osc-detector';
import { ptyStats } from './pty-stats';
import { detectsNeedsInput } from './needs-input-detect';
import { deriveAgentState, IDLE_AFTER_MS } from './agent-state-detect';
import { PaneDataBuffer } from './pane-data-buffer';

interface ManagedPane {
  process?: pty.IPty;
  lastSize?: PtySize;
  pendingInitialInput?: string;
  /** Commande de boot agent à écrire après le premier resize du renderer. */
  pendingBootLine?: string;
  /** True quand le bootLine a été écrit (ou n'était pas nécessaire). */
  bootWritten?: boolean;
  /** True quand la commande initialInput a été écrite. */
  bootSent?: boolean;
  /** Timers à clear si le pane est fermé pendant leur fenêtre. */
  bootTimer?: NodeJS.Timeout;
  fallbackTimer?: NodeJS.Timeout;
  inputTimer?: NodeJS.Timeout;
  /** Disposables retournés par child.onData / child.onExit — à dispose
   *  avant kill pour éviter les chunks de l'ancien process qui leakent
   *  dans le buffer du nouveau au restart. */
  dataSub?: pty.IDisposable;
  exitSub?: pty.IDisposable;
  /** Tail roulant stripped (max ~2KB) pour la détection d'état d'agent.
   *  On garde plus long que SCAN_WINDOW (800) pour absorber les chunks ANSI
   *  qui peuvent contenir des séquences d'effacement importantes. */
  stateTail?: string;
  /** Timestamp du dernier chunk PTY (Date.now()). Sert au calcul idle. */
  lastDataAt?: number;
  /** Dernière émission du heartbeat dans session.panes[].lastOutputAt — throttle 1Hz. */
  lastHeartbeatEmit?: number;
  /** Dernier état émis pour ce pane — émission idempotente sur transitions. */
  lastAgentState?: AgentRunState;
  /** Timer qui flippe en `idle` après IDLE_AFTER_MS de silence. */
  idleTimer?: NodeJS.Timeout;
  /** Timer de debounce pour proc.resize() — évite les storms 60Hz pendant
   *  les drags de window resize (ConPTY n'aime pas être hammered). */
  resizeTimer?: NodeJS.Timeout;
  /** Accumulateur des bytes stripped depuis le dernier flush des détecteurs
   *  non-critiques (URL detection, build/test/server-ready events). On les
   *  trigger à 4Hz max au lieu d'à chaque chunk : pour de l'agent spew
   *  intense (100+ chunks/s), réduit le coût des regex de ~95% sans coût UX. */
  detectorBuf?: string;
  detectorRawBuf?: string;
  detectorTimer?: NodeJS.Timeout;
  /** Streaming UTF-8 decoder for the analysis path. node-pty in Buffer mode
   *  can deliver a chunk that ends mid-codepoint (e.g. a 2-byte UTF-8 letter
   *  split across two reads); a non-streaming decoder would emit a replacement
   *  char and a follow-up garbled char. {stream:true} buffers the incomplete
   *  tail until the next chunk completes it. Bytes for xterm bypass this path
   *  entirely (raw bytes via PaneDataBuffer → MessagePort). */
  decoder?: TextDecoder;
}

interface ManagedSession {
  session: Session;
  panes: Map<PaneId, ManagedPane>;
  /** Worktree à supprimer au close de la session. */
  cleanupPath?: string;
}

type Events = {
  // Binaire (Uint8Array) plutôt que string : xterm.write(Uint8Array) skip la
  // conversion UTF-16 interne, et l'IPC Electron sérialise plus vite un
  // ArrayBuffer (UTF-8 en transit) qu'une string V8 (UTF-16 → utf8 → utf16).
  paneData: [paneId: PaneId, data: Uint8Array];
  paneStatus: [sessionId: string, paneId: PaneId, pane: TerminalPane];
  sessionUpdate: [session: Session];
  urlsDetected: [paneId: PaneId, urls: string[]];
  eventDetected: [event: DetectedEvent];
  paneAttention: [paneId: PaneId, level: 'activity' | 'alert' | 'needs-input'];
  paneAgentState: [paneId: PaneId, state: AgentRunState];
};

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  /** Index inversé pane→session pour O(1) lookups dans writePane/resizePane (hot
   *  paths : fire à chaque keystroke / resize). Avant cet index, findSessionByPane
   *  itérait toutes les sessions × tous les panes — O(N×P) à chaque touche. */
  private paneToSession = new Map<PaneId, string>();
  /** Buffer agrégateur des chunks PTY — flush 60Hz, voir pane-data-buffer.ts. */
  private dataBuffer = new PaneDataBuffer();
  /** Dernière émission d'attention 'activity' par pane — throttle 500ms. */
  private lastActivityEmit = new Map<PaneId, number>();

  /** Clear tous les timers en vol pour un pane (boot, fallback, initialInput, idle). */
  private clearPaneTimers(mp: ManagedPane): void {
    if (mp.bootTimer) {
      clearTimeout(mp.bootTimer);
      mp.bootTimer = undefined;
    }
    if (mp.fallbackTimer) {
      clearTimeout(mp.fallbackTimer);
      mp.fallbackTimer = undefined;
    }
    if (mp.inputTimer) {
      clearTimeout(mp.inputTimer);
      mp.inputTimer = undefined;
    }
    if (mp.idleTimer) {
      clearTimeout(mp.idleTimer);
      mp.idleTimer = undefined;
    }
    if (mp.resizeTimer) {
      clearTimeout(mp.resizeTimer);
      mp.resizeTimer = undefined;
    }
    if (mp.detectorTimer) {
      clearTimeout(mp.detectorTimer);
      mp.detectorTimer = undefined;
    }
    mp.detectorBuf = undefined;
    mp.detectorRawBuf = undefined;
  }

  /** AbortController : annulé au shutdown pour que tout async en vol
   *  (worktree removal, etc.) cesse proprement sans émettre vers l'IPC mort. */
  private shutdownCtrl = new AbortController();
  /** True une fois shutdown() entré — on n'émet plus rien après. */
  private isShuttingDown = false;

  /** Encoder réutilisé pour la conversion string→UTF-8 sur le hot path flush.
   *  Allocation unique, méthode `encode()` thread-safe et zero-cost. */
  private encoder = new TextEncoder();

  constructor() {
    super();
    // Forward des chunks agrégés du buffer vers les listeners IPC. Le buffer
    // travaille en byte-mode (perf phase 2) : `combined` est déjà un Uint8Array,
    // zéro transcode UTF-16↔UTF-8 sur le hot path — l'IPC Electron passe un
    // ArrayBuffer et xterm.js parse directement.
    this.dataBuffer.on('flush', (paneId, combined) => {
      if (this.isShuttingDown) return;
      this.emit('paneData', paneId, combined);
    });
    // Filet de sécurité : sans ça, une exception dans un listener (renderer
    // crashé, etc.) cracherait le main process et tuerait *tous* les PTY.
    process.on('unhandledRejection', (err) => {
      log.error('[pty] unhandledRejection', err);
    });
    for (const s of loadSessions()) {
      // À la restauration, marquer tous les panes terminaux en idle (pas de PTY vivant).
      const panes: Record<PaneId, (typeof s.panes)[string]> = {};
      for (const [pid, p] of Object.entries(s.panes)) {
        panes[pid] = p.kind === 'terminal' ? { ...p, status: 'idle', pid: undefined } : p;
        this.paneToSession.set(pid, s.id);
      }
      const session: Session = { ...s, panes };
      const managed: ManagedSession = { session, panes: new Map() };
      this.sessions.set(s.id, managed);
    }
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).map((m) => m.session);
  }

  /** Lookup public sessionId pour un paneId — O(1) via l'index inversé.
   *  Utilisé par ipc.ts pour router les events vers les bonnes fenêtres
   *  (main + détachées de la session propriétaire), au lieu de broadcaster
   *  à toutes les BrowserWindows. */
  sessionForPane(paneId: PaneId): string | undefined {
    return this.paneToSession.get(paneId);
  }

  /** Auto-restore : relance les PTY de tous les terminal panes des sessions
   *  restaurées depuis le disque. Appelé une fois au boot après registerIpc,
   *  uniquement si AppSettings.autoRestoreOnBoot === true.
   *
   *  Idempotent : skip un pane qui aurait déjà un process vivant (cas où la
   *  méthode serait appelée deux fois par erreur). Échelonne les spawns par
   *  petits paquets pour ne pas saturer ConPTY/CPU au boot. */
  async autoRestoreSessions(): Promise<number> {
    let count = 0;
    for (const m of this.sessions.values()) {
      const ids = allPaneIds(m.session.tree);
      for (const paneId of ids) {
        const p = m.session.panes[paneId];
        if (!p || p.kind !== 'terminal') continue;
        const mp = m.panes.get(paneId);
        // Skip si un PTY est déjà vivant (idempotence) ou si l'user avait
        // explicitement quitté le pane (status === 'exited' || 'error') —
        // dans ces cas-là, attendre qu'il clique "Restart" lui-même.
        if (mp?.process) continue;
        if (p.status === 'exited' || p.status === 'error') continue;
        // Reset l'état pour partir propre — mais on dispose d'abord les
        // subs/timers résiduels au cas où (idempotence stricte).
        if (mp) {
          this.clearPaneTimers(mp);
          this.disposeChildSubs(mp);
        }
        m.panes.set(paneId, { pendingInitialInput: undefined });
        // Met à jour le pane visible côté renderer (status 'starting') avant spawn.
        m.session.panes = {
          ...m.session.panes,
          [paneId]: { ...p, status: 'starting', pid: undefined, lastStartedAt: Date.now() }
        };
        this.spawnPane(m.session.id, paneId);
        count++;
      }
      this.emit('sessionUpdate', m.session);
    }
    if (count > 0) this.persist();
    return count;
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }

  // ============================================================
  // Sessions
  // ============================================================

  async createSession(input: CreateSessionInput): Promise<Session> {
    const agent = findAgent(input.agentId);
    if (!agent) throw new Error(`Agent inconnu: ${input.agentId}`);

    let cwd = input.cwd;
    let branch: string | undefined;
    let cleanupPath: string | undefined;
    let sourceRepo: string | undefined;

    if (input.newWorktree) {
      const wt = await createWorktree({
        repo: input.cwd,
        branch: input.newWorktree.branch,
        base: input.newWorktree.base,
        parentDir: input.newWorktree.parentDir
      });
      sourceRepo = input.cwd;
      cwd = wt.path;
      branch = wt.branch;
      if (wt.created) cleanupPath = wt.path;
    }

    const sessionId = randomUUID();
    const paneId = randomUUID();
    const pane: TerminalPane = {
      id: paneId,
      kind: 'terminal',
      agentId: agent.id,
      status: 'starting',
      cwd,
      initialInput: input.initialInput,
      createdAt: Date.now(),
      lastStartedAt: Date.now()
    };
    const session: Session = {
      id: sessionId,
      name: input.name || `${agent.label} · ${branch ?? 'main'}`,
      cwd,
      branch,
      sourceRepo,
      ephemeralWorktree: !!cleanupPath,
      panes: { [paneId]: pane },
      tree: { kind: 'leaf', paneId },
      activePaneId: paneId,
      createdAt: Date.now()
    };
    const managed: ManagedSession = {
      session,
      cleanupPath,
      panes: new Map([[paneId, { pendingInitialInput: input.initialInput }]])
    };
    this.sessions.set(sessionId, managed);
    this.paneToSession.set(paneId, sessionId);
    this.persist();
    this.emit('sessionUpdate', session);

    this.spawnPane(sessionId, paneId);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const m = this.sessions.get(sessionId);
    if (!m) return;
    for (const [paneId, mp] of m.panes) {
      this.clearPaneTimers(mp);
      // disposeChildSubs avant kill() : sinon le onExit handler s'exécute après
      // que removeSession ait déjà delete la session, fait fuir des events vers
      // l'IPC pour une session morte.
      this.disposeChildSubs(mp);
      try {
        mp.process?.kill();
      } catch {
        /* déjà mort */
      }
      clearDetector(paneId);
      ptyStats.removePane(paneId);
      this.dataBuffer.delete(paneId);
      this.lastActivityEmit.delete(paneId);
    }
    // Drop tous les paneId de cette session de l'index inversé. On itère sur
    // session.panes (et pas managed.panes) pour couvrir aussi les preview panes.
    for (const paneId of Object.keys(m.session.panes)) {
      this.paneToSession.delete(paneId);
    }
    if (m.cleanupPath && m.session.sourceRepo) {
      try {
        await removeWorktree(m.session.sourceRepo, m.cleanupPath);
      } catch (err) {
        log.error('[pty] worktree cleanup failed', err);
      }
    }
    this.sessions.delete(sessionId);
    this.persist();
  }

  // ============================================================
  // Panes
  // ============================================================

  async splitPane(input: SplitPaneInput): Promise<Session | null> {
    const m = this.sessions.get(input.sessionId);
    if (!m) return null;

    const newPaneId = randomUUID();
    let newPane: TerminalPane | PreviewPane;

    if (input.url) {
      newPane = {
        id: newPaneId,
        kind: 'preview',
        url: input.url,
        followsPaneId: input.followsPaneId
      };
    } else {
      const agentId = input.agentId ?? this.firstTerminalAgent(m) ?? 'shell';
      const agent = findAgent(agentId);
      if (!agent) throw new Error(`Agent inconnu: ${agentId}`);
      newPane = {
        id: newPaneId,
        kind: 'terminal',
        agentId: agent.id,
        status: 'starting',
        cwd: input.cwd ?? m.session.cwd,
        createdAt: Date.now(),
        lastStartedAt: Date.now()
      };
    }

    m.session.tree = splitAt(m.session.tree, input.paneId, input.direction, newPaneId);
    m.session.panes = { ...m.session.panes, [newPaneId]: newPane };
    m.session.activePaneId = newPaneId;
    if (newPane.kind === 'terminal') {
      m.panes.set(newPaneId, {});
    }
    this.paneToSession.set(newPaneId, input.sessionId);
    this.persist();
    this.emit('sessionUpdate', m.session);

    if (newPane.kind === 'terminal') {
      this.spawnPane(input.sessionId, newPaneId);
    }
    return m.session;
  }

  async closePane(sessionId: string, paneId: PaneId): Promise<Session | null> {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const mp = m.panes.get(paneId);
    if (mp) {
      this.clearPaneTimers(mp);
      this.disposeChildSubs(mp);
      try {
        mp.process?.kill();
      } catch {
        /* déjà mort */
      }
      m.panes.delete(paneId);
    }
    clearDetector(paneId);
    ptyStats.removePane(paneId);
    this.dataBuffer.delete(paneId);
    this.paneToSession.delete(paneId);
    const newTree = removePane(m.session.tree, paneId);
    if (!newTree) {
      // Plus de panes → on ferme la session entière. Après removeSession,
      // `m` est une référence morte (session déjà supprimée du map) — toute
      // mutation/emit ferait fuiter une session fantôme côté renderer.
      await this.removeSession(sessionId);
      return null;
    }
    const { [paneId]: _removed, ...rest } = m.session.panes;
    void _removed;
    m.session.tree = newTree;
    m.session.panes = rest;
    if (m.session.activePaneId === paneId) {
      m.session.activePaneId = firstLeaf(newTree);
    }
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  focusPane(sessionId: string, paneId: PaneId): void {
    const m = this.sessions.get(sessionId);
    if (!m || !m.session.panes[paneId]) return;
    m.session.activePaneId = paneId;
    this.persist();
    this.emit('sessionUpdate', m.session);
  }

  /** Réorganise les panes existantes selon un preset (tiled/even-h/even-v/main-stack). */
  relayout(sessionId: string, preset: LayoutPreset): Session | null {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const ids = allPaneIds(m.session.tree);
    if (ids.length <= 1) return m.session;
    m.session.tree = applyLayout(preset, ids);
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  resizeSplit(sessionId: string, splitPath: TreePath, sizes: number[]): void {
    const m = this.sessions.get(sessionId);
    if (!m) return;
    m.session.tree = setSplitSizes(m.session.tree, splitPath, sizes);
    this.persist();
    this.emit('sessionUpdate', m.session);
  }

  removeUrlFromPane(sessionId: string, paneId: PaneId, url: string): Session | null {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const p = m.session.panes[paneId];
    if (!p || p.kind !== 'terminal') return null;
    const urls = (p.recentUrls ?? []).filter((u) => u !== url);
    m.session.panes = { ...m.session.panes, [paneId]: { ...p, recentUrls: urls } };
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  renamePane(sessionId: string, paneId: PaneId, label: string): Session | null {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const p = m.session.panes[paneId];
    if (!p) return null;
    const trimmed = label.trim().slice(0, 60);
    m.session.panes = {
      ...m.session.panes,
      [paneId]: { ...p, label: trimmed || undefined } as Pane
    };
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  togglePin(sessionId: string): Session | null {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    m.session = { ...m.session, pinned: !m.session.pinned };
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  setSessionColor(sessionId: string, color: string | null): Session | null {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const colorOverride = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined;
    m.session = { ...m.session, colorOverride };
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  renameSession(sessionId: string, name: string): Session | null {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) return m.session;
    m.session = { ...m.session, name: trimmed };
    this.persist();
    this.emit('sessionUpdate', m.session);
    return m.session;
  }

  /** Restart tous les panes terminaux de la session qui sont en idle/exited/error. */
  async restartAll(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const ids = allPaneIds(m.session.tree);
    for (const id of ids) {
      const p = m.session.panes[id];
      if (
        p?.kind === 'terminal' &&
        (p.status === 'idle' || p.status === 'exited' || p.status === 'error')
      ) {
        await this.restartPane(sessionId, id);
      }
    }
    return m.session;
  }

  setPaneUrl(sessionId: string, paneId: PaneId, url: string): void {
    const m = this.sessions.get(sessionId);
    if (!m) return;
    const p = m.session.panes[paneId];
    if (!p || p.kind !== 'preview') return;
    m.session.panes = { ...m.session.panes, [paneId]: { ...p, url } };
    this.persist();
    this.emit('sessionUpdate', m.session);
  }

  async restartPane(sessionId: string, paneId: PaneId): Promise<TerminalPane | null> {
    const m = this.sessions.get(sessionId);
    if (!m) return null;
    const p = m.session.panes[paneId];
    if (!p || p.kind !== 'terminal') return null;

    const mp = m.panes.get(paneId) ?? {};
    this.clearPaneTimers(mp);
    this.disposeChildSubs(mp);
    if (mp.process) {
      try {
        mp.process.kill();
      } catch {
        /* déjà mort */
      }
      mp.process = undefined;
    }
    mp.bootSent = false;
    mp.pendingInitialInput = p.initialInput;
    // Reset l'état d'agent pour ne pas hériter du tail de la run précédente.
    mp.stateTail = '';
    mp.lastAgentState = undefined;
    m.panes.set(paneId, mp);

    const updated: TerminalPane = {
      ...p,
      status: 'starting',
      exitCode: undefined,
      pid: undefined,
      lastStartedAt: Date.now()
    };
    m.session.panes = { ...m.session.panes, [paneId]: updated };
    this.persist();
    this.emit('sessionUpdate', m.session);

    this.spawnPane(sessionId, paneId);
    return updated;
  }

  // ============================================================
  // PTY I/O
  // ============================================================

  writePane(paneId: PaneId, data: string): void {
    if (this.isShuttingDown) return;
    // Hot path : O(1) via index inversé. Avant : findSessionByPane scan O(N×P).
    const sessionId = this.paneToSession.get(paneId);
    if (!sessionId) return;
    const mp = this.sessions.get(sessionId)?.panes.get(paneId);
    const proc = mp?.process;
    if (!proc) return;
    try {
      proc.write(data);
    } catch (err) {
      log.debug('[pty] write failed', err);
    }
  }

  resizePane(paneId: PaneId, size: PtySize): void {
    const sessionId = this.paneToSession.get(paneId);
    if (!sessionId) return;
    const m = this.sessions.get(sessionId);
    const mp = m?.panes.get(paneId);
    if (!mp) return;
    const cols = Math.max(2, Math.floor(size.cols));
    const rows = Math.max(2, Math.floor(size.rows));
    if (mp.lastSize?.cols === cols && mp.lastSize?.rows === rows) return;
    const isFirstResize = !mp.lastSize;
    mp.lastSize = { cols, rows };
    if (!mp.process) return;
    // Debounce ~16ms : pendant un drag de window resize, le renderer envoie
    // resize à 60Hz. ConPTY ne supporte pas les resize back-to-back (flickering,
    // crashes occasionnels). On garde toujours le dernier size dans lastSize,
    // donc le pane affichera la bonne géométrie même si plusieurs resize sont
    // coalescés.
    const proc = mp.process;
    if (mp.resizeTimer) clearTimeout(mp.resizeTimer);
    mp.resizeTimer = setTimeout(() => {
      mp.resizeTimer = undefined;
      try {
        proc.resize(cols, rows);
      } catch (err) {
        log.debug('[pty] resize failed', err);
      }
    }, 16);

    // Premier resize après spawn : c'est le moment idéal pour écrire la
    // commande de boot de l'agent — on connaît enfin la vraie taille de
    // la fenêtre, donc l'agent dessinera son TUI au bon format dès le départ.
    if (isFirstResize && !mp.bootWritten && mp.pendingBootLine) {
      mp.bootWritten = true;
      const cmd = mp.pendingBootLine;
      mp.pendingBootLine = undefined;
      mp.bootTimer = setTimeout(() => {
        mp.bootTimer = undefined;
        try {
          // \x0c = Form Feed (Ctrl+L) → efface le prompt pwsh pré-resize.
          // Sur POSIX bash/zsh on n'envoie pas ce préfixe (insère un littéral).
          const prefix = process.platform === 'win32' ? '\x0c' : '';
          mp.process?.write(`${prefix}${cmd}\r`);
        } catch (err) {
          log.debug('[pty] write bootLine failed', err);
        }
      }, 80);
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private firstTerminalAgent(m: ManagedSession): import('@shared/types').AgentId | null {
    for (const id of allPaneIds(m.session.tree)) {
      const p = m.session.panes[id];
      if (p && p.kind === 'terminal') return p.agentId;
    }
    return null;
  }

  private spawnPane(sessionId: string, paneId: PaneId): void {
    if (this.isShuttingDown) return;
    const m = this.sessions.get(sessionId);
    if (!m) return;
    const pane = m.session.panes[paneId];
    if (!pane || pane.kind !== 'terminal') return;
    // Validation du cwd — node-pty.spawn throw une UnhandledException native si
    // cwd n'existe pas (et le message Windows est cryptique). On surface une
    // erreur claire et on évite le crash du worker thread.
    if (pane.cwd && !existsSync(pane.cwd)) {
      log.error(`[pty] cwd does not exist: ${pane.cwd}`);
      this.updatePane(sessionId, paneId, { status: 'error', exitCode: -1 });
      this.emit(
        'paneData',
        paneId,
        this.encoder.encode(`\r\n\x1b[31m[cmux] Dossier introuvable: ${pane.cwd}\x1b[0m\r\n`)
      );
      return;
    }
    // Merge l'agent preset avec l'override utilisateur s'il existe.
    const overrides = getSettings().agentOverrides;
    const agent = resolveAgent(pane.agentId, overrides);
    if (!agent) return;
    const mp = m.panes.get(paneId) ?? {};
    // Defensive : si on respawne sur un slot qui aurait gardé d'anciens subs
    // ou timers (race exotique), on les nettoie avant de reconstruire — sinon
    // les anciens onData/onExit captureraient le scope du nouveau child.
    this.clearPaneTimers(mp);
    this.disposeChildSubs(mp);
    m.panes.set(paneId, mp);

    const shell = getInteractiveShell();
    const env: Record<string, string> = {
      ...process.env,
      ...(agent.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PYTHONIOENCODING: 'utf-8'
    } as Record<string, string>;

    // Prepend les search-tools bundlés (rg, fd) au PATH du PTY. Sur Windows,
    // ça donne aux agents (Claude Code, Codex, Aider…) accès à ripgrep et fd
    // sans que l'user ait à les installer — parité avec ce que macOS offre via
    // bfs/ugrep dans les builds natifs Claude Code.
    //
    // Le dossier peut être absent si l'user n'a pas lancé `npm run fetch-tools`
    // avant la build — dans ce cas no-op silencieux.
    if (process.platform === 'win32') {
      // Garde défensive sur `app` : selon le contexte d'évaluation (interop
      // ESM↔CJS sous electron-vite 6 beta, HMR du main), l'import nommé peut
      // ne pas être résolu à l'instant T alors qu'il l'était au boot. On
      // no-op alors plutôt que de crasher la création de session — même
      // comportement que si le dossier bin était absent (build sans
      // `npm run fetch-tools`).
      const isPackaged = app?.isPackaged === true;
      const appPath = !isPackaged ? app?.getAppPath?.() : undefined;
      const bundledBin = isPackaged
        ? path.join(process.resourcesPath, 'bin')
        : appPath
          ? path.join(appPath, 'build', 'bin-win')
          : undefined;
      if (bundledBin && existsSync(bundledBin)) {
        const sep = ';'; // win32 PATH separator
        const curPath = env.Path ?? env.PATH ?? '';
        // On utilise `Path` (mixed-case) car c'est ce que ConPTY/cmd voient ;
        // sinon Powershell pourrait avoir une dup `PATH` qui shadow `Path`.
        env.Path = `${bundledBin}${sep}${curPath}`;
        delete env.PATH;
      }
    }

    const cols = mp.lastSize?.cols ?? 120;
    const rows = mp.lastSize?.rows ?? 30;

    let child: pty.IPty;
    try {
      // ConPTY-specific options : ignorées sur macOS/Linux par node-pty mais on
      // ne les passe que sur win32 pour la propreté du contrat de spawn.
      const winOpts =
        process.platform === 'win32'
          ? {
              // node-pty 1.1+ : conpty.dll bundlé, plus stable que celui de l'OS
              // sur certaines builds Windows 10 < 22H2.
              useConptyDll: true,
              conptyInheritCursor: false
            }
          : {};
      child = pty.spawn(shell.exe, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: pane.cwd,
        env,
        // Byte-mode (perf phase 2) : node-pty livre des Buffer bruts au lieu
        // de strings utf-8 décodées. On évite ainsi le coût UTF-16↔UTF-8 sur
        // chaque chunk (onData appelée à plusieurs centaines de Hz en spew).
        // Les bytes filent direct vers PaneDataBuffer → MessagePort transfer.
        // node-pty types `data` comme string dans .d.ts ; cast côté runtime.
        encoding: null as unknown as 'utf8',
        ...winOpts
      });
    } catch (err) {
      log.error('[pty] spawn failed', err);
      this.updatePane(sessionId, paneId, { status: 'error', exitCode: -1 });
      this.emit(
        'paneData',
        paneId,
        this.encoder.encode(
          `\r\n\x1b[31m[cmux] Échec du lancement du shell: ${(err as Error).message}\x1b[0m\r\n`
        )
      );
      return;
    }

    mp.process = child;
    this.updatePane(sessionId, paneId, { status: 'running', pid: child.pid });
    ptyStats.setPid(paneId, child.pid);

    const bootLine = buildAgentBootLine(agent);
    mp.pendingBootLine = bootLine || undefined;
    mp.bootWritten = !bootLine;
    // On efface lastSize pour forcer le prochain resize du renderer à
    // déclencher la logique de boot (sinon resize() court-circuite quand
    // les dimensions sont identiques au run précédent — cas du restart).
    mp.lastSize = undefined;

    // Filet de sécurité : si le renderer ne nous envoie pas de resize sous
    // 1s (cas du restart où le pane est déjà à la bonne taille), on écrit
    // quand même la bootLine pour ne pas bloquer le user.
    if (bootLine) {
      mp.fallbackTimer = setTimeout(() => {
        const cur = this.sessions.get(sessionId);
        const curMp = cur?.panes.get(paneId);
        if (curMp && !curMp.bootWritten && curMp.pendingBootLine) {
          curMp.bootWritten = true;
          curMp.fallbackTimer = undefined;
          const cmd = curMp.pendingBootLine;
          curMp.pendingBootLine = undefined;
          try {
            const prefix = process.platform === 'win32' ? '\x0c' : '';
            curMp.process?.write(`${prefix}${cmd}\r`);
          } catch (err) {
            log.error('[pty] fallback bootLine failed', err);
          }
        }
      }, 1000);
    }

    mp.dataSub = child.onData((data) => {
      if (this.isShuttingDown) return;
      // node-pty est en encoding:null → `data` est en fait un Buffer au runtime
      // bien que typé string dans .d.ts. Cast safe pour le hot path byte-mode.
      const bytes = data as unknown as Buffer;
      // Batch côté main : agrège les bytes pour réduire l'overhead IPC.
      // Zéro transcode — le buffer livrera ces mêmes octets sur le flush.
      this.dataBuffer.push(paneId, bytes);

      const cur = this.sessions.get(sessionId);
      if (!cur) return;
      const curMp = cur.panes.get(paneId);
      // Si le slot a été remplacé (restart en cours) on jette le chunk plutôt
      // que de leak dans le nouveau pane.
      if (!curMp || curMp.process !== child) return;

      // Décode UTF-8 streaming pour les détecteurs (agent-state, attention,
      // OSC, URL, event). {stream:true} buffer le tail incomplet entre chunks
      // pour qu'un codepoint multi-byte coupé à la frontière ne soit pas
      // émis comme deux caractères replacement. Le decoder est par pane
      // (state isolation au restart/process-replace). Les bytes pour xterm
      // sont déjà partis dans dataBuffer — l'analyse n'est PAS sur le chemin
      // renderer.
      if (!curMp.decoder) curMp.decoder = new TextDecoder('utf-8');
      const text = curMp.decoder.decode(bytes, { stream: true });

      // Strip ANSI une seule fois et router le résultat aux consommateurs.
      // Avant : stripAnsi() appelé 3x par chunk (updateAgentState +
      // emitAttention + detectEvents) sur le même input. Sur des streams
      // d'agent (Claude Code peut sortir des centaines de chunks/s), ça
      // dominait le coût CPU du hot path.
      const stripped = stripAnsi(text);

      try {
        // Real-time : heartbeat, attention (badge), agent state (spinner UI),
        // OSC notifications (action utilisateur explicite). Ne peuvent pas
        // être throttlés sans dégrader la UX.
        this.updateHeartbeat(curMp, paneId);
        this.emitAttention(paneId, text, stripped);
        this.updateAgentState(paneId, curMp, stripped);
        for (const ev of detectOscEvents(paneId, text)) this.emit('eventDetected', ev);
        this.maybeWriteInitialInput(curMp);
        // Throttled (4Hz max) : URL detection + event detection (build/test).
        // Ces deux ne sont pas latence-sensibles (< 250ms imperceptible) et
        // dominent le coût regex sur un spew agent intense.
        this.scheduleThrottledDetectors(cur, curMp, paneId, text, stripped);
      } catch (err) {
        // Une exception dans un helper ne doit jamais tuer le main process —
        // on log et on continue pour ne pas perdre le PTY.
        log.error('[pty] onData handler threw', err);
      }
    });

    mp.exitSub = child.onExit(({ exitCode, signal }) => {
      const cur = this.sessions.get(sessionId);
      if (!cur) return;
      const curMp = cur.panes.get(paneId);
      if (curMp) {
        curMp.process = undefined;
        // Le child est mort : ses disposables sont déjà neutralisés mais on
        // les retire explicitement pour ne pas les rappeler au restart.
        curMp.dataSub = undefined;
        curMp.exitSub = undefined;
        if (curMp.idleTimer) {
          clearTimeout(curMp.idleTimer);
          curMp.idleTimer = undefined;
        }
        // Force `idle` à la sortie du process : sinon le pane resterait
        // figé sur "Generating" si l'agent meurt en plein stream.
        if (curMp.lastAgentState !== 'idle') {
          curMp.lastAgentState = 'idle';
          this.emit('paneAgentState', paneId, 'idle');
        }
      }
      ptyStats.removePane(paneId);
      // POSIX: signal=number → killed by signal (SIGTERM/SIGKILL/...). Win32:
      // signal toujours undefined (ConPTY ne propage pas les signaux). On
      // surface `exited` (exit 0 ou kill clean) vs `error` (non-zero exit).
      // Un kill manuel pendant restart → exitCode arbitraire mais le user n'a
      // pas besoin de voir "error" puisqu'on respawne juste après ; on
      // n'expose pas plus loin que le status pour l'instant.
      const killed = typeof signal === 'number' && signal > 0;
      this.updatePane(sessionId, paneId, {
        status: exitCode === 0 || killed ? 'exited' : 'error',
        exitCode
      });
    });
  }

  /** Heartbeat : tracker le dernier output pour la détection "stale".
   *  Pas de persist ici (trop fréquent) — le sessionUpdate fire ailleurs.
   *
   *  Throttle à 1Hz : avant, on clonait `session.panes` et `session.panes[paneId]`
   *  à chaque chunk PTY (centaines/s sous stream agent). Pure GC pressure car
   *  la valeur n'est de toute façon visible côté renderer que quand un autre
   *  event piggyback la session — 1s de fraîcheur suffit largement aux
   *  consommateurs (useIsTyping 600ms tick, useStaleness 30s tick). */
  private updateHeartbeat(mp: ManagedPane, paneId: PaneId): void {
    const now = Date.now();
    mp.lastDataAt = now;
    if (now - (mp.lastHeartbeatEmit ?? 0) < 1000) return;
    mp.lastHeartbeatEmit = now;
    const sessionId = this.paneToSession.get(paneId);
    if (!sessionId) return;
    const cur = this.sessions.get(sessionId);
    if (!cur) return;
    const cp0 = cur.session.panes[paneId];
    if (!cp0 || cp0.kind !== 'terminal') return;
    // Mutation in-place du champ lastOutputAt uniquement. Le pane object est
    // owned par la session managée — pas d'aliasing externe puisque l'IPC
    // structured-clone à l'émission. Évite l'alloc d'un nouveau pane object
    // à chaque tick 1Hz (1 alloc × N panes × seconds = pression GC notable
    // sur longues sessions).
    cp0.lastOutputAt = now;
  }

  /** Met à jour le tail roulant et émet une transition d'état d'agent
   *  (idle/thinking/generating/needs-input). Émission idempotente — on n'envoie
   *  un IPC que sur transition réelle. Un timer indépendant flippe en `idle`
   *  après IDLE_AFTER_MS de silence (sans nouveau chunk).
   *
   *  Le coût par chunk est O(L) avec L ≤ ~2KB (clamp du tail) + un regex test
   *  sur le tail SCAN_WINDOW (800 chars) → négligeable même sous stream. */
  private static readonly STATE_TAIL_MAX = 2048;
  /** L'appelant fournit le chunk déjà stripped (cf. onData). */
  private updateAgentState(paneId: PaneId, mp: ManagedPane, stripped: string): void {
    // Tail roulant : on append, et on ne clamp que quand le tail dépasse —
    // évite une réallocation slice() systématique dans le hot path (un
    // stream agent peut générer des centaines de chunks/s).
    const prev = mp.stateTail ?? '';
    const concat = prev + stripped;
    if (concat.length > PtyManager.STATE_TAIL_MAX) {
      mp.stateTail = concat.slice(-PtyManager.STATE_TAIL_MAX);
    } else {
      mp.stateTail = concat;
    }
    // lastDataAt est aussi mis à jour par updateHeartbeat, mais on garantit la
    // fraîcheur ici au cas où l'ordre des helpers change.
    mp.lastDataAt = Date.now();

    const next = deriveAgentState({
      tailStripped: mp.stateTail,
      msSinceLastChunk: 0
    });
    if (next !== mp.lastAgentState) {
      mp.lastAgentState = next;
      this.emit('paneAgentState', paneId, next);
    }

    // (Re)programme le timer idle. Au tick, si toujours pas de chunk reçu
    // entre-temps, on re-dérive l'état avec un delta réaliste — ce qui
    // bascule en `idle` quand le tail ne contient plus de spinner.
    if (mp.idleTimer) clearTimeout(mp.idleTimer);
    mp.idleTimer = setTimeout(() => {
      mp.idleTimer = undefined;
      const since = Date.now() - (mp.lastDataAt ?? 0);
      const after = deriveAgentState({
        tailStripped: mp.stateTail ?? '',
        msSinceLastChunk: since
      });
      if (after !== mp.lastAgentState) {
        mp.lastAgentState = after;
        this.emit('paneAgentState', paneId, after);
      }
    }, IDLE_AFTER_MS + 100);
  }

  /** Détection d'attention (style tmux) — needs-input > alert (bell) > activity.
   *  Activity throttlé à 500ms — sinon on flood quand l'agent stream.
   *  L'appelant fournit déjà `stripped` (cf. onData). */
  private emitAttention(paneId: PaneId, data: string, stripped: string): void {
    const isBell = data.includes('\x07');
    if (detectsNeedsInput(stripped)) {
      this.emit('paneAttention', paneId, 'needs-input');
      return;
    }
    if (isBell) {
      this.emit('paneAttention', paneId, 'alert');
      return;
    }
    const now = Date.now();
    const last = this.lastActivityEmit.get(paneId) ?? 0;
    if (now - last > 500) {
      this.lastActivityEmit.set(paneId, now);
      this.emit('paneAttention', paneId, 'activity');
    }
  }

  /** Détection d'URLs — merge dans recentUrls du pane et émet urlsDetected.
   *  L'appelant fournit déjà `stripped` (cf. onData). */
  /** Accumule les chunks et trigger les détecteurs URL/event à 4Hz max.
   *  Throttle car ces détecteurs (regex URL_RE, event regex patterns) sont
   *  les plus coûteux mais aucun n'est latence-critique : 250ms d'attente
   *  sur une URL détectée ou un "build success" est imperceptible pour l'UX. */
  private scheduleThrottledDetectors(
    cur: ManagedSession,
    mp: ManagedPane,
    paneId: PaneId,
    raw: string,
    stripped: string
  ): void {
    // Accumule. Cap à 16KB pour éviter qu'un flush retardé concatène un buffer
    // énorme (l'agent peut spew des MB par seconde) — on garde la tail.
    const MAX = 16_384;
    mp.detectorBuf = (mp.detectorBuf ?? '') + stripped;
    mp.detectorRawBuf = (mp.detectorRawBuf ?? '') + raw;
    if (mp.detectorBuf.length > MAX) mp.detectorBuf = mp.detectorBuf.slice(-MAX);
    if (mp.detectorRawBuf.length > MAX) mp.detectorRawBuf = mp.detectorRawBuf.slice(-MAX);
    if (mp.detectorTimer) return;
    mp.detectorTimer = setTimeout(() => {
      mp.detectorTimer = undefined;
      const stripBatch = mp.detectorBuf;
      const rawBatch = mp.detectorRawBuf;
      mp.detectorBuf = undefined;
      mp.detectorRawBuf = undefined;
      if (!stripBatch) return;
      try {
        this.processNewUrls(cur, paneId, stripBatch);
        for (const ev of detectEventsFromStripped(paneId, stripBatch))
          this.emit('eventDetected', ev);
        // detectOscEvents reste sur le raw — déjà fait inline (real-time) sur
        // chaque chunk. Pas besoin de le rejouer ici.
        void rawBatch;
      } catch (err) {
        log.error('[pty] throttled detectors threw', err);
      }
    }, 250);
  }

  private processNewUrls(cur: ManagedSession, paneId: PaneId, stripped: string): void {
    const fresh = extractUrlsFromStripped(stripped);
    if (fresh.length === 0) return;
    const cp = cur.session.panes[paneId];
    if (!cp || cp.kind !== 'terminal') return;
    const { merged, added } = mergeUrls(cp.recentUrls, fresh);
    if (added.length === 0) return;
    cur.session.panes = { ...cur.session.panes, [paneId]: { ...cp, recentUrls: merged } };
    this.persist();
    this.emit('sessionUpdate', cur.session);
    this.emit('urlsDetected', paneId, added);
  }

  /** initialInput écrit après le bootLine et un délai pour laisser l'agent
   *  s'initialiser. Idempotent : guard sur bootSent. */
  private maybeWriteInitialInput(mp: ManagedPane): void {
    if (mp.bootSent || !mp.bootWritten || !mp.pendingInitialInput) return;
    mp.bootSent = true;
    const text = mp.pendingInitialInput;
    mp.pendingInitialInput = undefined;
    mp.inputTimer = setTimeout(() => {
      mp.inputTimer = undefined;
      try {
        mp.process?.write(`${text}\r`);
      } catch (err) {
        log.debug('[pty] initialInput write failed', err);
      }
    }, 800);
  }

  /** Dispose les listeners onData/onExit du child PTY avant un kill manuel.
   *  Sans ça, lors d'un restart rapide, des chunks de l'ancien child peuvent
   *  arriver après spawn du nouveau et leak dans le buffer du nouveau pane. */
  private disposeChildSubs(mp: ManagedPane): void {
    try {
      mp.dataSub?.dispose();
    } catch {
      /* ignore */
    }
    try {
      mp.exitSub?.dispose();
    } catch {
      /* ignore */
    }
    mp.dataSub = undefined;
    mp.exitSub = undefined;
    // Reset the streaming decoder when the child goes away — a respawn opens
    // a fresh process with no continuation of the old byte stream, so any
    // buffered incomplete codepoint must be discarded.
    mp.decoder = undefined;
  }

  private updatePane(sessionId: string, paneId: PaneId, patch: Partial<TerminalPane> & { status?: PaneStatus }): void {
    const m = this.sessions.get(sessionId);
    if (!m) return;
    const cur = m.session.panes[paneId];
    if (!cur || cur.kind !== 'terminal') return;
    const updated: TerminalPane = { ...cur, ...patch };
    m.session.panes = { ...m.session.panes, [paneId]: updated };
    this.persist();
    this.emit('paneStatus', sessionId, paneId, updated);
    this.emit('sessionUpdate', m.session);
  }

  /** Debounced — coalesce les écritures rapprochées (drag de split, rename,
   *  url detection, etc.). Évite de bloquer le main thread sur des sync writes
   *  de electron-store quand des events arrivent en rafale. */
  private persistTimer: NodeJS.Timeout | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 250;
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      saveSessions(this.list());
    }, PtyManager.PERSIST_DEBOUNCE_MS);
  }
  /** Force le flush — appelé au shutdown pour ne rien perdre. */
  private flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    saveSessions(this.list());
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.shutdownCtrl.abort();
    // Persist + buffer flush AVANT de killer les PTY : un kill peut générer
    // un dernier chunk d'output qu'on jetterait sinon (cf. isShuttingDown
    // guard dans dataBuffer flush).
    this.flushPersist();
    this.dataBuffer.shutdown();
    // Récupère les PID racines avant teardown pour kill l'arbre orphelin
    // (pwsh → agent → node enfants) que ConPTY ne nettoie pas toujours sur
    // Windows quand le parent est forcefully killed.
    const rootPids: number[] = [];
    for (const m of this.sessions.values()) {
      for (const mp of m.panes.values()) {
        this.clearPaneTimers(mp);
        this.disposeChildSubs(mp);
        const pid = mp.process?.pid;
        if (typeof pid === 'number' && pid > 0) rootPids.push(pid);
        try {
          mp.process?.kill();
        } catch {
          /* déjà mort */
        }
        mp.process = undefined;
      }
    }
    // Délègue le kill récursif au stats collector qui connaît déjà l'API
    // pidtree — évite une dépendance circulaire et garde un seul propriétaire
    // de la primitive "kill tree".
    await ptyStats.killTrees(rootPids).catch((err) => {
      log.debug('[pty] killTrees failed', err);
    });
    ptyStats.shutdown();
  }
}

/** Factory — used by the PTY Host entry to own the single instance in the
 *  host process. The module-level `ptyManager` singleton is retained ONLY for
 *  existing unit tests that import it directly; production main no longer
 *  imports this module (it uses PtyHostClient). */
export function createPtyManager(): PtyManager {
  return new PtyManager();
}

export const ptyManager = new PtyManager();
