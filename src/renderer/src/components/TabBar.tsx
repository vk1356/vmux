import { useState, type JSX, type MouseEvent } from 'react';
import { Globe, RotateCw, X, Edit3, Layers, Keyboard } from 'lucide-react';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useSessionStore } from '../store/sessions';

interface Props {
  session: Session;
  onShowShortcuts: () => void;
}

interface MenuState {
  paneId: string;
  x: number;
  y: number;
}

export function TabBar({ session, onShowShortcuts }: Props): JSX.Element {
  const agents = useSessionStore((s) => s.agents);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const paneActivity = useSessionStore((s) => s.paneActivity);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const paneIds = allPaneIds(session.tree);

  const onClickTab = async (paneId: string): Promise<void> => {
    await window.cmux.panes.focus(session.id, paneId);
  };

  const onRightClick = (e: MouseEvent, paneId: string): void => {
    e.preventDefault();
    setMenu({ paneId, x: e.clientX, y: e.clientY });
  };

  const closeMenu = (): void => setMenu(null);

  const renamePane = (paneId: string, currentLabel: string): void => {
    setRenamingPaneId(paneId);
    setRenameValue(currentLabel);
    closeMenu();
  };

  const commitRename = async (paneId: string): Promise<void> => {
    setRenamingPaneId(null);
    const r = await window.cmux.panes.rename(session.id, paneId, renameValue);
    if (r.ok && r.data) upsertSession(r.data);
  };

  const restartPane = async (paneId: string): Promise<void> => {
    closeMenu();
    await window.cmux.panes.restart(session.id, paneId);
  };

  const closePane = async (paneId: string): Promise<void> => {
    closeMenu();
    const r = await window.cmux.panes.close(session.id, paneId);
    if (r.ok && r.data) upsertSession(r.data);
  };

  return (
    <>
      <div className="tab-bar-list">
        {paneIds.map((id) => {
          const pane = session.panes[id];
          if (!pane) return null;
          const isActive = id === session.activePaneId;
          const isRenaming = renamingPaneId === id;

          let label = pane.label || '';
          let icon: JSX.Element | null = null;
          let dotClass = 'idle';
          if (pane.kind === 'terminal') {
            const term = pane as TerminalPane;
            const agent = agents.find((a) => a.id === term.agentId);
            label = label || agent?.label || term.agentId;
            dotClass = term.status;
          } else {
            label = label || hostFromUrl(pane.url);
            icon = <Globe size={11} style={{ color: 'var(--info)' }} />;
            dotClass = 'running';
          }

          const attention = paneActivity[id] ?? 'idle';

          return (
            <div
              key={id}
              className={`tab ${isActive ? 'active' : ''} attention-${attention}`}
              onClick={() => void onClickTab(id)}
              onContextMenu={(e) => onRightClick(e, id)}
              onDoubleClick={() => renamePane(id, label)}
              title="Click = focus · Double-click = renommer · Clic-droit = menu"
            >
              <span className={`session-dot ${dotClass}`} style={{ width: 7, height: 7 }} />
              {icon}
              {isRenaming ? (
                <input
                  autoFocus
                  className="tab-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => void commitRename(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(id);
                    else if (e.key === 'Escape') setRenamingPaneId(null);
                  }}
                />
              ) : (
                <span className="tab-label">{label}</span>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closePane(id);
                }}
                title="Fermer le pane"
                aria-label="Fermer"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="tab-bar-actions">
        <button
          className="btn-icon"
          onClick={onShowShortcuts}
          title="Raccourcis clavier (?)"
          aria-label="Raccourcis"
        >
          <Keyboard size={13} />
        </button>
      </div>

      {menu && (
        <>
          <div className="menu-backdrop" onClick={closeMenu} />
          <div
            className="context-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
          >
            <button
              className="context-menu-item"
              onClick={() => {
                const p = session.panes[menu.paneId];
                if (p) renamePane(menu.paneId, p.label || '');
              }}
            >
              <Edit3 size={12} /> Renommer
            </button>
            {session.panes[menu.paneId]?.kind === 'terminal' && (
              <button className="context-menu-item" onClick={() => void restartPane(menu.paneId)}>
                <RotateCw size={12} /> Redémarrer
              </button>
            )}
            <button
              className="context-menu-item danger"
              onClick={() => void closePane(menu.paneId)}
            >
              <X size={12} /> Fermer le pane
            </button>
            {paneIds.length > 1 && (
              <button
                className="context-menu-item"
                onClick={() => {
                  closeMenu();
                  void window.cmux.panes.relayout(session.id, 'tiled');
                }}
              >
                <Layers size={12} /> Re-tiler la session
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.slice(0, 24);
  }
}
