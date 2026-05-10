import { memo, useCallback, useMemo, useState, type JSX, type MouseEvent } from 'react';
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

function classifySession(s: Session): SessionItemMeta {
  let isRunning = false;
  let isError = false;
  let isExited = false;
  for (const id of allPaneIds(s.tree)) {
    const p = s.panes[id];
    if (p?.kind !== 'terminal') continue;
    if (p.status === 'running' || p.status === 'starting') isRunning = true;
    if (p.status === 'error') isError = true;
    if (p.status === 'exited') isExited = true;
  }
  return { session: s, isRunning, isError, isExited };
}

function SidebarImpl({ onNewSession, onOpenSettings }: Props): JSX.Element {
  const t = useT();
  const {
    sessions,
    agents,
    activeSessionId,
    lastEventBySession,
    paneActivity,
    setActiveSession,
    removeSession,
    upsertSession,
    reorderSessions
  } = useSessionStore(
    useShallow((s) => ({
      sessions: s.sessions,
      agents: s.agents,
      activeSessionId: s.activeSessionId,
      lastEventBySession: s.lastEventBySession,
      paneActivity: s.paneActivity,
      setActiveSession: s.setActiveSession,
      removeSession: s.removeSession,
      upsertSession: s.upsertSession,
      reorderSessions: s.reorderSessions
    }))
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [filter, setFilter] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  // Idle section : déployée par défaut. L'user peut la replier manuellement.
  const [idleCollapsed, setIdleCollapsed] = useState(false);

  const filtered = useMemo(() => {
    if (!filter.trim()) return sessions;
    const q = filter.toLowerCase();
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.branch ?? '').toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q)
    );
  }, [sessions, filter]);

  const groups = useMemo(() => {
    const pinned: SessionItemMeta[] = [];
    const active: SessionItemMeta[] = [];
    const idle: SessionItemMeta[] = [];
    for (const s of filtered) {
      const meta = classifySession(s);
      if (s.pinned) pinned.push(meta);
      else if (meta.isRunning) active.push(meta);
      else idle.push(meta);
    }
    return { pinned, active, idle };
  }, [filtered]);

  const totalRunning = useMemo(() => {
    let n = 0;
    for (const s of sessions) {
      for (const id of allPaneIds(s.tree)) {
        const p = s.panes[id];
        if (p?.kind === 'terminal' && (p.status === 'running' || p.status === 'starting')) n++;
      }
    }
    return n;
  }, [sessions]);

  const onRemove = useCallback(
    async (e: MouseEvent, s: Session): Promise<void> => {
      e.stopPropagation();
      await window.cmux.sessions.remove(s.id);
      removeSession(s.id);
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
  const onActivate = useCallback((id: string) => setActiveSession(id), [setActiveSession]);
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
    <aside className="sidebar">
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
            >
              <SettingsIcon size={14} />
            </button>
            <button
              className="btn-icon primary"
              onClick={onNewSession}
              title={t('actionNewSession')}
              aria-label={t('actionNewSession')}
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
          />
          {filter && (
            <button
              className="sidebar-search-clear"
              onClick={() => setFilter('')}
              title={t('actionClearFilter')}
              aria-label={t('actionClearFilter')}
            >
              <X size={10} />
            </button>
          )}
        </div>
      )}

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <Bot size={20} />
            </div>
            <div className="sidebar-empty-title">{t('sidebarEmptyTitle')}</div>
            <span className="sidebar-empty-body">{t('sidebarEmptyBody')}</span>
            <button className="btn primary sidebar-empty-cta" onClick={onNewSession}>
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
                onToggle={() => setIdleCollapsed((v) => !v)}
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
