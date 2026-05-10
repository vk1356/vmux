import { describe, expect, it } from 'vitest';
import { detectsNeedsInput } from '../needs-input-detect';

describe('detectsNeedsInput', () => {
  it('matches (y/n) confirmation', () => {
    expect(detectsNeedsInput('Continue? (y/n)')).toBe(true);
    expect(detectsNeedsInput('Proceed (Y/n) ')).toBe(true);
  });

  it('matches [Y/n] bracketed prompts', () => {
    expect(detectsNeedsInput('Install dependencies? [Y/n]')).toBe(true);
  });

  it('matches "press any key"', () => {
    expect(detectsNeedsInput('Press any key to continue...')).toBe(true);
    expect(detectsNeedsInput('press enter key')).toBe(true);
  });

  it('matches Claude Code numbered choice cursor (❯ 1.)', () => {
    expect(detectsNeedsInput('❯ 1. Yes, proceed\n  2. No, cancel')).toBe(true);
  });

  it('matches "Do you want to proceed?"', () => {
    expect(detectsNeedsInput('Do you want to proceed with this change?')).toBe(true);
  });

  it('matches "requires approval"', () => {
    expect(detectsNeedsInput('This action requires approval')).toBe(true);
  });

  it('matches FR confirm', () => {
    expect(detectsNeedsInput('Continuer ?')).toBe(true);
  });

  it('does not falsely match running output', () => {
    expect(detectsNeedsInput('Compiling 32 modules...')).toBe(false);
    expect(detectsNeedsInput('vite v8.0.11 building...')).toBe(false);
  });

  it('only scans the tail of long outputs', () => {
    // Pattern noyé loin du tail (>200 chars) → ne doit pas matcher
    const noise = 'x'.repeat(500);
    expect(detectsNeedsInput(`Continue? (y/n)${noise}`)).toBe(false);
    // Pattern dans le tail → match
    expect(detectsNeedsInput(`${noise}Continue? (y/n)`)).toBe(true);
  });

  it('handles empty input', () => {
    expect(detectsNeedsInput('')).toBe(false);
  });
});
