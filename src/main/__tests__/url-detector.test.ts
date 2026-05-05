import { describe, expect, it } from 'vitest';
import { extractUrls, mergeUrls, stripAnsi } from '../url-detector';

describe('stripAnsi', () => {
  it('strips CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;2H')).toBe('');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });

  it('replaces box drawing with space', () => {
    expect(stripAnsi('a│b')).toBe('a b');
    expect(stripAnsi('a─b')).toBe('a b');
  });
});

describe('extractUrls', () => {
  it('extracts a single localhost URL', () => {
    expect(extractUrls('Local: http://localhost:5173/')).toEqual(['http://localhost:5173/']);
  });

  it('strips trailing punctuation', () => {
    expect(extractUrls('see http://localhost:3000/.')).toEqual(['http://localhost:3000/']);
  });

  it('keeps lowercase paths', () => {
    expect(extractUrls('http://localhost:8080/admin')).toEqual(['http://localhost:8080/admin']);
    expect(extractUrls('http://localhost:8080/api/v1/users')).toEqual([
      'http://localhost:8080/api/v1/users'
    ]);
  });

  it('stops at uppercase letters in path (TUI overlap)', () => {
    // Worst case: "http://localhost:8000/3.NoEsctocancel.Tabtoamend"
    // → stops at uppercase N, then /3 is short → trimmed to /
    const result = extractUrls('http://localhost:8000/3.NoEsctocancel');
    expect(result).toEqual(['http://localhost:8000/']);
  });

  it('returns an empty array on no match', () => {
    expect(extractUrls('no url here')).toEqual([]);
    expect(extractUrls('http://example.com/')).toEqual([]);
  });

  it('matches 127.0.0.1 and 0.0.0.0', () => {
    expect(extractUrls('http://127.0.0.1:3000')).toEqual(['http://127.0.0.1:3000']);
    expect(extractUrls('http://0.0.0.0:8080')).toEqual(['http://0.0.0.0:8080']);
  });

  it('dedupes within a chunk', () => {
    expect(extractUrls('http://localhost:5173/ http://localhost:5173/')).toEqual([
      'http://localhost:5173/'
    ]);
  });
});

describe('mergeUrls', () => {
  it('appends new URLs to existing list', () => {
    const r = mergeUrls(['a'], ['b', 'c']);
    expect(r.merged).toEqual(['a', 'b', 'c']);
    expect(r.added).toEqual(['b', 'c']);
  });

  it('skips duplicates', () => {
    const r = mergeUrls(['a'], ['a', 'b']);
    expect(r.merged).toEqual(['a', 'b']);
    expect(r.added).toEqual(['b']);
  });

  it('caps at 10 entries', () => {
    const existing = Array.from({ length: 9 }, (_, i) => `u${i}`);
    const r = mergeUrls(existing, ['x', 'y']);
    expect(r.merged.length).toBe(10);
    expect(r.merged[r.merged.length - 1]).toBe('y');
  });

  it('returns existing untouched if nothing new', () => {
    const r = mergeUrls(['a', 'b'], ['a']);
    expect(r.added).toEqual([]);
    expect(r.merged).toEqual(['a', 'b']);
  });
});
