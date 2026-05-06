import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../cli-args';

describe('parseCliArgs', () => {
  it('returns none when no args', () => {
    expect(parseCliArgs(['vmux.exe'])).toEqual({ kind: 'none' });
  });

  it('returns help for help/--help/-h', () => {
    expect(parseCliArgs(['vmux.exe', 'help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['vmux.exe', '--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['vmux.exe', '-h'])).toEqual({ kind: 'help' });
  });

  it('returns focus for `focus`', () => {
    expect(parseCliArgs(['vmux.exe', 'focus'])).toEqual({ kind: 'focus' });
  });

  it('returns hidden when --hidden flag present', () => {
    expect(parseCliArgs(['vmux.exe', '--hidden'])).toEqual({ kind: 'hidden' });
  });

  it('parses new with --agent and optional flags', () => {
    const r = parseCliArgs([
      'vmux.exe',
      'new',
      '--agent',
      'claude-code',
      '--prompt',
      'fix bug',
      '--cwd',
      'C:\\repos\\app'
    ]);
    expect(r).toEqual({
      kind: 'new',
      agentId: 'claude-code',
      prompt: 'fix bug',
      cwd: 'C:\\repos\\app',
      name: undefined
    });
  });

  it('parses --flag=value form', () => {
    const r = parseCliArgs(['vmux.exe', 'new', '--agent=codex', '--name=my session']);
    expect(r).toMatchObject({ kind: 'new', agentId: 'codex', name: 'my session' });
  });

  it('returns none when --agent has no value', () => {
    // Régression : `vmux new --agent` sans valeur retournait { kind: 'new', agentId: undefined }
    // ce qui crashait downstream. Maintenant on tombe en 'none'.
    expect(parseCliArgs(['vmux.exe', 'new', '--agent'])).toEqual({ kind: 'none' });
  });

  it('returns none when --agent value is another flag', () => {
    // Ex: `vmux new --agent --prompt foo` — sans bounds check, on prenait
    // '--prompt' comme valeur d'agent, échec validation VALID_AGENTS → none.
    // Avec bounds check, on retourne directement undefined côté readFlag → none.
    expect(parseCliArgs(['vmux.exe', 'new', '--agent', '--prompt', 'foo'])).toEqual({
      kind: 'none'
    });
  });

  it('rejects invalid agent', () => {
    expect(parseCliArgs(['vmux.exe', 'new', '--agent', 'bogus-agent'])).toEqual({ kind: 'none' });
  });

  it('accepts shell agent', () => {
    const r = parseCliArgs(['vmux.exe', 'new', '-a', 'shell']);
    expect(r).toMatchObject({ kind: 'new', agentId: 'shell' });
  });
});
