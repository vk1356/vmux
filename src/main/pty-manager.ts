import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import log from 'electron-log/main';
import type {
  AgentPreset,
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
import { extractUrls, mergeUrls, stripAnsi } from './url-detector';
import { clearDetector, detectEvents } from './event-detector';
import { ptyStats } from './pty-stats';

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
}

interface ManagedSession {
  session: Session;
  panes: Map<PaneId, ManagedPane>;
  /** Worktree à supprimer au close de la session. */
  cleanupPath?: string;
}

type Events = {
  paneData: [paneId: PaneId, data: string];
  paneStatus: [sessionId: string, paneId: PaneId, pane: TerminalPane];
  sessionUpdate: [session: Session];
  urlsDetected: [paneId: PaneId, urls: string[]];
  eventDetected: [event: DetectedEvent];
  paneAttention: [paneId: PaneId, level: 'activity' | 'alert' | 'needs-input'];
};

// Patterns qui indiquent que l'agent attend une réponse de l'utilisateur.
const NEEDS_INPUT_PATTERNS: RegExp[] = [
  // (y/n), (yes/no), [Y/n] et variantes
  /\((?:y\/n|yes\/no|Y\/N|yN|yn|Yn)\)/i,
  /\[(?:Y\/n|y\/N|yes\/no)\]/i,
  // Press any/enter key
  /press (?:any |enter |return )key/i,
  // Confirmations FR/EN
  /(?:continuer|confirm|continue|proceed)\s*\??/i,
  // Claude Code & autres TUI : prompts numérotés "Do you want to proceed?"
  // suivis d'une liste numérotée. On match juste la phrase clé.
  /do you want to (?:proceed|continue)/i,
  /requires approval/i,
  // Cursor pointer ❯ devant un choix numéroté (typique de Claude Code)
  /❯\s+\d+\.\s/,
  // "Select..." / "Choose..."
  /(?:choose|select|pick) (?:an? )?(?:option|choice|value)/i,
  /enter (?:to continue|the value|your)/i
];

function detectsNeedsInput(stripped: string): boolean {
  // Limit la fenêtre — on regarde les 200 derniers chars seulement
  const tail = stripped.length > 200 ? stripped.slice(-200) : stripped;
  return NEEDS_INPUT_PATTERNS.some((re) => re.test(tail));
}

class PtyManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  /** Buffer par pane — on agrège les chunks puis on flush à intervalle court.
   *  Réduit massivement le coût IPC quand un agent streame (ex: 100+ chunks/s). */
  private paneBuffers = new Map<PaneId, string[]>();
  private flushTimer: NodeJS.Timeout | null = null;
  /** Dernière émission d'attention 'activity' par pane — throttle 500ms. */
  private lastActivityEmit = new Map<PaneId, number>();
  /** ~125 Hz — assez fréquent pour rester fluide, assez lent pour batcher. */
  private static readonly FLUSH_INTERVAL_MS = 8;

  private bufferPaneData(paneId: PaneId, data: string): void {
    let buf = this.paneBuffers.get(paneId);
    if (!buf) {
      buf = [];
      this.paneBuffers.set(paneId, buf);
    }
    buf.push(data);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushBuffers(), PtyManager.FLUSH_INTERVAL_MS);
    }
  }

  /** Clear tous les timers en vol pour un pane (boot, fallback, initialInput). */
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
  }

  private flushBuffers(): void {
    this.flushTimer = null;
    for (const [paneId, chunks] of this.paneBuffers) {
      if (chunks.length === 0) continue;
      const combined = chunks.length === 1 ? chunks[0] : chunks.join('');
      this.paneBuffers.set(paneId, []);
      this.emit('paneData', paneId, combined);
    }
  }

  constructor() {
    super();
    for (const s of loadSessions()) {
      // À la restauration, marquer tous les panes terminaux en idle (pas de PTY vivant).
      const panes: Record<PaneId, (typeof s.panes)[string]> = {};
      for (const [pid, p] of Object.entries(s.panes)) {
        panes[pid] = p.kind === 'terminal' ? { ...p, status: 'idle', pid: undefined } : p;
      }
      const session: Session = { ...s, panes };
      const managed: ManagedSession = { session, panes: new Map() };
      this.sessions.set(s.id, managed);
    }
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).map((m) => m.session);
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
      try {
        mp.process?.kill();
      } catch {
        /* déjà mort */
      }
      clearDetector(paneId);
      ptyStats.removePane(paneId);
      this.paneBuffers.delete(paneId);
      this.lastActivityEmit.delete(paneId);
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
    this.paneBuffers.delete(paneId);
    const newTree = removePane(m.session.tree, paneId);
    if (!newTree) {
      // Plus de panes → on ferme la session entière.
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
    const session = this.findSessionByPane(paneId);
    if (!session) return;
    const mp = this.sessions.get(session.id)?.panes.get(paneId);
    try {
      mp?.process?.write(data);
    } catch (err) {
      log.debug('[pty] write failed', err);
    }
  }

  resizePane(paneId: PaneId, size: PtySize): void {
    const session = this.findSessionByPane(paneId);
    if (!session) return;
    const m = this.sessions.get(session.id);
    const mp = m?.panes.get(paneId);
    if (!mp) return;
    const cols = Math.max(2, Math.floor(size.cols));
    const rows = Math.max(2, Math.floor(size.rows));
    if (mp.lastSize?.cols === cols && mp.lastSize?.rows === rows) return;
    const isFirstResize = !mp.lastSize;
    mp.lastSize = { cols, rows };
    if (!mp.process) return;
    try {
      mp.process.resize(cols, rows);
    } catch (err) {
      log.debug('[pty] resize failed', err);
    }

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
          mp.process?.write(`\x0c${cmd}\r`);
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

  private findSessionByPane(paneId: PaneId): Session | null {
    for (const m of this.sessions.values()) {
      if (m.session.panes[paneId]) return m.session;
    }
    return null;
  }

  private spawnPane(sessionId: string, paneId: PaneId): void {
    const m = this.sessions.get(sessionId);
    if (!m) return;
    const pane = m.session.panes[paneId];
    if (!pane || pane.kind !== 'terminal') return;
    // Merge l'agent preset avec l'override utilisateur s'il existe.
    const overrides = getSettings().agentOverrides;
    const agent = resolveAgent(pane.agentId, overrides);
    if (!agent) return;
    const mp = m.panes.get(paneId) ?? {};
    m.panes.set(paneId, mp);

    const shell = getInteractiveShell();
    const env: Record<string, string> = {
      ...process.env,
      ...(agent.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PYTHONIOENCODING: 'utf-8'
    } as Record<string, string>;

    const cols = mp.lastSize?.cols ?? 120;
    const rows = mp.lastSize?.rows ?? 30;

    let child: pty.IPty;
    try {
      child = pty.spawn(shell.exe, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: pane.cwd,
        env,
        // node-pty 1.1+ : conpty.dll bundlé, plus stable que celui de l'OS
        // sur certaines builds Windows 10 < 22H2.
        useConptyDll: true,
        conptyInheritCursor: false
      });
    } catch (err) {
      log.error('[pty] spawn failed', err);
      this.updatePane(sessionId, paneId, { status: 'error', exitCode: -1 });
      this.emit(
        'paneData',
        paneId,
        `\r\n\x1b[31m[cmux] Échec du lancement du shell: ${(err as Error).message}\x1b[0m\r\n`
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
            curMp.process?.write(`\x0c${cmd}\r`);
          } catch (err) {
            log.error('[pty] fallback bootLine failed', err);
          }
        }
      }, 1000);
    }

    mp.dataSub = child.onData((data) => {
      // Batch côté main : agrège les chunks pour réduire l'overhead IPC.
      this.bufferPaneData(paneId, data);

      // Heartbeat : tracker le dernier output pour la détection "stale".
      const cur = this.sessions.get(sessionId);
      const cp0 = cur?.session.panes[paneId];
      if (cur && cp0 && cp0.kind === 'terminal') {
        cur.session.panes = {
          ...cur.session.panes,
          [paneId]: { ...cp0, lastOutputAt: Date.now() }
        };
        // Pas de persist ici (trop fréquent) — le sessionUpdate fire ailleurs.
      }
      if (!cur) return;
      const curMp = cur.panes.get(paneId);
      if (!curMp) return;

      // Détection d'attention (style tmux) — émise pour que le renderer
      // mette un indicator visuel sur le pane si non focusé.
      const stripped = stripAnsi(data);
      const isBell = data.includes('\x07');
      const needsInput = detectsNeedsInput(stripped);
      if (needsInput) {
        this.emit('paneAttention', paneId, 'needs-input');
      } else if (isBell) {
        this.emit('paneAttention', paneId, 'alert');
      } else {
        // Activity throttlé à 500ms — sinon on flood quand l'agent stream.
        const now = Date.now();
        const last = this.lastActivityEmit.get(paneId) ?? 0;
        if (now - last > 500) {
          this.lastActivityEmit.set(paneId, now);
          this.emit('paneAttention', paneId, 'activity');
        }
      }

      // Détection d'URLs
      const fresh = extractUrls(data);
      if (fresh.length > 0) {
        const cp = cur.session.panes[paneId];
        if (cp && cp.kind === 'terminal') {
          const { merged, added } = mergeUrls(cp.recentUrls, fresh);
          if (added.length > 0) {
            cur.session.panes = { ...cur.session.panes, [paneId]: { ...cp, recentUrls: merged } };
            this.persist();
            this.emit('sessionUpdate', cur.session);
            this.emit('urlsDetected', paneId, added);
          }
        }
      }

      // Détection d'événements
      const events = detectEvents(paneId, data);
      for (const ev of events) this.emit('eventDetected', ev);

      // initialInput écrit après le bootLine et un délai pour laisser
      // l'agent s'initialiser.
      if (!curMp.bootSent && curMp.bootWritten && curMp.pendingInitialInput) {
        curMp.bootSent = true;
        const text = curMp.pendingInitialInput;
        curMp.pendingInitialInput = undefined;
        curMp.inputTimer = setTimeout(() => {
          curMp.inputTimer = undefined;
          try {
            curMp.process?.write(`${text}\r`);
          } catch (err) {
            log.debug('[pty] initialInput write failed', err);
          }
        }, 800);
      }
    });

    mp.exitSub = child.onExit(({ exitCode }) => {
      const cur = this.sessions.get(sessionId);
      if (!cur) return;
      const curMp = cur.panes.get(paneId);
      if (curMp) {
        curMp.process = undefined;
        // Le child est mort : ses disposables sont déjà neutralisés mais on
        // les retire explicitement pour ne pas les rappeler au restart.
        curMp.dataSub = undefined;
        curMp.exitSub = undefined;
      }
      ptyStats.removePane(paneId);
      this.updatePane(sessionId, paneId, {
        status: exitCode === 0 ? 'exited' : 'error',
        exitCode
      });
    });
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

  private persist(): void {
    saveSessions(this.list());
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.paneBuffers.clear();
    ptyStats.shutdown();
    for (const m of this.sessions.values()) {
      for (const mp of m.panes.values()) {
        this.clearPaneTimers(mp);
        this.disposeChildSubs(mp);
        try {
          mp.process?.kill();
        } catch {
          /* déjà mort */
        }
      }
    }
  }
}

export const ptyManager = new PtyManager();
