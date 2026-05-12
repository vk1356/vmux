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
import {
  Bot,
  CornerDownLeft,
  Globe,
  Layers,
  Plus,
  RotateCw,
  Search,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Terminal,
  X
} from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { allPaneIds } from '@shared/tree';
import type { AgentPreset, Session, TerminalPane } from '@shared/types';
import { useT, type TFunction } from '../i18n';

// Style ::backdrop injecté une seule fois — voir ConfirmDialog pour le rationale.
ensureDialogBackdropStyle();

interface Props {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: JSX.Element;
  /** Tokens additionnels pour le matching fuzzy (non affichés). */
  searchExtras?: string;
  run: () => void | Promise<void>;
}

// ============================================================
// Builders d'items — chacun renvoie le sous-array correspondant à sa famille.
// Découpés depuis l'ancien useMemo de 220 lignes pour rendre l'évolution
// par famille (panes / sessions / urls / agents) localisée.
// ============================================================

function buildAppActions(
  t: TFunction,
  onClose: () => void,
  onNewSession: () => void,
  onOpenSettings: () => void,
  onOpenMcp: () => void
): CommandItem[] {
  return [
    {
      id: 'action:new-session',
      label: t('cmdNewSession'),
      hint: 'Ctrl+N',
      group: t('cmdGroupOther'),
      icon: <Plus size={14} />,
      run: () => {
        onClose();
        onNewSession();
      }
    },
    {
      id: 'action:settings',
      label: t('cmdSettings'),
      hint: 'Ctrl+,',
      group: t('cmdGroupOther'),
      icon: <SettingsIcon size={14} />,
      run: () => {
        onClose();
        onOpenSettings();
      }
    },
    {
      id: 'action:mcp',
      label: t('cmdMcpServers'),
      group: t('cmdGroupOther'),
      icon: <Server size={14} />,
      run: () => {
        onClose();
        onOpenMcp();
      }
    }
  ];
}

function buildPaneActions(t: TFunction, active: Session, onClose: () => void): CommandItem[] {
  if (!active.activePaneId) return [];
  const sid = active.id;
  const pid = active.activePaneId;
  return [
    {
      id: 'action:split-horizontal',
      label: t('shortcutsItemAddPane'),
      hint: 'Ctrl+Shift+D',
      group: t('cmdGroupPanes'),
      icon: <SquareSplitHorizontal size={14} />,
      run: async () => {
        onClose();
        await window.cmux.panes.split({ sessionId: sid, paneId: pid, direction: 'horizontal' });
        await window.cmux.panes.relayout(sid, 'tiled');
      }
    },
    {
      id: 'action:split-vertical',
      label: t('cmdSplitVertical'),
      hint: 'Ctrl+Shift+E',
      group: t('cmdGroupPanes'),
      icon: <SquareSplitVertical size={14} />,
      run: async () => {
        onClose();
        await window.cmux.panes.split({ sessionId: sid, paneId: pid, direction: 'vertical' });
      }
    },
    {
      id: 'action:tile',
      label: t('cmdRetile'),
      hint: 'Ctrl+G',
      group: t('cmdGroupPanes'),
      icon: <Layers size={14} />,
      run: async () => {
        onClose();
        await window.cmux.panes.relayout(sid, 'tiled');
      }
    },
    {
      id: 'action:close-pane',
      label: t('shortcutsItemClosePane'),
      hint: 'Ctrl+Shift+W',
      group: t('cmdGroupPanes'),
      icon: <X size={14} />,
      run: async () => {
        onClose();
        await window.cmux.panes.close(sid, pid);
      }
    }
  ];
}

function buildSessionItems(
  t: TFunction,
  sessions: Session[],
  activeSessionId: string | null,
  setActiveSession: (id: string) => void,
  onClose: () => void
): CommandItem[] {
  const out: CommandItem[] = [];
  for (const s of sessions) {
    if (s.id === activeSessionId) continue;
    out.push({
      id: `session:${s.id}`,
      label: s.name,
      hint: s.branch ?? '',
      group: t('cmdGroupSessions'),
      searchExtras: `${s.cwd} ${s.branch ?? ''}`,
      icon: <Terminal size={14} />,
      run: () => {
        setActiveSession(s.id);
        onClose();
      }
    });
  }
  return out;
}

function buildPaneItems(t: TFunction, active: Session, onClose: () => void): CommandItem[] {
  const out: CommandItem[] = [];
  for (const id of allPaneIds(active.tree)) {
    if (id === active.activePaneId) continue;
    const p = active.panes[id];
    if (!p) continue;
    const label =
      p.label ||
      (p.kind === 'terminal' ? `${(p as TerminalPane).agentId} pane` : `Preview ${p.url}`);
    out.push({
      id: `pane:${id}`,
      label: `Focus: ${label}`,
      hint: 'Alt+arrows',
      group: t('cmdGroupPanes'),
      icon: <Terminal size={14} />,
      run: async () => {
        await window.cmux.panes.focus(active.id, id);
        onClose();
      }
    });
  }
  return out;
}

function buildUrlItems(t: TFunction, active: Session, onClose: () => void): CommandItem[] {
  const out: CommandItem[] = [];
  const paneIds = allPaneIds(active.tree);
  const urls = new Set<string>();
  for (const id of paneIds) {
    const p = active.panes[id];
    if (p?.kind === 'terminal') {
      for (const u of (p as TerminalPane).recentUrls ?? []) urls.add(u);
    }
  }
  const previewPaneId = Object.values(active.panes).find((p) => p.kind === 'preview')?.id;
  let i = 0;
  for (const url of urls) {
    out.push({
      id: `url:${i++}`,
      label: url,
      hint: t('toastOpenPreview'),
      group: t('cmdGroupUrls'),
      icon: <Globe size={14} style={{ color: 'var(--info)' }} />,
      run: async () => {
        onClose();
        if (previewPaneId) {
          await window.cmux.panes.setUrl(active.id, previewPaneId, url);
        } else {
          const tp = paneIds
            .map((pid) => active.panes[pid])
            .find((p): p is TerminalPane => p?.kind === 'terminal');
          if (tp) await window.cmux.panes.openPreview(active.id, tp.id, url);
        }
      }
    });
  }
  return out;
}

function buildAgentItems(
  t: TFunction,
  agents: AgentPreset[],
  onClose: () => void,
  onNewSession: () => void
): CommandItem[] {
  return agents.map((a) => ({
    id: `agent:${a.id}`,
    label: t('cmdLaunchAgent', { agent: a.label }),
    hint: a.command,
    group: t('cmdGroupAgents'),
    searchExtras: a.description,
    icon: (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 4,
          background: a.color,
          display: 'inline-block'
        }}
      />
    ),
    run: () => {
      // On ouvre la dialog NewSession (l'utilisateur choisira le repo).
      onClose();
      onNewSession();
    }
  }));
}

function buildSessionFinalActions(
  t: TFunction,
  active: Session,
  onClose: () => void,
  removeSession: (id: string) => void,
  upsertSession: (s: Session) => void
): CommandItem[] {
  return [
    {
      id: 'action:remove-session',
      label: t('shortcutsItemCloseSession'),
      hint: 'Ctrl+W',
      group: t('cmdGroupOther'),
      icon: <X size={14} />,
      run: async () => {
        onClose();
        await window.cmux.sessions.remove(active.id);
        removeSession(active.id);
      }
    },
    {
      id: 'action:restart-all',
      label: t('cmdRestartIdleAll'),
      hint: '',
      group: t('cmdGroupOther'),
      icon: <RotateCw size={14} />,
      run: async () => {
        onClose();
        const r = await window.cmux.sessions.restartAll(active.id);
        if (r.ok && r.data) upsertSession(r.data);
      }
    }
  ];
}

// ============================================================

export function CommandPalette({
  open,
  onClose,
  onNewSession,
  onOpenSettings,
  onOpenMcp
}: Props): JSX.Element | null {
  const t = useT();
  // useShallow : un seul subscribe, un seul re-render quand l'une des clés change.
  // Avant : 6 subscriptions séparées → re-render à chaque update du store
  // (paneActivity, toasts, stats toutes les 2s).
  const { sessions, agents, activeSessionId, setActiveSession, upsertSession, removeSession } =
    useSessionStore(
      useShallow((s) => ({
        sessions: s.sessions,
        agents: s.agents,
        activeSessionId: s.activeSessionId,
        setActiveSession: s.setActiveSession,
        upsertSession: s.upsertSession,
        removeSession: s.removeSession
      }))
    );

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  // Defer le query pour le filtrage : la frappe reste 100% urgente (input fluide),
  // le filtrage de la liste s'exécute quand le main thread est libre.
  const deferredQuery = useDeferredValue(query);
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // showModal/close : focus-trap + restore-focus à l'opener sont gratuits côté natif.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQuery('');
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const items: CommandItem[] = useMemo(() => {
    const active = sessions.find((s) => s.id === activeSessionId);
    const out: CommandItem[] = [
      ...buildAppActions(t, onClose, onNewSession, onOpenSettings, onOpenMcp)
    ];
    if (active) out.push(...buildPaneActions(t, active, onClose));
    out.push(...buildSessionItems(t, sessions, activeSessionId, setActiveSession, onClose));
    if (active) {
      out.push(...buildPaneItems(t, active, onClose));
      out.push(...buildUrlItems(t, active, onClose));
    }
    out.push(...buildAgentItems(t, agents, onClose, onNewSession));
    if (active) {
      out.push(...buildSessionFinalActions(t, active, onClose, removeSession, upsertSession));
    }
    return out;
  }, [
    sessions,
    agents,
    activeSessionId,
    setActiveSession,
    upsertSession,
    removeSession,
    onClose,
    onNewSession,
    onOpenSettings,
    onOpenMcp,
    t
  ]);

  // Pré-calcul des chaînes de recherche pour éviter le `toLowerCase` à chaque
  // keystroke. La table est invalidée quand `items` change (mêmes deps que items).
  const searchable = useMemo(
    () =>
      items.map((item) => ({
        item,
        haystack: `${item.label} ${item.hint ?? ''} ${item.searchExtras ?? ''}`.toLowerCase()
      })),
    [items]
  );

  // Fuzzy filter : prefix > substring > subsequence. Zero-dep, O(n*|q|).
  // On utilise deferredQuery → la frappe ne bloque pas pendant le scoring.
  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return items;
    const scored: { item: CommandItem; score: number }[] = [];
    for (const { item, haystack } of searchable) {
      const s = score(haystack, q);
      if (s > 0) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.item);
  }, [searchable, deferredQuery, items]);

  // Reset selected quand le query (deferred) change la liste filtrée.
  useEffect(() => {
    setSelected(0);
  }, [deferredQuery]);

  // Scroll selected into view (block: nearest pour éviter les jumps).
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  // Group items by group label (pré-calculé hors render pour stable mapping).
  const grouped: { group: string; items: CommandItem[] }[] = [];
  for (const item of filtered) {
    const last = grouped[grouped.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else grouped.push({ group: item.group, items: [item] });
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Skip si IME en cours (CJK candidate selection) — sinon les arrows /
    // Enter navigueraient dans la palette pendant la composition.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[selected];
      if (item) void item.run();
    }
    // Esc → géré par le native cancel event du <dialog>.
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  let runningIdx = 0;
  const activeDescendantId = filtered.length > 0 ? `${listId}-item-${selected}` : undefined;
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
      aria-labelledby={inputId}
    >
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
        <span className="palette-hint">
          <CornerDownLeft size={11} /> entrer
        </span>
      </div>
      <div
        className="palette-list"
        ref={listRef}
        id={listId}
        role="listbox"
        // Visual hint sur scoring en cours (frappe rapide) — opacité légère.
        style={{ opacity: stale ? 0.6 : 1, transition: 'opacity 80ms' }}
      >
        {filtered.length === 0 ? (
          <div className="palette-empty">
            <Sparkles size={20} style={{ opacity: 0.5 }} />
            <div>{t('paletteNoResults', { q: query })}</div>
          </div>
        ) : (
          grouped.map(({ group, items: gitems }) => (
            <div key={group} className="palette-group">
              <div className="palette-group-label">{group}</div>
              {gitems.map((item) => {
                const idx = runningIdx++;
                return (
                  <PaletteRow
                    key={item.id}
                    item={item}
                    idx={idx}
                    selected={idx === selected}
                    onSelect={setSelected}
                    rowId={`${listId}-item-${idx}`}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="palette-footer">
        <span>
          <Bot size={11} /> Command palette
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> nav
          </span>
          <span>
            <kbd>↵</kbd> ouvrir
          </span>
          <span>
            <kbd>Esc</kbd> fermer
          </span>
        </span>
      </div>
    </dialog>
  );
}

// ============================================================
// Row mémoïsée : évite de re-render toutes les rows quand seul `selected` bouge.
// Comparaison par props (selected, idx, item.id) — React.memo suffit car item
// est référentiellement stable (vient du useMemo de items).
// ============================================================

interface RowProps {
  item: CommandItem;
  idx: number;
  selected: boolean;
  onSelect: (idx: number) => void;
  rowId: string;
}

const PaletteRow = memo(function PaletteRow({
  item,
  idx,
  selected,
  onSelect,
  rowId
}: RowProps): JSX.Element {
  return (
    <div
      id={rowId}
      data-idx={idx}
      role="option"
      aria-selected={selected}
      className={`palette-item ${selected ? 'selected' : ''}`}
      onClick={() => void item.run()}
      onMouseEnter={() => onSelect(idx)}
    >
      <span className="palette-item-icon">{item.icon}</span>
      <span className="palette-item-label">{item.label}</span>
      {item.hint && <span className="palette-item-hint">{item.hint}</span>}
    </div>
  );
});

// ============================================================
// Scoring fuzzy : prefix > word-prefix > contains > subsequence.
// Plage : 0 (no match) → ~10000 (prefix exact).
// ============================================================
function score(text: string, q: string): number {
  if (!q) return 1;
  if (text.startsWith(q)) return 10000;
  // Mot commençant par q (après espace) → quasi prefix.
  const wordPrefix = text.indexOf(' ' + q);
  if (wordPrefix !== -1) return 8000 - wordPrefix;
  const idx = text.indexOf(q);
  if (idx !== -1) return 5000 - idx;
  // Subsequence : chaque char trouvé dans l'ordre.
  let ti = 0;
  let s = 0;
  for (const c of q) {
    const found = text.indexOf(c, ti);
    if (found === -1) return 0;
    s += 1 / (found - ti + 1);
    ti = found + 1;
  }
  return s;
}

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
