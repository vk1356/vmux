import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  Bot,
  CornerDownLeft,
  Globe,
  Layers,
  Plus,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Terminal,
  X
} from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import { allPaneIds } from '@shared/tree';
import type { TerminalPane } from '@shared/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
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

export function CommandPalette({
  open,
  onClose,
  onNewSession,
  onOpenSettings
}: Props): JSX.Element | null {
  const sessions = useSessionStore((s) => s.sessions);
  const agents = useSessionStore((s) => s.agents);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const removeSession = useSessionStore((s) => s.removeSession);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items: CommandItem[] = useMemo(() => {
    const out: CommandItem[] = [];
    const active = sessions.find((s) => s.id === activeSessionId);

    out.push({
      id: 'action:new-session',
      label: 'Nouvelle session',
      hint: 'Ctrl+N',
      group: 'Actions',
      icon: <Plus size={14} />,
      run: () => {
        onClose();
        onNewSession();
      }
    });
    out.push({
      id: 'action:settings',
      label: 'Paramètres',
      hint: 'Ctrl+,',
      group: 'Actions',
      icon: <SettingsIcon size={14} />,
      run: () => {
        onClose();
        onOpenSettings();
      }
    });

    if (active && active.activePaneId) {
      out.push({
        id: 'action:split-horizontal',
        label: 'Ajouter un pane (auto-tile)',
        hint: 'Ctrl+Shift+D',
        group: 'Layout',
        icon: <SquareSplitHorizontal size={14} />,
        run: async () => {
          onClose();
          await window.cmux.panes.split({
            sessionId: active.id,
            paneId: active.activePaneId!,
            direction: 'horizontal'
          });
          await window.cmux.panes.relayout(active.id, 'tiled');
        }
      });
      out.push({
        id: 'action:split-vertical',
        label: 'Split vertical',
        hint: 'Ctrl+Shift+E',
        group: 'Layout',
        icon: <SquareSplitVertical size={14} />,
        run: async () => {
          onClose();
          await window.cmux.panes.split({
            sessionId: active.id,
            paneId: active.activePaneId!,
            direction: 'vertical'
          });
        }
      });
      out.push({
        id: 'action:tile',
        label: 'Re-tiler la session',
        hint: 'Ctrl+G',
        group: 'Layout',
        icon: <Layers size={14} />,
        run: async () => {
          onClose();
          await window.cmux.panes.relayout(active.id, 'tiled');
        }
      });
      out.push({
        id: 'action:close-pane',
        label: 'Fermer le pane actif',
        hint: 'Ctrl+Shift+W',
        group: 'Layout',
        icon: <X size={14} />,
        run: async () => {
          onClose();
          await window.cmux.panes.close(active.id, active.activePaneId!);
        }
      });
    }

    // Sessions ouvertes
    for (const s of sessions) {
      if (s.id === activeSessionId) continue;
      out.push({
        id: `session:${s.id}`,
        label: s.name,
        hint: s.branch ?? '',
        group: 'Sessions',
        searchExtras: `${s.cwd} ${s.branch ?? ''}`,
        icon: <Terminal size={14} />,
        run: () => {
          setActiveSession(s.id);
          onClose();
        }
      });
    }

    // Panes de la session active
    if (active) {
      const paneIds = allPaneIds(active.tree);
      for (const id of paneIds) {
        if (id === active.activePaneId) continue;
        const p = active.panes[id];
        if (!p) continue;
        const label =
          p.label ||
          (p.kind === 'terminal'
            ? `${(p as TerminalPane).agentId} pane`
            : `Preview ${p.url}`);
        out.push({
          id: `pane:${id}`,
          label: `Focus: ${label}`,
          hint: 'Alt+arrows',
          group: 'Panes',
          icon: <Terminal size={14} />,
          run: async () => {
            await window.cmux.panes.focus(active.id, id);
            onClose();
          }
        });
      }

      // URLs détectées
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
          hint: previewPaneId ? 'Charger dans le preview' : 'Ouvrir le preview',
          group: 'URLs détectées',
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
    }

    // Switch agent (lance une nouvelle session avec un agent spécifique)
    for (const a of agents) {
      out.push({
        id: `agent:${a.id}`,
        label: `Nouvelle session — ${a.label}`,
        hint: a.command,
        group: 'Agents',
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
      });
    }

    if (active) {
      out.push({
        id: 'action:remove-session',
        label: 'Fermer la session active',
        hint: 'Ctrl+W',
        group: 'Actions',
        icon: <X size={14} />,
        run: async () => {
          onClose();
          await window.cmux.sessions.remove(active.id);
          removeSession(active.id);
        }
      });
      out.push({
        id: 'action:restart-all',
        label: 'Redémarrer tous les panes inactifs',
        hint: '',
        group: 'Actions',
        icon: <RotateCw size={14} />,
        run: async () => {
          onClose();
          const r = await window.cmux.sessions.restartAll(active.id);
          if (r.ok && r.data) upsertSession(r.data);
        }
      });
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
    onOpenSettings
  ]);

  // Fuzzy filtering
  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items
      .map((item) => ({
        item,
        score: fuzzyScore(`${item.label} ${item.hint ?? ''} ${item.searchExtras ?? ''}`.toLowerCase(), q)
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent): void => {
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Group items by group label
  const grouped: { group: string; items: CommandItem[] }[] = [];
  for (const item of filtered) {
    const last = grouped[grouped.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else grouped.push({ group: item.group, items: [item] });
  }

  let runningIdx = 0;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <Search size={14} style={{ color: 'var(--text-dim)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tape pour chercher : sessions, panes, actions, URLs…"
          />
          <span className="palette-hint">
            <CornerDownLeft size={11} /> entrer
          </span>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">
              <Sparkles size={20} style={{ opacity: 0.5 }} />
              <div>Aucun résultat pour "{query}"</div>
            </div>
          ) : (
            grouped.map(({ group, items }) => (
              <div key={group} className="palette-group">
                <div className="palette-group-label">{group}</div>
                {items.map((item) => {
                  const idx = runningIdx++;
                  return (
                    <div
                      key={item.id}
                      data-idx={idx}
                      className={`palette-item ${idx === selected ? 'selected' : ''}`}
                      onClick={() => void item.run()}
                      onMouseEnter={() => setSelected(idx)}
                    >
                      <span className="palette-item-icon">{item.icon}</span>
                      <span className="palette-item-label">{item.label}</span>
                      {item.hint && <span className="palette-item-hint">{item.hint}</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="palette-footer">
          <span><Bot size={11} /> Command palette</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
            <span><kbd>↑</kbd><kbd>↓</kbd> nav</span>
            <span><kbd>↵</kbd> ouvrir</span>
            <span><kbd>Esc</kbd> fermer</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// Fuzzy score : 100 si match exact, +bonus selon proximité des chars.
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  if (text.includes(query)) return 100 - text.indexOf(query);
  let ti = 0;
  let score = 0;
  for (const c of query) {
    const found = text.indexOf(c, ti);
    if (found === -1) return 0;
    score += 1 / (found - ti + 1);
    ti = found + 1;
  }
  return score;
}
