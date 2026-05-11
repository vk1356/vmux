import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent
} from 'react';
import { ChevronDown, ChevronUp, X as XIcon } from 'lucide-react';
import type { SearchAddon } from '@xterm/addon-search';
import { useT } from '../i18n';

interface Props {
  searchAddon: SearchAddon | null;
  onClose: () => void;
}

const SEARCH_DECORATIONS = {
  matchOverviewRuler: '#f97316',
  activeMatchColorOverviewRuler: '#fb923c'
} as const;

/**
 * Pré-valide une chaîne de recherche regex. xterm SearchAddon tolère les
 * patterns plain text, mais si l'option regex est utilisée plus tard, une regex
 * invalide jetterait au runtime. On valide en amont pour pouvoir afficher un
 * état "invalide" et bloquer le findNext/findPrev sans exception.
 */
function isValidRegex(s: string): boolean {
  if (!s) return true;
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Barre de recherche xterm — extraite de TerminalPane.tsx pour faire baisser
 * la taille du composant principal et permettre une mémoisation propre.
 *
 * Comportement : Enter = next, Shift+Enter = previous, Esc = close.
 * Live search (highlight passif) via useDeferredValue — pas de spam à chaque
 * keystroke, React laisse le main thread respirer entre les frappes.
 */
export function TerminalSearchBar({ searchAddon, onClose }: Props): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const valid = useMemo(() => isValidRegex(query), [query]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live highlight quand l'input est stable depuis ~1 frame (deferredQuery).
  // On garde Enter pour naviguer entre les résultats explicitement.
  useEffect(() => {
    if (!searchAddon) return;
    if (!deferredQuery) {
      searchAddon.clearDecorations();
      return;
    }
    if (!isValidRegex(deferredQuery)) return;
    try {
      searchAddon.findNext(deferredQuery, {
        decorations: SEARCH_DECORATIONS,
        incremental: true
      });
    } catch {
      /* swallow — input invalide a déjà été signalé via `valid` */
    }
  }, [deferredQuery, searchAddon]);

  const findNext = useCallback(() => {
    if (!query || !valid) return;
    try {
      searchAddon?.findNext(query, { decorations: SEARCH_DECORATIONS });
    } catch {
      /* no-op */
    }
  }, [query, valid, searchAddon]);

  const findPrev = useCallback(() => {
    if (!query || !valid) return;
    try {
      searchAddon?.findPrevious(query, { decorations: SEARCH_DECORATIONS });
    } catch {
      /* no-op */
    }
  }, [query, valid, searchAddon]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) findPrev();
        else findNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [findNext, findPrev, onClose]
  );

  return (
    <div className="terminal-search">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('palettePlaceholder')}
        aria-invalid={!valid}
        aria-label={t('palettePlaceholder')}
        // Hint visuel d'invalidité via aria + style minimal — pas de CSS dédié
        // dans le scope, on garde border rouge inline.
        style={!valid ? { borderColor: '#ef4444' } : undefined}
      />
      <button
        className="btn-icon"
        onClick={findPrev}
        title={t('searchPrev')}
        disabled={!valid || !query}
        aria-label={t('searchPrev')}
      >
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        className="btn-icon"
        onClick={findNext}
        title={t('searchNext')}
        disabled={!valid || !query}
        aria-label={t('searchNext')}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      <button
        className="btn-icon"
        onClick={onClose}
        title={t('searchClose')}
        aria-label={t('searchClose')}
      >
        <XIcon size={14} aria-hidden />
      </button>
    </div>
  );
}
