import { describe, expect, it, beforeEach } from 'vitest';
import { clearDetector, detectEvents } from '../event-detector';

describe('detectEvents', () => {
  beforeEach(() => clearDetector('test-pane'));

  it('detects server-ready', () => {
    const events = detectEvents('test-pane', 'Local: http://localhost:5173/ ready in 320ms');
    expect(events.length).toBeGreaterThanOrEqual(1);
    const serverReady = events.find((e) => e.kind === 'server-ready');
    expect(serverReady).toBeDefined();
    expect(serverReady?.url).toMatch(/localhost:5173/);
  });

  it('detects build-success', () => {
    const events = detectEvents('test-pane', 'webpack compiled successfully');
    expect(events.find((e) => e.kind === 'build-success')).toBeDefined();
  });

  it('detects build-error', () => {
    const events = detectEvents('test-pane', 'Failed to compile');
    expect(events.find((e) => e.kind === 'build-error')).toBeDefined();
  });

  it('detects test-results passing', () => {
    const events = detectEvents('test-pane', '12 passing');
    expect(events.find((e) => e.kind === 'test-results')).toBeDefined();
  });

  it('detects agent-done', () => {
    const events = detectEvents('test-pane', 'Completed in 12.4s');
    expect(events.find((e) => e.kind === 'agent-done')).toBeDefined();
  });

  it('dedupes the same message within 2s', () => {
    detectEvents('test-pane', 'webpack compiled successfully');
    const second = detectEvents('test-pane', 'webpack compiled successfully');
    expect(second.find((e) => e.kind === 'build-success')).toBeUndefined();
  });

  it('treats different panes independently', () => {
    detectEvents('pane-1', 'webpack compiled successfully');
    const r = detectEvents('pane-2', 'webpack compiled successfully');
    expect(r.find((e) => e.kind === 'build-success')).toBeDefined();
    clearDetector('pane-1');
    clearDetector('pane-2');
  });

  it('does not falsely match build-error inside test results', () => {
    const events = detectEvents('test-pane', '12 tests passing 0 failing');
    expect(events.find((e) => e.kind === 'build-error')).toBeUndefined();
  });

  it('returns empty array on irrelevant text', () => {
    expect(detectEvents('test-pane', 'foo bar baz')).toEqual([]);
  });
});
