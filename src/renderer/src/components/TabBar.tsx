import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent
} from 'react';
import { Globe, RotateCw, X, Edit3, Layers, Keyboard, ExternalLink } from 'lucide-react';
import type { AgentPreset, Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { hostFromUrl } from '@shared/utils';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../i18n';

interface Props {
  session: Session;
  onShowShortcuts: () => void;
  /** En mode détaché on masque les actions qui n'ont pas de sens (re-detach,
   *  raccourcis pointant sur la mainWindow). */
  detached?: boolean;
}

interface MenuState {
  paneId: string;
  x: number;
  y: number;
}

const ICON_GLOBE_STYLE = { color: 'var(--info)' } as const;
const DOT_STYLE = { width: 7, height: 7 } as const;

function TabBarImpl({ session, onShowShortcuts, detached = false }: Props): JSX.Element {
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
  const tablistRef = useRef<HTMLDivElement>(null);

  const paneIds = useMemo(() => allPaneIds(session.tree), [session.tree]);

  // Lookup O(1) par agentId — évitait un `agents.find()` par tab.
  const agentById = useMemo(() => {
    const map: Record<string, AgentPreset> = {};
    for (const a of agents) map[a.id] = a;
    return map;
  }, [agents]);

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

  const onClickTab = useCallback(
    (paneId: string): void => {
      void window.cmux.panes.focus(session.id, paneId);
    },
    [session.id]
  );

  const onRightClick = useCallback((e: MouseEvent, paneId: string): void => {
    e.preventDefault();
    setMenu({ paneId, x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback((): void => setMenu(null), []);

  const renamePane = useCallback((paneId: string, currentLabel: string): void => {
    setRenamingPaneId(paneId);
    setRenameValue(currentLabel);
    setMenu(null);
  }, []);

  const commitRename = useCallback(
    async (paneId: string): Promise<void> => {
      setRenamingPaneId(null);
      const r = await window.cmux.panes.rename(session.id, paneId, renameValue);
      if (r.ok && r.data) upsertSession(r.data);
    },
    [renameValue, session.id, upsertSession]
  );

  const restartPane = useCallback(
    async (paneId: string): Promise<void> => {
      setMenu(null);
      await window.cmux.panes.restart(session.id, paneId);
    },
    [session.id]
  );

  const closePane = useCallback(
    async (paneId: string): Promise<void> => {
      setMenu(null);
      const r = await window.cmux.panes.close(session.id, paneId);
      if (r.ok && r.data) upsertSession(r.data);
    },
    [session.id, upsertSession]
  );

  // Navigation clavier sur le tablist — pattern ARIA officiel. ArrowLeft/Right
  // déplace le focus + active la tab. Home/End vont aux extrémités. Un seul
  // handler sur le parent plutôt qu'un onKeyDown par tab.
  const onTablistKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      if (renamingPaneId) return;
      if (paneIds.length === 0) return;
      const activeIdx = paneIds.indexOf(session.activePaneId ?? '');
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next = activeIdx < 0 ? 0 : (activeIdx + 1) % paneIds.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        next = activeIdx <= 0 ? paneIds.length - 1 : activeIdx - 1;
      } else if (e.key === 'Home') {
        next = 0;
      } else if (e.key === 'End') {
        next = paneIds.length - 1;
      } else if (e.key === 'Delete' && session.activePaneId) {
        e.preventDefault();
        void closePane(session.activePaneId);
        return;
      }
      if (next !== null) {
        e.preventDefault();
        onClickTab(paneIds[next]);
      }
    },
    [paneIds, session.activePaneId, renamingPaneId, onClickTab, closePane]
  );

  // Échap ferme le menu contextuel — sinon il faut cliquer le backdrop.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // Détacher la position du menu pour éviter le sync layout read pendant render.
  // `window.innerWidth` lu UNE fois quand le menu s'ouvre, pas à chaque render.
  const menuStyle = useMemo<React.CSSProperties | null>(() => {
    if (!menu) return null;
    const left = Math.min(menu.x, window.innerWidth - 200);
    return { left, top: menu.y };
  }, [menu]);

  const menuPane = menu ? session.panes[menu.paneId] : null;

  return (
    <>
      <div
        className="tab-bar-list"
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={onTablistKeyDown}
        ref={tablistRef}
      >
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
            const agent = agentById[term.agentId];
            label = label || agent?.label || term.agentId;
            dotClass = term.status;
          } else {
            label = label || hostFromUrl(pane.url);
            icon = <Globe size={11} style={ICON_GLOBE_STYLE} />;
            dotClass = 'running';
          }

          const attention = paneActivity[id] ?? 'idle';
          const unread = unreadByPane[id] ?? 0;

          return (
            <Tab
              key={id}
              paneId={id}
              label={label}
              icon={icon}
              dotClass={dotClass}
              isActive={isActive}
              isRenaming={isRenaming}
              renameValue={renameValue}
              attention={attention}
              unread={unread}
              t={t}
              onClickTab={onClickTab}
              onRightClick={onRightClick}
              onStartRename={renamePane}
              onChangeRename={setRenameValue}
              onCommitRename={commitRename}
              onCancelRename={() => setRenamingPaneId(null)}
              onClosePane={closePane}
            />
          );
        })}
      </div>

      <div className="tab-bar-actions">
        {!detached && (
          <button
            className="tab-shortcuts-btn"
            onClick={() => void window.cmux.window.detachSession(session.id)}
            title={t('paneDetachWindowTitle')}
            aria-label={t('paneDetachWindowAria')}
            type="button"
          >
            <ExternalLink size={12} />
            <span className="tab-shortcuts-btn-label">{t('paneDetachWindowLabel')}</span>
          </button>
        )}
        <button
          className="tab-shortcuts-btn"
          onClick={onShowShortcuts}
          title="Raccourcis clavier — appuie sur ?"
          aria-label="Raccourcis clavier"
          type="button"
        >
          <Keyboard size={12} />
          <span className="tab-shortcuts-btn-label">Shortcuts</span>
          <span className="kbd-key">?</span>
        </button>
      </div>

      {menu && menuStyle && (
        <>
          <div className="menu-backdrop" onClick={closeMenu} />
          <div className="context-menu" style={menuStyle} role="menu">
            <button
              className="context-menu-item"
              onClick={() => {
                if (menuPane) renamePane(menu.paneId, menuPane.label || '');
              }}
              role="menuitem"
              type="button"
            >
              <Edit3 size={12} />{' '}
              {t('actionRenameHint').split('—')[0].trim() || t('actionRenameHint')}
            </button>
            {menuPane?.kind === 'terminal' && (
              <button
                className="context-menu-item"
                onClick={() => void restartPane(menu.paneId)}
                role="menuitem"
                type="button"
              >
                <RotateCw size={12} /> {t('paneRestart')}
              </button>
            )}
            <button
              className="context-menu-item danger"
              onClick={() => void closePane(menu.paneId)}
              role="menuitem"
              type="button"
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
                role="menuitem"
                type="button"
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

export const TabBar = memo(TabBarImpl);

// ---------------------------------------------------------------------------
// Tab : extraite + memoizée. Avant, toute la liste re-render dès qu'un seul
// pane changeait d'attention/unread/label. Maintenant React skip les tabs
// dont les props (toutes primitives) restent stables.
// ---------------------------------------------------------------------------

interface TabProps {
  paneId: string;
  label: string;
  icon: JSX.Element | null;
  dotClass: string;
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  attention: string;
  unread: number;
  t: ReturnType<typeof useT>;
  onClickTab: (paneId: string) => void;
  onRightClick: (e: MouseEvent, paneId: string) => void;
  onStartRename: (paneId: string, label: string) => void;
  onChangeRename: (v: string) => void;
  onCommitRename: (paneId: string) => Promise<void>;
  onCancelRename: () => void;
  onClosePane: (paneId: string) => Promise<void>;
}

const Tab = memo(function Tab({
  paneId,
  label,
  icon,
  dotClass,
  isActive,
  isRenaming,
  renameValue,
  attention,
  unread,
  t,
  onClickTab,
  onRightClick,
  onStartRename,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onClosePane
}: TabProps): JSX.Element {
  return (
    <div
      className={`tab ${isActive ? 'active' : ''} attention-${attention}`}
      onClick={() => onClickTab(paneId)}
      onContextMenu={(e) => onRightClick(e, paneId)}
      onDoubleClick={() => onStartRename(paneId, label)}
      title="Click = focus · Double-click = renommer · Clic-droit = menu"
      role="tab"
      id={`tab-${paneId}`}
      aria-selected={isActive}
      aria-controls={`panel-${paneId}`}
      tabIndex={isActive ? 0 : -1}
    >
      <span className={`session-dot ${dotClass}`} style={DOT_STYLE} />
      {icon}
      {isRenaming ? (
        <input
          autoFocus
          className="tab-rename-input"
          value={renameValue}
          onChange={(e) => onChangeRename(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => void onCommitRename(paneId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onCommitRename(paneId);
            else if (e.key === 'Escape') onCancelRename();
          }}
          aria-label={t('actionRenameHint')}
        />
      ) : (
        <span className="tab-label">{label}</span>
      )}
      {unread > 0 && (
        <span
          className="tab-unread"
          title={`${unread} événement${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}`}
          aria-label={`${unread} unread`}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      <button
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation();
          void onClosePane(paneId);
        }}
        title={t('paneCloseTitle')}
        aria-label={t('paneCloseAria')}
        type="button"
        tabIndex={-1}
      >
        <X size={11} />
      </button>
    </div>
  );
});
