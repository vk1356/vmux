import {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
  type JSX,
  type MouseEvent
} from 'react';
import {
  Plus,
  X,
  Settings as SettingsIcon,
  Search,
  Pin,
  ChevronDown,
  ChevronRight,
  Activity,
  Moon,
  Bot
} from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useT } from '../i18n';
import { SessionItem, type SessionItemMeta } from './SessionItem';

interface Props {
  onNewSession: () => void;
  onOpenSettings: () => void;
}

type ClassifiedSession = SessionItemMeta & { running: number };

/** Cache WeakMap par session : classifySession ne dépend que de `tree` + `panes`.
 *  Tant que ces deux refs sont stables, le résultat est immutable. Quand
 *  reorderSessions crée un nouvel `sessions[]` (même contenu, ordre différent),
 *  on évite N tree traversals — on lit directement le cache. */
const classifyCache = new WeakMap<Session, ClassifiedSession>();

/** Classifie une session ET compte ses panes runnings/total — single pass sur
 *  les paneIds pour éviter le double-sweep (avant : classifySession +
 *  totalRunning faisaient chacun `allPaneIds` séparément). */
function classifySession(s: Session): ClassifiedSession {
  const cached = classifyCache.get(s);
  if (cached) return cached;
  let isRunning = false;
  let isError = false;
  let isExited = false;
  let running = 0;
  for (const id of allPaneIds(s.tree)) {
    const p = s.panes[id];
    if (p?.kind !== 'terminal') continue;
    if (p.status === 'running' || p.status === 'starting') {
      isRunning = true;
      running++;
    }
    if (p.status === 'error') isError = true;
    if (p.status === 'exited') isExited = true;
  }
  const result: ClassifiedSession = { session: s, isRunning, isError, isExited, running };
  classifyCache.set(s, result);
  return result;
}

function SidebarImpl({ onNewSession, onOpenSettings }: Props): JSX.Element {
  const t = useT();
  const {
    sessions,
    agents,
    setActiveSession,
    removeSession,
    upsertSession,
    reorderSessions
  } = useSessionStore(
    useShallow((s) => ({
      sessions: s.sessions,
      agents: s.agents,
      setActiveSession: s.setActiveSession,
      removeSession: s.removeSession,
      upsertSession: s.upsertSession,
      reorderSessions: s.reorderSessions
    }))
  );
  // Selectors séparés : un changement de paneActivity (event bump) ne déclenche
  // pas un re-render des sessions ; un changement d'activeSessionId ne ré-execute
  // pas le classifySession sur toutes les sessions. Chaque sous-tree React voit
  // exactement les données qu'il consomme — granularité optimale pour Zustand.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const lastEventBySession = useSessionStore((s) => s.lastEventBySession);
  const paneActivity = useSessionStore((s) => s.paneActivity);
  const paneAgentState = useSessionStore((s) => s.paneAgentState);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [filter, setFilter] = useState('');
  // Le filtrage est défilé : l'input reste réactif même quand la liste est
  // grosse (le keystroke ne bloque pas sur le filterReduce). React 19.
  const deferredFilter = useDeferredValue(filter);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  // Idle section : déployée par défaut. L'user peut la replier manuellement.
  const [idleCollapsed, setIdleCollapsed] = useState(false);

  // Étape 1 : classifier toutes les sessions une seule fois. On en tire les
  // groupes ET le totalRunning sans re-traverser les arbres.
  const classified = useMemo(() => sessions.map(classifySession), [sessions]);

  // Étape 2 : filtrer sur la query (defer pour ne pas bloquer la saisie).
  const filtered = useMemo(() => {
    const q = deferredFilter.trim().toLowerCase();
    if (!q) return classified;
    return classified.filter(({ session: s }) => {
      return (
        s.name.toLowerCase().includes(q) ||
        (s.branch ?? '').toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q)
      );
    });
  }, [classified, deferredFilter]);

  const groups = useMemo(() => {
    const pinned: SessionItemMeta[] = [];
    const active: SessionItemMeta[] = [];
    const idle: SessionItemMeta[] = [];
    for (const meta of filtered) {
      if (meta.session.pinned) pinned.push(meta);
      else if (meta.isRunning) active.push(meta);
      else idle.push(meta);
    }
    return { pinned, active, idle };
  }, [filtered]);

  const totalRunning = useMemo(() => {
    let n = 0;
    for (const c of classified) n += c.running;
    return n;
  }, [classified]);

  const onRemove = useCallback(
    async (e: MouseEvent, s: Session): Promise<void> => {
      e.stopPropagation();
      try {
        await window.cmux.sessions.remove(s.id);
        removeSession(s.id);
      } catch (err) {
        // Échec IPC : ne PAS purger le store côté renderer — l'user voit la
        // session disparaître puis revenir au prochain sessionUpdate. Surfacer
        // l'erreur dans la console pour debug.
        // eslint-disable-next-line no-console -- diagnostic d'échec (remove session)
        console.error('[sidebar] session remove failed', err);
      }
    },
    [removeSession]
  );

  const onRestartAll = useCallback(
    async (e: MouseEvent, s: Session): Promise<void> => {
      e.stopPropagation();
      const r = await window.cmux.sessions.restartAll(s.id);
      if (r.ok && r.data) upsertSession(r.data);
    },
    [upsertSession]
  );

  const onTogglePin = useCallback(
    async (e: MouseEvent, s: Session): Promise<void> => {
      e.stopPropagation();
      const r = await window.cmux.sessions.togglePin(s.id);
      if (r.ok && r.data) upsertSession(r.data);
    },
    [upsertSession]
  );

  const onPickColor = useCallback(
    async (sessionId: string, color: string | null): Promise<void> => {
      setColorPickerFor(null);
      const r = await window.cmux.sessions.setColor(sessionId, color);
      if (r.ok && r.data) upsertSession(r.data);
    },
    [upsertSession]
  );

  const onStartRename = useCallback((e: MouseEvent, s: Session): void => {
    e.stopPropagation();
    setRenamingId(s.id);
    setRenameValue(s.name);
  }, []);

  const onCommitRename = useCallback(
    async (s: Session): Promise<void> => {
      const value = renameValue.trim();
      setRenamingId(null);
      if (!value || value === s.name) return;
      const r = await window.cmux.sessions.rename(s.id, value);
      if (r.ok && r.data) upsertSession(r.data);
    },
    [renameValue, upsertSession]
  );

  const onCancelRename = useCallback(() => setRenamingId(null), []);
  const onChangeRename = useCallback((v: string) => setRenameValue(v), []);
  const onActivate = useCallback(
    (id: string) => setActiveSession(id),
    [setActiveSession]
  );
  const onFocusPane = useCallback((sessionId: string, paneId: string) => {
    void window.cmux.panes.focus(sessionId, paneId);
  }, []);
  const onDragStart = useCallback(() => {
    /* no-op — drag data set in SessionItem */
  }, []);
  const onDragOver = useCallback((s: Session) => setDragOverId(s.id), []);
  const onDragLeave = useCallback(
    (s: Session) => setDragOverId((cur) => (cur === s.id ? null : cur)),
    []
  );
  const onDrop = useCallback(
    (sourceId: string, targetId: string) => {
      setDragOverId(null);
      if (sourceId !== targetId) reorderSessions(sourceId, targetId);
    },
    [reorderSessions]
  );

  const toggleIdleCollapsed = useCallback(() => setIdleCollapsed((v) => !v), []);
  const clearFilter = useCallback(() => setFilter(''), []);

  const renderItem = (meta: SessionItemMeta): JSX.Element => (
    <SessionItem
      key={meta.session.id}
      meta={meta}
      agents={agents}
      isActive={activeSessionId === meta.session.id}
      isRenaming={renamingId === meta.session.id}
      renameValue={renameValue}
      dragOverId={dragOverId}
      colorPickerOpen={colorPickerFor === meta.session.id}
      paneActivity={paneActivity}
      paneAgentState={paneAgentState}
      lastEvent={lastEventBySession[meta.session.id]}
      t={t}
      onActivate={onActivate}
      onStartRename={onStartRename}
      onChangeRename={onChangeRename}
      onCommitRename={onCommitRename}
      onCancelRename={onCancelRename}
      onTogglePin={onTogglePin}
      onRestartAll={onRestartAll}
      onRemove={onRemove}
      onOpenColorPicker={setColorPickerFor}
      onPickColor={onPickColor}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onFocusPane={onFocusPane}
    />
  );

  return (
    <aside className="sidebar" aria-label={t('sidebarTitle')}>
      <div className="sidebar-header">
        <div className="sidebar-header-row">
          <div className="sidebar-brand">
            <span className="sidebar-title">{t('sidebarTitle')}</span>
            {sessions.length > 0 && <span className="sidebar-count">{sessions.length}</span>}
          </div>
          <div className="sidebar-header-actions">
            <button
              className="btn-icon"
              onClick={onOpenSettings}
              title={t('actionSettings')}
              aria-label={t('actionSettings')}
              type="button"
            >
              <SettingsIcon size={14} />
            </button>
            <button
              className="btn-icon primary"
              onClick={onNewSession}
              title={t('actionNewSession')}
              aria-label={t('actionNewSession')}
              type="button"
            >
              <Plus size={15} strokeWidth={2.5} />
            </button>
          </div>
        </div>
        {sessions.length > 0 && (
          <div className="sidebar-pulse">
            <span className={`sidebar-pulse-dot ${totalRunning > 0 ? 'running' : ''}`} />
            <span className="sidebar-pulse-text">
              {totalRunning > 0
                ? t(totalRunning > 1 ? 'agentsActive' : 'agentActive', { n: totalRunning })
                : t('noAgentActive')}
            </span>
          </div>
        )}
      </div>

      {sessions.length > 1 && (
        <div className="sidebar-search">
          <Search size={12} />
          <input
            placeholder={t('sidebarFilter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            aria-label={t('sidebarFilter')}
          />
          {filter && (
            <button
              className="sidebar-search-clear"
              onClick={clearFilter}
              title={t('actionClearFilter')}
              aria-label={t('actionClearFilter')}
              type="button"
            >
              <X size={10} />
            </button>
          )}
        </div>
      )}

      <div
        className="session-list"
        role="listbox"
        aria-label={t('sidebarTitle')}
        aria-activedescendant={activeSessionId ?? undefined}
      >
        {sessions.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <Bot size={20} />
            </div>
            <div className="sidebar-empty-title">{t('sidebarEmptyTitle')}</div>
            <span className="sidebar-empty-body">{t('sidebarEmptyBody')}</span>
            <button className="btn primary sidebar-empty-cta" onClick={onNewSession} type="button">
              <Plus size={12} strokeWidth={2.5} />
              {t('sidebarEmptyCta')}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-title">{t('sidebarNoResults')}</div>
            <span className="sidebar-empty-body">{t('sidebarNoResultsBody', { q: filter })}</span>
          </div>
        ) : (
          <>
            {groups.pinned.length > 0 && (
              <SidebarSection
                icon={<Pin size={10} />}
                label={t('groupPinned')}
                count={groups.pinned.length}
              >
                {groups.pinned.map(renderItem)}
              </SidebarSection>
            )}
            {groups.active.length > 0 && (
              <SidebarSection
                icon={<Activity size={10} />}
                label={t('groupActive')}
                count={groups.active.length}
                tone="active"
              >
                {groups.active.map(renderItem)}
              </SidebarSection>
            )}
            {groups.idle.length > 0 && (
              <SidebarSection
                icon={<Moon size={10} />}
                label={t('groupIdle')}
                count={groups.idle.length}
                tone="idle"
                collapsible
                collapsed={idleCollapsed}
                onToggle={toggleIdleCollapsed}
              >
                {groups.idle.map(renderItem)}
              </SidebarSection>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

interface SectionProps {
  icon: JSX.Element;
  label: string;
  count: number;
  tone?: 'active' | 'idle';
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}

function SidebarSection({
  icon,
  label,
  count,
  tone,
  collapsible,
  collapsed,
  onToggle,
  children
}: SectionProps): JSX.Element {
  return (
    <div className={`sidebar-section ${tone ?? ''}`}>
      <button
        className={`sidebar-section-header ${collapsible ? 'collapsible' : ''}`}
        onClick={collapsible ? onToggle : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        type="button"
      >
        {collapsible &&
          (collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />)}
        <span className="sidebar-section-icon">{icon}</span>
        <span className="sidebar-section-label">{label}</span>
        <span className="sidebar-section-count">{count}</span>
      </button>
      {(!collapsible || !collapsed) && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}

export const Sidebar = memo(SidebarImpl);
