import { describe, expect, it } from 'vitest';
import { detectOscEvents, parseOsc } from '../osc-detector';

describe('parseOsc', () => {
  it('parses OSC 9 with BEL terminator', () => {
    const out = [...parseOsc('\x1b]9;Hello\x07')];
    expect(out).toEqual([{ ps: '9', pt: 'Hello' }]);
  });

  it('parses OSC 9 with ST (ESC \\) terminator', () => {
    const out = [...parseOsc('\x1b]9;Hello\x1b\\')];
    expect(out).toEqual([{ ps: '9', pt: 'Hello' }]);
  });

  it('parses OSC 777 with title and body', () => {
    const out = [...parseOsc('\x1b]777;notify;Build done;42 tests passed\x07')];
    expect(out).toEqual([{ ps: '777', pt: 'notify;Build done;42 tests passed' }]);
  });

  it('parses multiple OSCs in one chunk', () => {
    const chunk =
      'foo\x1b]9;First\x07bar\x1b]777;notify;Title;Body\x07baz';
    const out = [...parseOsc(chunk)];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ ps: '9', pt: 'First' });
    expect(out[1]).toEqual({ ps: '777', pt: 'notify;Title;Body' });
  });

  it('ignores OSC without terminator', () => {
    // OSC ouvert mais jamais fermé (chunk coupé en plein OSC) → on skip plutôt
    // que de laisser un état "en cours" qui leakerait au chunk suivant.
    const out = [...parseOsc('\x1b]9;Unfinished message')];
    expect(out).toEqual([]);
  });

  it('skips payloads larger than MAX_OSC_PAYLOAD', () => {
    const big = 'x'.repeat(3000);
    const out = [...parseOsc(`\x1b]9;${big}\x07suffix\x1b]9;ok\x07`)];
    // Le 1er OSC est skippé (>2KB), le 2nd doit toujours être détecté.
    expect(out).toEqual([{ ps: '9', pt: 'ok' }]);
  });

  it('returns nothing for chunks without OSC', () => {
    const out = [...parseOsc('plain text with \x1b[31mcolor\x1b[0m only')];
    expect(out).toEqual([]);
  });
});

describe('detectOscEvents', () => {
  it('emits a notify event for OSC 9', () => {
    const events = detectOscEvents('pane-1', '\x1b]9;Build complete\x07');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      paneId: 'pane-1',
      kind: 'notify',
      title: 'Build complete',
      message: ''
    });
  });

  it('emits a notify event for OSC 777 with title + body', () => {
    const events = detectOscEvents(
      'pane-2',
      '\x1b]777;notify;Tests passed;42/42\x07'
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      paneId: 'pane-2',
      kind: 'notify',
      title: 'Tests passed',
      message: '42/42'
    });
  });

  it('skips OSC 9;4 (iTerm progress) — pas une notif user', () => {
    // \x1b]9;4;1;50\x07 = progress 50% ; ne doit pas générer de toast.
    const events = detectOscEvents('p', '\x1b]9;4;1;50\x07');
    expect(events).toEqual([]);
  });

  it('skips OSC 777 sub-types autres que notify', () => {
    // OSC 777 a aussi des sous-types comme dynamic_color qu'on ne veut pas remonter.
    const events = detectOscEvents('p', '\x1b]777;dynamic_color;1;#ff0000\x07');
    expect(events).toEqual([]);
  });

  it('skips empty messages', () => {
    expect(detectOscEvents('p', '\x1b]9;\x07')).toEqual([]);
    expect(detectOscEvents('p', '\x1b]777;notify;;body\x07')).toEqual([]);
  });

  it('handles multiple notifs in one chunk + interspersed text', () => {
    const chunk =
      'normal output\r\n' +
      '\x1b]9;First alert\x07' +
      'more output\r\n' +
      '\x1b]777;notify;Second;with body\x07' +
      'tail';
    const events = detectOscEvents('pane-x', chunk);
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('First alert');
    expect(events[1].title).toBe('Second');
    expect(events[1].message).toBe('with body');
  });

  it('truncates long titles and bodies', () => {
    const longTitle = 'A'.repeat(500);
    const longBody = 'B'.repeat(500);
    const [event] = detectOscEvents(
      'p',
      `\x1b]777;notify;${longTitle};${longBody}\x07`
    );
    expect(event.title?.length).toBeLessThanOrEqual(120);
    expect(event.message.length).toBeLessThanOrEqual(240);
  });

  it('fast-paths chunks without OSC marker', () => {
    // Aucun ESC ] dans le chunk → retourne [] sans tenter de parser.
    const events = detectOscEvents('p', 'completely plain text without escapes');
    expect(events).toEqual([]);
  });
});
