import { describe, expect, it, beforeEach } from 'vitest';
import { useSessionStore, STATS_WINDOW } from '../sessions';
import type { Session } from '@shared/types';

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
        { paneId: 'p', cpu, memory: mem, timestamp: cpu }
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
      { paneId: 'p', cpu: 42.5, memory: 1024, timestamp: 1000 }
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
