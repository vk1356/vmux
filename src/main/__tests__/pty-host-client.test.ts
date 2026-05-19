import { describe, it, expect, vi } from 'vitest';
import { PtyHostClient } from '../pty-host-client';

// Fake supervisor: captures sent requests, lets the test push events/replies.
function makeFakeSupervisor() {
  let onMsg: ((m: unknown) => void) | null = null;
  const sent: unknown[] = [];
  return {
    sup: {
      start: vi.fn().mockResolvedValue(undefined),
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (m: unknown) => void) => { onMsg = cb; },
      stop: vi.fn().mockResolvedValue(undefined)
    },
    sent,
    push: (m: unknown) => onMsg?.(m)
  };
}

describe('PtyHostClient', () => {
  it('re-emits paneData host events through its EventEmitter surface', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const seen: Array<[string, Uint8Array]> = [];
    client.on('paneData', (paneId, data) => seen.push([paneId, data]));
    push({ kind: 'paneData', paneId: 'p1', data: new Uint8Array([65]) });
    expect(seen).toEqual([['p1', new Uint8Array([65])]]);
  });

  it('proxies a method call as a HostRequest and resolves on reply', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const p = client.removeSession('s1');
    expect(sent[0]).toMatchObject({ method: 'removeSession', args: ['s1'] });
    const reqId = (sent[0] as { id: number }).id;
    push({ id: reqId, result: undefined });
    await expect(p).resolves.toBeUndefined();
  });

  it('list() returns the cached snapshot synchronously, updated on sessionUpdate', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    expect(client.list()).toEqual([]);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: {}, tree: { kind: 'leaf', paneId: 'p' }, cwd: '/', createdAt: 0, activePaneId: 'p' } });
    expect(client.list().map((s) => s.id)).toEqual(['s1']);
  });

  it('sessionForPane resolves from the cached snapshot synchronously', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: { p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 } }, tree: { kind: 'leaf', paneId: 'p1' }, cwd: '/', createdAt: 0, activePaneId: 'p1' } });
    expect(client.sessionForPane('p1')).toBe('s1');
  });
});
