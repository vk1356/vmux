import { describe, it, expect } from 'vitest';
import { isHostEvent, isHostRequest } from '@shared/pty-host-protocol';

describe('pty-host-protocol guards', () => {
  it('accepts a well-formed event', () => {
    expect(isHostEvent({ kind: 'paneData', paneId: 'p1', data: new Uint8Array(1) })).toBe(true);
  });
  it('rejects a non-event', () => {
    expect(isHostEvent({ kind: 'nope' })).toBe(false);
    expect(isHostEvent(null)).toBe(false);
  });
  it('accepts a well-formed request', () => {
    expect(isHostRequest({ id: 1, method: 'writePane', args: ['p1', 'x'] })).toBe(true);
  });
  it('rejects a non-request', () => {
    expect(isHostRequest({ id: 1 })).toBe(false);
  });
});
