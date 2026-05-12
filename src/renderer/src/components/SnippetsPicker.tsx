import {
  memo,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react';
import { Search, X, Plus, Trash2, Edit3 } from 'lucide-react';
import type { Session, Snippet } from '@shared/types';
import { pathBasename } from '@shared/utils';
import { useT } from '../i18n';

ensureDialogBackdropStyle();

interface Props {
  open: boolean;
  session: Session | null;
  onClose: () => void;
}

export function SnippetsPicker({ open, session, onClose }: Props): JSX.Element | null {
  const t = useT();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [selected, setSelected] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQuery('');
      setEditing(null);
      setSelected(0);
      void window.cmux.snippets.list().then(setSnippets);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Précalcul des haystacks lowercase (1 fois par changement de snippets).
  const indexed = useMemo(
    () =>
      snippets.map((s) => ({
        s,
        haystack: `${s.name} ${s.content} ${(s.tags ?? []).join(' ')}`.toLowerCase()
      })),
    [snippets]
  );

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return snippets;
    return indexed.filter((x) => x.haystack.includes(q)).map((x) => x.s);
  }, [indexed, deferredQuery, snippets]);

  useEffect(() => {
    setSelected(0);
  }, [deferredQuery]);

  if (!open) return null;

  const substituteVars = (content: string): string => {
    if (!session) return content;
    const activeId = session.activePaneId;
    const pane = activeId ? session.panes[activeId] : null;
    const cwd = pane?.kind === 'terminal' ? pane.cwd : session.cwd;
    return content
      .replaceAll('{{file}}', '<fichier>')
      .replaceAll('{{branch}}', session.branch ?? '<branche>')
      .replaceAll('{{cwd}}', pathBasename(cwd));
  };

  const insertSnippet = (snippet: Snippet): void => {
    if (!session?.activePaneId) {
      onClose();
      return;
    }
    const text = substituteVars(snippet.content);
    // Bracketed paste pour préserver les newlines.
    window.cmux.panes.write(session.activePaneId, `\x1b[200~${text}\x1b[201~`);
    onClose();
  };

  const newSnippet = (): void => {
    setEditing({
      id: `s-${Date.now()}`,
      name: '',
      content: '',
      tags: [],
      createdAt: Date.now()
    });
  };

  const saveEditing = async (): Promise<void> => {
    if (!editing || !editing.name.trim() || !editing.content.trim()) return;
    const next = await window.cmux.snippets.save(editing);
    setSnippets(next);
    setEditing(null);
  };

  const deleteSnippet = async (id: string): Promise<void> => {
    const next = await window.cmux.snippets.remove(id);
    setSnippets(next);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editing) return;
    // Skip si IME en cours (CJK candidate selection).
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = filtered[selected];
      if (s) insertSnippet(s);
    }
    // Esc : native cancel event.
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const activeDescendantId =
    !editing && filtered.length > 0 ? `${listId}-item-${selected}` : undefined;
  const stale = query !== deferredQuery;

  return (
    <dialog
      ref={dialogRef}
      className="palette vmux-dialog"
      style={paletteDialogStyle}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={onBackdropClick}
      aria-label={t('snippetsName')}
    >
      {editing ? (
        <>
          <div className="palette-input-row">
            <Edit3 size={14} style={{ color: 'var(--accent)' }} />
            <input
              ref={inputRef}
              placeholder={t('snippetsName')}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              style={{ flex: 1 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn-icon" onClick={() => setEditing(null)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            className="snippet-edit-content"
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            placeholder={t('snippetsContent')}
            rows={8}
          />
          <div
            className="palette-input-row"
            style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}
          >
            <input
              placeholder={t('snippetsTagsPlaceholder')}
              value={(editing.tags ?? []).join(', ')}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  tags: e.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean)
                })
              }
              autoComplete="off"
            />
            <button
              className="btn primary"
              onClick={() => void saveEditing()}
              disabled={!editing.name.trim() || !editing.content.trim()}
            >
              {t('snippetsSave')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="palette-input-row">
            <Search size={14} style={{ color: 'var(--text-dim)' }} />
            <label htmlFor={inputId} className="sr-only" style={visuallyHidden}>
              {t('palettePlaceholder')}
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('palettePlaceholder')}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeDescendantId}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn-icon" onClick={newSnippet} title={t('snippetsNew')}>
              <Plus size={14} />
            </button>
            <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
              <X size={14} />
            </button>
          </div>
          <div
            id={listId}
            role="listbox"
            className="palette-list"
            style={{ opacity: stale ? 0.6 : 1, transition: 'opacity 80ms' }}
          >
            {filtered.length === 0 ? (
              <div className="palette-empty">
                <div>{t('snippetsEmpty')}</div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>
                  {t('snippetsEmptyHint', { plus: '+' })
                    .split('+')
                    .flatMap((part, i, arr) =>
                      i < arr.length - 1
                        ? [
                            <span key={`s${i}`}>{part}</span>,
                            <Plus key={`p${i}`} size={11} style={{ verticalAlign: '-2px' }} />
                          ]
                        : [<span key={`s${i}`}>{part}</span>]
                    )}
                </div>
              </div>
            ) : (
              filtered.map((s, i) => (
                <SnippetRow
                  key={s.id}
                  snippet={s}
                  idx={i}
                  selected={i === selected}
                  rowId={`${listId}-item-${i}`}
                  onSelect={setSelected}
                  onInsert={insertSnippet}
                  onEdit={setEditing}
                  onDelete={deleteSnippet}
                  editLabel={t('snippetsEdit')}
                  deleteLabel={t('snippetsDelete')}
                />
              ))
            )}
          </div>
          <div className="palette-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> nav
            </span>
            <span>
              <kbd>↵</kbd> {t('snippetsInsertHint')}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)' }}>
              <code>{'{{file}}'}</code> <code>{'{{branch}}'}</code> <code>{'{{cwd}}'}</code>
            </span>
          </div>
        </>
      )}
    </dialog>
  );
}

interface SnippetRowProps {
  snippet: Snippet;
  idx: number;
  selected: boolean;
  rowId: string;
  onSelect: (i: number) => void;
  onInsert: (s: Snippet) => void;
  onEdit: (s: Snippet) => void;
  onDelete: (id: string) => Promise<void>;
  editLabel: string;
  deleteLabel: string;
}

const SnippetRow = memo(function SnippetRow({
  snippet,
  idx,
  selected,
  rowId,
  onSelect,
  onInsert,
  onEdit,
  onDelete,
  editLabel,
  deleteLabel
}: SnippetRowProps): JSX.Element {
  return (
    <div
      id={rowId}
      role="option"
      aria-selected={selected}
      className={`palette-item snippet-item ${selected ? 'selected' : ''}`}
      onClick={() => onInsert(snippet)}
      onMouseEnter={() => onSelect(idx)}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="palette-item-label">{snippet.name}</div>
        <div className="snippet-content">{snippet.content}</div>
        {snippet.tags && snippet.tags.length > 0 && (
          <div className="snippet-tags">
            {snippet.tags.map((tag) => (
              <span key={tag} className="snippet-tag">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="snippet-actions">
        <button
          className="btn-icon"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(snippet);
          }}
          title={editLabel}
        >
          <Edit3 size={11} />
        </button>
        <button
          className="btn-icon"
          onClick={(e) => {
            e.stopPropagation();
            void onDelete(snippet.id);
          }}
          title={deleteLabel}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
});

const paletteDialogStyle: React.CSSProperties = {
  padding: 0,
  border: 0,
  background: 'transparent',
  maxWidth: 'unset',
  maxHeight: 'unset',
  overflow: 'visible',
  color: 'inherit'
};

const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0
};

function ensureDialogBackdropStyle(): void {
  if (typeof document === 'undefined') return;
  const id = 'vmux-dialog-backdrop-style';
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = `
dialog.vmux-dialog { margin: auto; inset: 0; }
dialog.vmux-dialog::backdrop {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  animation: vmuxDialogBackdropFadeIn 120ms ease-out;
}
@keyframes vmuxDialogBackdropFadeIn { from { opacity: 0; } }
`;
  document.head.appendChild(el);
}
