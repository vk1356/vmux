import { memo, useMemo, useState, type JSX, type MouseEvent } from 'react';
import {
  Plus,
  X,
  GitBranch,
  Settings as SettingsIcon,
  CheckCircle2,
  XCircle,
  Rocket,
  Globe,
  RotateCw,
  Search,
  Folder,
  Pin,
  PinOff,
  Palette,
  ChevronDown,
  ChevronRight,
  Activity,
  Moon,
  Bot
} from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { pathBasename } from '@shared/utils';
import { useT } from '../i18n';

const SESSION_COLORS = [
  '#f97316', // orange (accent)
  '#22c55e', // vert
  '#3b82f6', // bleu
  '#a855f7', // violet
  '#ec4899', // rose
  '#eab308', // jaune
  '#06b6d4', // cyan
  '#ef4444' // rouge
] as const;

interface Props {
  onNewSession: () => void;
  onOpenSettings: () => void;
}

interface SessionMeta {
  session: Session;
  isRunning: boolean;
  isError: boolean;
  isExited: boolean;
}

function classifySession(s: Session): SessionMeta {
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
    const pinned: SessionMeta[] = [];
    const active: SessionMeta[] = [];
    const idle: SessionMeta[] = [];
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

  const onRemove = async (e: MouseEvent, s: Session): Promise<void> => {
    e.stopPropagation();
    await window.cmux.sessions.remove(s.id);
    removeSession(s.id);
  };

  const onRestartAll = async (e: MouseEvent, s: Session): Promise<void> => {
    e.stopPropagation();
    const r = await window.cmux.sessions.restartAll(s.id);
    if (r.ok && r.data) upsertSession(r.data);
  };

  const onTogglePin = async (e: MouseEvent, s: Session): Promise<void> => {
    e.stopPropagation();
    const r = await window.cmux.sessions.togglePin(s.id);
    if (r.ok && r.data) upsertSession(r.data);
  };

  const onPickColor = async (sessionId: string, color: string | null): Promise<void> => {
    setColorPickerFor(null);
    const r = await window.cmux.sessions.setColor(sessionId, color);
    if (r.ok && r.data) upsertSession(r.data);
  };

  const startRename = (e: MouseEvent, s: Session): void => {
    e.stopPropagation();
    setRenamingId(s.id);
    setRenameValue(s.name);
  };

  const commitRename = async (s: Session): Promise<void> => {
    const value = renameValue.trim();
    setRenamingId(null);
    if (!value || value === s.name) return;
    const r = await window.cmux.sessions.rename(s.id, value);
    if (r.ok && r.data) upsertSession(r.data);
  };

  const renderItem = (meta: SessionMeta): JSX.Element => {
    const s = meta.session;
    const paneIds = allPaneIds(s.tree);
    const terminalPanes = paneIds
      .map((id) => s.panes[id])
      .filter((p): p is TerminalPane => p?.kind === 'terminal');
    const main = terminalPanes[0];
    const agent = main ? agents.find((a) => a.id === main.agentId) : null;
    const running = terminalPanes.filter(
      (p) => p.status === 'running' || p.status === 'starting'
    ).length;
    const hasIdleTerm = terminalPanes.some(
      (p) => p.status === 'idle' || p.status === 'exited' || p.status === 'error'
    );
    const hasUrls = terminalPanes.some((p) => (p.recentUrls?.length ?? 0) > 0);
    const lastEvent = lastEventBySession[s.id];

    const dotStatus =
      running > 0
        ? 'running'
        : meta.isError
          ? 'error'
          : meta.isExited
            ? 'exited'
            : 'idle';

    const isRenaming = renamingId === s.id;
    const folderName = pathBasename(s.cwd);
    const accent = s.colorOverride ?? agent?.color ?? 'var(--text-muted)';

    const ATT_RANK = { idle: 0, activity: 1, alert: 2, 'needs-input': 3 } as const;
    let attention: 'idle' | 'activity' | 'alert' | 'needs-input' = 'idle';
    for (const id of paneIds) {
      const a = paneActivity[id] ?? 'idle';
      if (ATT_RANK[a] > ATT_RANK[attention]) attention = a;
    }

    const isActive = activeSessionId === s.id;
    const hasNeeds = attention === 'needs-input';
    const hasAlert = attention === 'alert';

    return (
      <div
        key={s.id}
        className={[
          'session-item',
          isActive ? 'active' : '',
          dragOverId === s.id ? 'drag-over' : '',
          hasNeeds ? 'has-needs-input' : '',
          hasAlert ? 'has-alert' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setActiveSession(s.id)}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/x-vmux-session', s.id);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/x-vmux-session')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragOverId(s.id);
          }
        }}
        onDragLeave={() => setDragOverId((cur) => (cur === s.id ? null : cur))}
        onDrop={(e) => {
          const sourceId = e.dataTransfer.getData('text/x-vmux-session');
          setDragOverId(null);
          if (sourceId && sourceId !== s.id) reorderSessions(sourceId, s.id);
        }}
        style={
          isActive && typeof accent === 'string' && accent.startsWith('#')
            ? { ['--session-accent' as string]: accent }
            : undefined
        }
      >
        {isActive && <span className="session-active-bar" aria-hidden />}
        <div
          className="session-avatar"
          style={{
            background:
              typeof accent === 'string' && accent.startsWith('#')
                ? `${accent}22`
                : 'var(--bg-elev-2)',
            color: accent,
            borderColor: accent
          }}
          title={t('avatarHint', {
            agent: agent?.label ?? main?.agentId ?? 'shell'
          })}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setColorPickerFor((cur) => (cur === s.id ? null : s.id));
          }}
        >
          {(agent?.label ?? main?.agentId ?? '?').charAt(0).toUpperCase()}
          <span className={`session-avatar-dot ${dotStatus}`} />
          {s.pinned && <span className="session-pin-mark" title={t('pinnedLabel')} />}
          {attention !== 'idle' && (
            <span
              className={`attention-badge attention-${attention}`}
              title={
                attention === 'needs-input'
                  ? t('attentionNeedsInputLabel')
                  : attention === 'alert'
                    ? t('attentionAlertLabel')
                    : t('attentionActivityLabel')
              }
            />
          )}
        </div>
        <div className="session-meta">
          {isRenaming ? (
            <input
              autoFocus
              className="input session-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => void commitRename(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename(s);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenamingId(null);
                }
              }}
            />
          ) : (
            <div
              className="session-name"
              title={t('actionRenameHint')}
              onDoubleClick={(e) => startRename(e, s)}
            >
              {s.name}
            </div>
          )}
          <div className="session-sub">
            {s.branch ? (
              <span className="session-sub-tag">
                <GitBranch size={9} /> {s.branch}
              </span>
            ) : (
              <span className="session-sub-tag">
                <Folder size={9} /> {folderName}
              </span>
            )}
            {paneIds.length > 1 && (
              <span className="session-sub-tag">{paneIds.length}p</span>
            )}
            <span className="session-icons">
              {hasUrls && (
                <span title={t('urlDetectedLabel')}>
                  <Globe size={10} style={{ color: 'var(--info)' }} />
                </span>
              )}
              {lastEvent?.kind === 'server-ready' && (
                <span title={lastEvent.message}>
                  <Rocket size={10} style={{ color: 'var(--success)' }} />
                </span>
              )}
              {lastEvent?.kind === 'build-success' && (
                <span title={lastEvent.message}>
                  <CheckCircle2 size={10} style={{ color: 'var(--success)' }} />
                </span>
              )}
              {lastEvent?.kind === 'build-error' && (
                <span title={lastEvent.message}>
                  <XCircle size={10} style={{ color: 'var(--error)' }} />
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="session-actions">
          <button
            className={`btn-icon session-action ${s.pinned ? 'pinned' : ''}`}
            onClick={(e) => onTogglePin(e, s)}
            title={s.pinned ? t('actionUnpin') : t('actionPin')}
          >
            {s.pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
          {hasIdleTerm && (
            <button
              className="btn-icon session-action"
              onClick={(e) => onRestartAll(e, s)}
              title={t('actionRestartIdle')}
            >
              <RotateCw size={12} />
            </button>
          )}
          <button
            className="btn-icon session-action danger"
            onClick={(e) => onRemove(e, s)}
            title={t('actionCloseSession')}
          >
            <X size={12} />
          </button>
        </div>
        {colorPickerFor === s.id && (
          <div className="color-picker" onClick={(e) => e.stopPropagation()}>
            {SESSION_COLORS.map((c) => (
              <button
                key={c}
                className="color-swatch"
                style={{ background: c }}
                onClick={() => void onPickColor(s.id, c)}
                title={c}
                aria-label={`Couleur ${c}`}
              />
            ))}
            <button
              className="color-swatch reset"
              onClick={() => void onPickColor(s.id, null)}
              title={t('actionResetColor')}
              aria-label={t('actionResetColor')}
            >
              <Palette size={11} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-row">
          <div className="sidebar-brand">
            <span className="sidebar-title">{t('sidebarTitle')}</span>
            {sessions.length > 0 && (
              <span className="sidebar-count">{sessions.length}</span>
            )}
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
            <span className="sidebar-empty-body">
              {t('sidebarNoResultsBody', { q: filter })}
            </span>
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
