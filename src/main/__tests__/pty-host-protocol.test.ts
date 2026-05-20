import { describe, it, expect } from 'vitest';
import {
  isHostEvent, isHostRequest, isHostReply, isHostControl
} from '@shared/pty-host-protocol';

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

  describe('isHostControl', () => {
    it('accepts attachDataPort envelope', () => {
      expect(isHostControl({ kind: 'attachDataPort' })).toBe(true);
    });
    it('rejects unknown control kinds', () => {
      expect(isHostControl({ kind: 'detach' })).toBe(false);
      expect(isHostControl(null)).toBe(false);
      expect(isHostControl({})).toBe(false);
    });
  });

  describe('isHostReply', () => {
    it('accepts a well-formed reply with result', () => {
      expect(isHostReply({ id: 1, result: undefined })).toBe(true);
    });
    it('accepts a well-formed reply with error', () => {
      expect(isHostReply({ id: 2, error: 'x' })).toBe(true);
    });
    it('rejects null', () => {
      expect(isHostReply(null)).toBe(false);
    });
    it('rejects an object with no numeric id', () => {
      expect(isHostReply({})).toBe(false);
    });
    it('rejects an object with a non-numeric id', () => {
      expect(isHostReply({ id: 'x' })).toBe(false);
    });
  });
});
