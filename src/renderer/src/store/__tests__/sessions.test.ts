import { describe, expect, it, beforeEach } from 'vitest';
import { useSessionStore, STATS_WINDOW } from '../sessions';
import type {
  AgentAvailability,
  AgentPreset,
  AppSettings,
  Session,
  SystemStatsSample
} from '@shared/types';

const mkSession = (id: string, paneId = `${id}-pane`): Session => ({
  id,
  name: `Session ${id}`,
  cwd: '/tmp',
  panes: {
    [paneId]: {
      id: paneId,
      kind: 'terminal',
      agentId: 'shell',
      status: 'running',
      cwd: '/tmp',
      createdAt: 1
    }
  },
  tree: { kind: 'leaf', paneId },
  activePaneId: paneId,
  createdAt: 1
});

/** Session à 2 panes terminal — pour exercer la purge intra-session. */
const mkTwoPaneSession = (id: string): Session => ({
  id,
  name: `Session ${id}`,
  cwd: '/tmp',
  panes: {
    [`${id}-p1`]: {
      id: `${id}-p1`,
      kind: 'terminal',
      agentId: 'shell',
      status: 'running',
      cwd: '/tmp',
      createdAt: 1
    },
    [`${id}-p2`]: {
      id: `${id}-p2`,
      kind: 'terminal',
      agentId: 'shell',
      status: 'running',
      cwd: '/tmp',
      createdAt: 1
    }
  },
  tree: {
    kind: 'split',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      { kind: 'leaf', paneId: `${id}-p1` },
      { kind: 'leaf', paneId: `${id}-p2` }
    ]
  },
  activePaneId: `${id}-p1`,
  createdAt: 1
});

const mkSettings = (): AppSettings => ({
  theme: 'dark',
  language: 'en',
  fontFamily: 'mono',
  fontSize: 14,
  defaultShell: 'pwsh',
  scrollback: 1000,
  cursorBlink: true,
  copyOnSelection: false,
  pasteOnRightClick: false,
  webglRenderer: true,
  sidebarWidth: 240,
  previewToastEnabled: true,
  previewAutoOpen: true,
  notificationsEnabled: true,
  notificationSound: 'default',
  autoLaunch: false,
  previewDefaultSplit: 0.5,
  agentOverrides: {},
  autoRestoreOnBoot: true,
  lastActiveSessionId: null,
  cdpEnabled: true,
  cdpPort: 9222,
  claudeCommandsEnabled: true
});

// Reset l'état entre les tests pour isolation.
beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    sessionsById: {},
    activeSessionId: null,
    paneActivity: {},
    paneStats: {},
    toasts: [],
    eventHistory: [],
    lastEventBySession: {},
    syncSessions: new Set(),
    dismissedPreviewSessions: new Set()
  });
});

describe('useSessionStore — sessions index', () => {
  it('setSessions populates sessionsById', () => {
    const s1 = mkSession('a');
    const s2 = mkSession('b');
    useSessionStore.getState().setSessions([s1, s2]);
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessionsById['a']).toBe(s1);
    expect(state.sessionsById['b']).toBe(s2);
  });

  it('setSessions picks first as active when none is set', () => {
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b')]);
    expect(useSessionStore.getState().activeSessionId).toBe('a');
  });

  it('setSessions preserves activeSessionId if it still exists', () => {
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b')]);
    useSessionStore.getState().setActiveSession('b');
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b'), mkSession('c')]);
    expect(useSessionStore.getState().activeSessionId).toBe('b');
  });

  it('upsertSession adds a new entry', () => {
    useSessionStore.getState().upsertSession(mkSession('a'));
    expect(useSessionStore.getState().sessionsById['a']).toBeDefined();
  });

  it('upsertSession replaces an existing entry', () => {
    const s1 = mkSession('a');
    useSessionStore.getState().setSessions([s1]);
    const renamed = { ...s1, name: 'Renamed' };
    useSessionStore.getState().upsertSession(renamed);
    expect(useSessionStore.getState().sessionsById['a'].name).toBe('Renamed');
    expect(useSessionStore.getState().sessions[0].name).toBe('Renamed');
  });

  it('removeSession drops from both sessions and sessionsById', () => {
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b')]);
    useSessionStore.getState().removeSession('a');
    const state = useSessionStore.getState();
    expect(state.sessions.find((s) => s.id === 'a')).toBeUndefined();
    expect(state.sessionsById['a']).toBeUndefined();
    expect(state.sessionsById['b']).toBeDefined();
  });

  it('removeSession switches activeSessionId to the next available', () => {
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b')]);
    useSessionStore.getState().setActiveSession('a');
    useSessionStore.getState().removeSession('a');
    expect(useSessionStore.getState().activeSessionId).toBe('b');
  });

  it('removeSession clears activeSessionId when no sessions left', () => {
    useSessionStore.getState().setSessions([mkSession('a')]);
    useSessionStore.getState().removeSession('a');
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });
});

describe('useSessionStore — patchPane', () => {
  it('updates a terminal pane and refreshes sessionsById', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    useSessionStore.getState().patchPane('a', 'a-pane', { status: 'idle' });
    const updated = useSessionStore.getState().sessionsById['a'];
    const pane = updated.panes['a-pane'];
    if (pane.kind !== 'terminal') throw new Error('expected terminal');
    expect(pane.status).toBe('idle');
  });

  it('is a noop on unknown session', () => {
    useSessionStore.getState().patchPane('nope', 'x', { status: 'idle' });
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });
});

describe('useSessionStore — attention escalation', () => {
  it('bumps from idle → activity → alert → needs-input only upward', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    useSessionStore.getState().setActiveSession('b'); // pas le pane actif
    useSessionStore.getState().bumpAttention('a-pane', 'activity');
    expect(useSessionStore.getState().paneActivity['a-pane']).toBe('activity');
    useSessionStore.getState().bumpAttention('a-pane', 'alert');
    expect(useSessionStore.getState().paneActivity['a-pane']).toBe('alert');
    // alert + activity = on garde alert (pas de redescente)
    useSessionStore.getState().bumpAttention('a-pane', 'activity');
    expect(useSessionStore.getState().paneActivity['a-pane']).toBe('alert');
    useSessionStore.getState().bumpAttention('a-pane', 'needs-input');
    expect(useSessionStore.getState().paneActivity['a-pane']).toBe('needs-input');
  });

  it('skips activity bump when pane is the active one', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    useSessionStore.getState().setActiveSession('a');
    useSessionStore.getState().bumpAttention('a-pane', 'activity');
    expect(useSessionStore.getState().paneActivity['a-pane']).toBeUndefined();
  });

  it('still bumps alert/needs-input even on the active pane', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    useSessionStore.getState().setActiveSession('a');
    useSessionStore.getState().bumpAttention('a-pane', 'needs-input');
    expect(useSessionStore.getState().paneActivity['a-pane']).toBe('needs-input');
  });

  it('clearAttention removes the entry', () => {
    useSessionStore.setState({ paneActivity: { p1: 'alert' } });
    useSessionStore.getState().clearAttention('p1');
    expect(useSessionStore.getState().paneActivity['p1']).toBeUndefined();
  });
});

describe('useSessionStore — pushStatSamples ring buffer', () => {
  it('grows up to STATS_WINDOW then shifts', () => {
    const push = (cpu: number, mem: number): void =>
      useSessionStore.getState().pushStatSamples([
        { paneId: 'p', cpu, memory: mem, timestamp: cpu, cores: 8, primed: true }
      ]);

    for (let i = 0; i < STATS_WINDOW + 5; i++) push(i, i * 1000);

    const stats = useSessionStore.getState().paneStats['p'];
    expect(stats.cpu.length).toBe(STATS_WINDOW);
    // Le plus ancien sample doit être (5) puisqu'on a poussé 0..STATS_WINDOW+4
    // et drop les 5 premiers (0,1,2,3,4).
    expect(stats.cpu[0]).toBe(5);
    // Le plus récent = STATS_WINDOW + 4
    expect(stats.cpu[stats.cpu.length - 1]).toBe(STATS_WINDOW + 4);
  });

  it('keeps last sample reference', () => {
    useSessionStore.getState().pushStatSamples([
      { paneId: 'p', cpu: 42.5, memory: 1024, timestamp: 1000, cores: 8, primed: true }
    ]);
    const last = useSessionStore.getState().paneStats['p'].last;
    expect(last).toEqual({ cpu: 42.5, memory: 1024, timestamp: 1000 });
  });

  it('handles empty samples array as noop', () => {
    useSessionStore.getState().pushStatSamples([]);
    expect(Object.keys(useSessionStore.getState().paneStats)).toHaveLength(0);
  });
});

describe('useSessionStore — toast dedup', () => {
  it('dedupes identical toasts within 3s', () => {
    const t = useSessionStore.getState().addToast;
    t({ kind: 'event', title: 'Build', body: 'OK', paneId: 'p1' });
    t({ kind: 'event', title: 'Build', body: 'OK', paneId: 'p1' });
    expect(useSessionStore.getState().toasts).toHaveLength(1);
  });

  it('does NOT dedupe toasts with different bodies', () => {
    const t = useSessionStore.getState().addToast;
    t({ kind: 'event', title: 'Build', body: 'A', paneId: 'p1' });
    t({ kind: 'event', title: 'Build', body: 'B', paneId: 'p1' });
    expect(useSessionStore.getState().toasts).toHaveLength(2);
  });
});

describe('useSessionStore — event history cap', () => {
  it('caps eventHistory at 200 entries (most recent first)', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    for (let i = 0; i < 250; i++) {
      useSessionStore.getState().recordEvent('a', {
        paneId: 'a-pane',
        kind: 'agent-done',
        message: `event ${i}`,
        timestamp: i
      });
    }
    const hist = useSessionStore.getState().eventHistory;
    expect(hist).toHaveLength(200);
    expect(hist[0].event.message).toBe('event 249');
    expect(hist[199].event.message).toBe('event 50');
  });
});

describe('useSessionStore — agents & settings', () => {
  it('setAgents replaces the agents array', () => {
    const a: AgentPreset = {
      id: 'shell',
      label: 'Shell',
      description: 'sh',
      command: 'pwsh',
      args: [],
      color: '#fff'
    };
    useSessionStore.getState().setAgents([a]);
    expect(useSessionStore.getState().agents).toEqual([a]);
  });

  it('setAgentAvailability indexes the list by id', () => {
    const list: AgentAvailability[] = [
      { id: 'shell', found: true, resolvedPath: '/bin/sh' },
      { id: 'claude-code', found: false }
    ];
    useSessionStore.getState().setAgentAvailability(list);
    const av = useSessionStore.getState().agentAvailability;
    expect(av['shell']).toEqual({ id: 'shell', found: true, resolvedPath: '/bin/sh' });
    expect(av['claude-code']).toEqual({ id: 'claude-code', found: false });
  });

  it('setSettings stores the settings object', () => {
    const s = mkSettings();
    useSessionStore.getState().setSettings(s);
    expect(useSessionStore.getState().settings).toBe(s);
  });

  it('patchSettings merges into existing settings', () => {
    useSessionStore.getState().setSettings(mkSettings());
    useSessionStore.getState().patchSettings({ fontSize: 18, theme: 'light' });
    const s = useSessionStore.getState().settings;
    expect(s?.fontSize).toBe(18);
    expect(s?.theme).toBe('light');
    // champ non patché préservé
    expect(s?.defaultShell).toBe('pwsh');
  });

  it('patchSettings is a noop (stays null) when settings is null', () => {
    useSessionStore.setState({ settings: null });
    useSessionStore.getState().patchSettings({ fontSize: 22 });
    expect(useSessionStore.getState().settings).toBeNull();
  });
});

describe('useSessionStore — reorderSessions', () => {
  it('moves a session before another', () => {
    useSessionStore
      .getState()
      .setSessions([mkSession('a'), mkSession('b'), mkSession('c')]);
    useSessionStore.getState().reorderSessions('c', 'a');
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('is a noop when source === target', () => {
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b')]);
    useSessionStore.getState().reorderSessions('a', 'a');
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('is a noop when an id is unknown', () => {
    useSessionStore.getState().setSessions([mkSession('a'), mkSession('b')]);
    useSessionStore.getState().reorderSessions('a', 'zzz');
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('useSessionStore — toggleSync', () => {
  it('adds then removes a session id on successive toggles', () => {
    useSessionStore.getState().toggleSync('a');
    expect(useSessionStore.getState().syncSessions.has('a')).toBe(true);
    useSessionStore.getState().toggleSync('a');
    expect(useSessionStore.getState().syncSessions.has('a')).toBe(false);
  });
});

describe('useSessionStore — preview dismissal', () => {
  it('dismissPreview adds the session, idempotent on repeat', () => {
    useSessionStore.getState().dismissPreview('a');
    const after1 = useSessionStore.getState().dismissedPreviewSessions;
    expect(after1.has('a')).toBe(true);
    useSessionStore.getState().dismissPreview('a');
    // No-op : même référence Set (court-circuit interne).
    expect(useSessionStore.getState().dismissedPreviewSessions).toBe(after1);
  });

  it('resetPreviewDismissal removes the session', () => {
    useSessionStore.getState().dismissPreview('a');
    useSessionStore.getState().resetPreviewDismissal('a');
    expect(useSessionStore.getState().dismissedPreviewSessions.has('a')).toBe(false);
  });

  it('resetPreviewDismissal is a noop when not dismissed', () => {
    const before = useSessionStore.getState().dismissedPreviewSessions;
    useSessionStore.getState().resetPreviewDismissal('never');
    expect(useSessionStore.getState().dismissedPreviewSessions).toBe(before);
  });
});

describe('useSessionStore — upsertSession pane purge', () => {
  it('purges paneStats/paneActivity/paneAgentState for panes removed via upsert', () => {
    const two = mkTwoPaneSession('a');
    useSessionStore.getState().setSessions([two]);
    // Seed per-pane structures for both panes.
    useSessionStore.getState().pushStatSamples([
      { paneId: 'a-p1', cpu: 1, memory: 1, timestamp: 1, cores: 8, primed: true },
      { paneId: 'a-p2', cpu: 2, memory: 2, timestamp: 2, cores: 8, primed: true }
    ]);
    useSessionStore.setState({
      paneActivity: { 'a-p1': 'alert', 'a-p2': 'activity' },
      paneAgentState: { 'a-p1': 'thinking', 'a-p2': 'generating' }
    });
    // Upsert a version of the session with p2 closed.
    const oneLeft: Session = {
      ...two,
      panes: { 'a-p1': two.panes['a-p1'] },
      tree: { kind: 'leaf', paneId: 'a-p1' },
      activePaneId: 'a-p1'
    };
    useSessionStore.getState().upsertSession(oneLeft);
    const st = useSessionStore.getState();
    expect(st.paneStats['a-p2']).toBeUndefined();
    expect(st.paneActivity['a-p2']).toBeUndefined();
    expect(st.paneAgentState['a-p2']).toBeUndefined();
    // p1 survives.
    expect(st.paneStats['a-p1']).toBeDefined();
    expect(st.paneActivity['a-p1']).toBe('alert');
    expect(st.paneAgentState['a-p1']).toBe('thinking');
  });

  it('is a noop when upserting the exact same session reference', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    const before = useSessionStore.getState().sessions;
    useSessionStore.getState().upsertSession(s);
    expect(useSessionStore.getState().sessions).toBe(before);
  });

  it('upsertSession on empty store seeds activeSessionId', () => {
    useSessionStore.getState().upsertSession(mkSession('solo'));
    expect(useSessionStore.getState().activeSessionId).toBe('solo');
  });
});

describe('useSessionStore — patchPane edge cases', () => {
  it('is a noop when the pane id does not exist', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    const before = useSessionStore.getState().sessionsById['a'];
    useSessionStore.getState().patchPane('a', 'ghost', { status: 'idle' });
    expect(useSessionStore.getState().sessionsById['a']).toBe(before);
  });

  it('is a noop when the patch changes nothing (change detection)', () => {
    const s = mkSession('a');
    useSessionStore.getState().setSessions([s]);
    const before = useSessionStore.getState().sessionsById['a'];
    // status is already 'running' → no field differs → no new object.
    useSessionStore.getState().patchPane('a', 'a-pane', { status: 'running' });
    expect(useSessionStore.getState().sessionsById['a']).toBe(before);
  });
});

describe('useSessionStore — removeToast', () => {
  it('removes a toast by id', () => {
    useSessionStore.getState().addToast({ kind: 'event', title: 'T', id: 'fixed' });
    expect(useSessionStore.getState().toasts).toHaveLength(1);
    useSessionStore.getState().removeToast('fixed');
    expect(useSessionStore.getState().toasts).toHaveLength(0);
  });

  it('is a noop (same ref) when id is absent', () => {
    useSessionStore.getState().addToast({ kind: 'event', title: 'T', id: 'fixed' });
    const before = useSessionStore.getState().toasts;
    useSessionStore.getState().removeToast('not-there');
    expect(useSessionStore.getState().toasts).toBe(before);
  });
});

describe('useSessionStore — markEventsRead / clearEventHistory', () => {
  it('markEventsRead stamps readAt on all unread entries', () => {
    useSessionStore.getState().setSessions([mkSession('a')]);
    useSessionStore.getState().recordEvent('a', {
      paneId: 'a-pane',
      kind: 'agent-done',
      message: 'm1',
      timestamp: 1
    });
    useSessionStore.getState().markEventsRead();
    const hist = useSessionStore.getState().eventHistory;
    expect(hist[0].readAt).toBeTypeOf('number');
  });

  it('markEventsRead is a noop (same ref) when all already read', () => {
    useSessionStore.getState().setSessions([mkSession('a')]);
    useSessionStore.getState().recordEvent('a', {
      paneId: 'a-pane',
      kind: 'agent-done',
      message: 'm1',
      timestamp: 1
    });
    useSessionStore.getState().markEventsRead();
    const ref = useSessionStore.getState().eventHistory;
    useSessionStore.getState().markEventsRead();
    expect(useSessionStore.getState().eventHistory).toBe(ref);
  });

  it('recordEvent falls back to "Session inconnue" for an unknown session', () => {
    useSessionStore.getState().recordEvent('ghost', {
      paneId: 'x',
      kind: 'agent-done',
      message: 'm',
      timestamp: 1
    });
    expect(useSessionStore.getState().eventHistory[0].sessionName).toBe('Session inconnue');
  });

  it('clearEventHistory empties the history', () => {
    useSessionStore.getState().setSessions([mkSession('a')]);
    useSessionStore.getState().recordEvent('a', {
      paneId: 'a-pane',
      kind: 'agent-done',
      message: 'm1',
      timestamp: 1
    });
    useSessionStore.getState().clearEventHistory();
    expect(useSessionStore.getState().eventHistory).toHaveLength(0);
  });

  it('clearEventHistory is a noop (same ref) when already empty', () => {
    useSessionStore.setState({ eventHistory: [] });
    const ref = useSessionStore.getState().eventHistory;
    useSessionStore.getState().clearEventHistory();
    expect(useSessionStore.getState().eventHistory).toBe(ref);
  });
});

describe('useSessionStore — setAgentState', () => {
  beforeEach(() => {
    useSessionStore.setState({ paneAgentState: {} });
  });

  it('stores non-idle states', () => {
    useSessionStore.getState().setAgentState('p', 'thinking');
    expect(useSessionStore.getState().paneAgentState['p']).toBe('thinking');
  });

  it('deletes the key when set back to idle', () => {
    useSessionStore.getState().setAgentState('p', 'generating');
    useSessionStore.getState().setAgentState('p', 'idle');
    expect('p' in useSessionStore.getState().paneAgentState).toBe(false);
  });

  it('is a noop (same ref) when value is unchanged', () => {
    useSessionStore.getState().setAgentState('p', 'thinking');
    const ref = useSessionStore.getState().paneAgentState;
    useSessionStore.getState().setAgentState('p', 'thinking');
    expect(useSessionStore.getState().paneAgentState).toBe(ref);
  });

  it('idle on an absent key is a noop (same ref)', () => {
    const ref = useSessionStore.getState().paneAgentState;
    useSessionStore.getState().setAgentState('absent', 'idle');
    expect(useSessionStore.getState().paneAgentState).toBe(ref);
  });
});

describe('useSessionStore — pushSystemStats', () => {
  beforeEach(() => {
    useSessionStore.setState({ systemStats: null, systemCpuHistory: new Float32Array(0) });
  });

  const mkSys = (cpu: number): SystemStatsSample => ({
    cpu,
    memoryUsed: 1,
    memoryTotal: 2,
    vmuxCpu: 0,
    vmuxMemory: 0,
    cores: 8,
    timestamp: cpu
  });

  it('stores the latest sample and appends cpu to the history', () => {
    useSessionStore.getState().pushSystemStats(mkSys(10));
    useSessionStore.getState().pushSystemStats(mkSys(20));
    const st = useSessionStore.getState();
    expect(st.systemStats?.cpu).toBe(20);
    expect(Array.from(st.systemCpuHistory)).toEqual([10, 20]);
  });

  it('grows up to STATS_WINDOW then shifts oldest out', () => {
    for (let i = 0; i < STATS_WINDOW + 3; i++) {
      useSessionStore.getState().pushSystemStats(mkSys(i));
    }
    const h = useSessionStore.getState().systemCpuHistory;
    expect(h.length).toBe(STATS_WINDOW);
    expect(h[0]).toBe(3);
    expect(h[h.length - 1]).toBe(STATS_WINDOW + 2);
  });
});

describe('useSessionStore — removeSession pane purge', () => {
  it('purges per-pane structures for every pane of the removed session', () => {
    const two = mkTwoPaneSession('a');
    useSessionStore.getState().setSessions([two]);
    useSessionStore.getState().pushStatSamples([
      { paneId: 'a-p1', cpu: 1, memory: 1, timestamp: 1, cores: 8, primed: true }
    ]);
    useSessionStore.setState({
      paneActivity: { 'a-p1': 'alert' },
      paneAgentState: { 'a-p2': 'thinking' }
    });
    useSessionStore.getState().removeSession('a');
    const st = useSessionStore.getState();
    expect(st.paneStats['a-p1']).toBeUndefined();
    expect(st.paneActivity['a-p1']).toBeUndefined();
    expect(st.paneAgentState['a-p2']).toBeUndefined();
  });
});
