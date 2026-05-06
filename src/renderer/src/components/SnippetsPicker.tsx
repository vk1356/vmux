import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Search, X, Plus, Trash2, Edit3 } from 'lucide-react';
import type { Session, Snippet } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { pathBasename } from '@shared/utils';
import { useT } from '../i18n';

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setEditing(null);
    setSelected(0);
    void window.cmux.snippets.list().then(setSnippets);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) return snippets;
    const q = query.toLowerCase();
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.content.toLowerCase().includes(q) ||
        (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }, [snippets, query]);

  useEffect(() => setSelected(0), [query]);

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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
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
            <div className="palette-input-row" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
              <input
                placeholder={t('snippetsTagsPlaceholder')}
                value={(editing.tags ?? []).join(', ')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    tags: e.target.value.split(',').map((tag) => tag.trim()).filter(Boolean)
                  })
                }
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
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('palettePlaceholder')}
              />
              <button className="btn-icon" onClick={newSnippet} title={t('snippetsNew')}>
                <Plus size={14} />
              </button>
              <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
                <X size={14} />
              </button>
            </div>
            <div className="palette-list">
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
                              <Plus
                                key={`p${i}`}
                                size={11}
                                style={{ verticalAlign: '-2px' }}
                              />
                            ]
                          : [<span key={`s${i}`}>{part}</span>]
                      )}
                  </div>
                </div>
              ) : (
                filtered.map((s, i) => (
                  <div
                    key={s.id}
                    className={`palette-item snippet-item ${i === selected ? 'selected' : ''}`}
                    onClick={() => insertSnippet(s)}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="palette-item-label">{s.name}</div>
                      <div className="snippet-content">{s.content}</div>
                      {s.tags && s.tags.length > 0 && (
                        <div className="snippet-tags">
                          {s.tags.map((tag) => (
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
                          setEditing(s);
                        }}
                        title={t('snippetsEdit')}
                      >
                        <Edit3 size={11} />
                      </button>
                      <button
                        className="btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteSnippet(s.id);
                        }}
                        title={t('snippetsDelete')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="palette-footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> nav</span>
              <span>
                <kbd>↵</kbd> {t('snippetsInsertHint')}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)' }}>
                <code>{'{{file}}'}</code> <code>{'{{branch}}'}</code>{' '}
                <code>{'{{cwd}}'}</code>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
