import { describe, expect, it } from 'vitest';
import {
  deriveAgentState,
  detectsThinking,
  IDLE_AFTER_MS
} from '../agent-state-detect';

describe('detectsThinking', () => {
  it('matches Claude Code "(esc to interrupt)"', () => {
    expect(
      detectsThinking('✻ Cogitating… (5s · 1.2k tokens · esc to interrupt)')
    ).toBe(true);
  });

  it('matches glyph + verb-ing + ellipsis', () => {
    expect(detectsThinking('✶ Pondering…')).toBe(true);
    expect(detectsThinking('* Brewing...')).toBe(true);
    expect(detectsThinking('• Thinking…')).toBe(true);
  });

  it('matches "Thinking…" on its own line', () => {
    expect(detectsThinking('\nThinking…\n')).toBe(true);
  });

  it('matches Codex "Reasoning…"', () => {
    expect(detectsThinking('\nReasoning...\n')).toBe(true);
  });

  it('does not match plain text', () => {
    expect(detectsThinking('Compiling 32 modules')).toBe(false);
    expect(detectsThinking('Hello world')).toBe(false);
  });

  it('only scans the tail (>800 chars)', () => {
    const noise = 'x'.repeat(2000);
    // Match noyé loin de la fin → pas détecté
    expect(detectsThinking(`✶ Pondering…${noise}`)).toBe(false);
    // Match dans le tail → détecté
    expect(detectsThinking(`${noise}✶ Pondering…`)).toBe(true);
  });
});

describe('deriveAgentState', () => {
  it('returns needs-input when prompt detected (priority over thinking)', () => {
    const r = deriveAgentState({
      tailStripped: '✻ Thinking… Continue? (y/n)',
      msSinceLastChunk: 0
    });
    expect(r).toBe('needs-input');
  });

  it('returns thinking when spinner active', () => {
    const r = deriveAgentState({
      tailStripped: '✻ Cogitating… (esc to interrupt)',
      msSinceLastChunk: 100
    });
    expect(r).toBe('thinking');
  });

  it('returns generating on recent activity without spinner', () => {
    const r = deriveAgentState({
      tailStripped: 'streaming response chunk',
      msSinceLastChunk: 200
    });
    expect(r).toBe('generating');
  });

  it('returns idle after IDLE_AFTER_MS of silence and no spinner', () => {
    const r = deriveAgentState({
      tailStripped: 'old prompt > ',
      msSinceLastChunk: IDLE_AFTER_MS + 500
    });
    expect(r).toBe('idle');
  });

  it('thinking spinner overrides idle timeout (long-running thought)', () => {
    // Cas réel : Claude réfléchit depuis 30s, pas de chunk depuis 5s
    // (le spinner ne re-flush pas son texte tant qu'il ne change pas).
    // Le tail contient toujours le marqueur → on reste en `thinking`.
    const r = deriveAgentState({
      tailStripped: '✻ Cogitating… (30s · esc to interrupt)',
      msSinceLastChunk: 5_000
    });
    expect(r).toBe('thinking');
  });
});
