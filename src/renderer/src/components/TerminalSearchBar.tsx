import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
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
 * Barre de recherche xterm — extraite de TerminalPane.tsx pour faire baisser
 * la taille du composant principal et permettre une mémoisation propre.
 *
 * Comportement : Enter = next, Shift+Enter = previous, Esc = close.
 */
export function TerminalSearchBar({ searchAddon, onClose }: Props): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const findNext = useCallback(() => {
    if (query) searchAddon?.findNext(query, { decorations: SEARCH_DECORATIONS });
  }, [query, searchAddon]);

  const findPrev = useCallback(() => {
    if (query) searchAddon?.findPrevious(query, { decorations: SEARCH_DECORATIONS });
  }, [query, searchAddon]);

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
      />
      <button className="btn-icon" onClick={findPrev} title={t('searchPrev')}>
        <ChevronUp size={14} />
      </button>
      <button className="btn-icon" onClick={findNext} title={t('searchNext')}>
        <ChevronDown size={14} />
      </button>
      <button className="btn-icon" onClick={onClose} title={t('searchClose')}>
        <XIcon size={14} />
      </button>
    </div>
  );
}
