import { useMemo, useState, type JSX, type MouseEvent } from 'react';
import { Globe, RotateCw, X, Edit3, Layers, Keyboard } from 'lucide-react';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { hostFromUrl } from '@shared/utils';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../i18n';

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
  const t = useT();
  const { agents, upsertSession, paneActivity, eventHistory } = useSessionStore(
    useShallow((s) => ({
      agents: s.agents,
      upsertSession: s.upsertSession,
      paneActivity: s.paneActivity,
      eventHistory: s.eventHistory
    }))
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const paneIds = allPaneIds(session.tree);

  // Compteur d'events non lus par pane — calculé une fois par render plutôt
  // que par tab. Filtre sur la session courante uniquement.
  const unreadByPane = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of eventHistory) {
      if (e.readAt) continue;
      if (e.sessionId !== session.id) continue;
      out[e.event.paneId] = (out[e.event.paneId] ?? 0) + 1;
    }
    return out;
  }, [eventHistory, session.id]);

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
          const unread = unreadByPane[id] ?? 0;

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
              {unread > 0 && (
                <span
                  className="tab-unread"
                  title={`${unread} événement${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}`}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closePane(id);
                }}
                title={t('paneCloseTitle')}
                aria-label={t('paneCloseAria')}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="tab-bar-actions">
        <button
          className="tab-shortcuts-btn"
          onClick={onShowShortcuts}
          title="Raccourcis clavier — appuie sur ?"
          aria-label="Raccourcis clavier"
        >
          <Keyboard size={12} />
          <span className="tab-shortcuts-btn-label">Shortcuts</span>
          <span className="kbd-key">?</span>
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
              <Edit3 size={12} /> {t('actionRenameHint').split('—')[0].trim() || t('actionRenameHint')}
            </button>
            {session.panes[menu.paneId]?.kind === 'terminal' && (
              <button className="context-menu-item" onClick={() => void restartPane(menu.paneId)}>
                <RotateCw size={12} /> {t('paneRestart')}
              </button>
            )}
            <button
              className="context-menu-item danger"
              onClick={() => void closePane(menu.paneId)}
            >
              <X size={12} /> {t('shortcutsItemClosePane')}
            </button>
            {paneIds.length > 1 && (
              <button
                className="context-menu-item"
                onClick={() => {
                  closeMenu();
                  void window.cmux.panes.relayout(session.id, 'tiled');
                }}
              >
                <Layers size={12} /> {t('shortcutsItemRetile')}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

