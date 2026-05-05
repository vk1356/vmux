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
  Palette
} from 'lucide-react';

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
import { useSessionStore } from '../store/sessions';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { pathBasename } from '@shared/utils';
import { useT } from '../i18n';

interface Props {
  onNewSession: () => void;
  onOpenSettings: () => void;
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
  } = useSessionStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [filter, setFilter] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let arr = sessions;
    if (filter.trim()) {
      const q = filter.toLowerCase();
      arr = arr.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.branch ?? '').toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q)
      );
    }
    // Sessions épinglées d'abord (sans changer l'ordre relatif).
    return [...arr].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [sessions, filter]);

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

  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);

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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-row">
          <span className="sidebar-title">{t('sidebarTitle')}</span>
          {sessions.length > 0 && (
            <span className="sidebar-count">
              <span className="sidebar-count-dot running" />
              {totalRunning} / {sessions.length}
            </span>
          )}
        </div>
        <div className="sidebar-header-actions">
          <button
            className="btn-icon"
            onClick={onOpenSettings}
            title="Paramètres (Ctrl+,)"
            aria-label="Paramètres"
          >
            <SettingsIcon size={14} />
          </button>
          <button
            className="btn-icon primary"
            onClick={onNewSession}
            title="Nouvelle session  (Ctrl+N)"
            aria-label="Nouvelle session"
          >
            <Plus size={15} strokeWidth={2.5} />
          </button>
        </div>
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
        </div>
      )}

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">
            <div>{t('sidebarEmptyTitle')}</div>
            <span>{t('sidebarEmptyBody')}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-empty">
            <div>{t('sidebarNoResults')}</div>
          </div>
        ) : (
          filtered.map((s) => {
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
                : terminalPanes.some((p) => p.status === 'error')
                  ? 'error'
                  : terminalPanes.some((p) => p.status === 'exited')
                    ? 'exited'
                    : 'idle';

            const isRenaming = renamingId === s.id;
            const folderName = pathBasename(s.cwd);
            const accent = s.colorOverride ?? agent?.color ?? 'var(--text-muted)';

            // Niveau d'attention max parmi les panes de cette session.
            const ATT_RANK = { idle: 0, activity: 1, alert: 2, 'needs-input': 3 } as const;
            let attention: 'idle' | 'activity' | 'alert' | 'needs-input' = 'idle';
            for (const id of paneIds) {
              const a = paneActivity[id] ?? 'idle';
              if (ATT_RANK[a] > ATT_RANK[attention]) attention = a;
            }

            return (
              <div
                key={s.id}
                className={`session-item ${activeSessionId === s.id ? 'active' : ''} ${
                  dragOverId === s.id ? 'drag-over' : ''
                }`}
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
              >
                <div
                  className="session-avatar"
                  style={{
                    background: typeof accent === 'string' && accent.startsWith('#')
                      ? `${accent}22`
                      : 'var(--bg-elev-2)',
                    color: accent,
                    borderColor: accent
                  }}
                  title={`${agent?.label ?? main?.agentId ?? 'shell'} — clic-droit pour changer la couleur`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setColorPickerFor((cur) => (cur === s.id ? null : s.id));
                  }}
                >
                  {(agent?.label ?? main?.agentId ?? '?').charAt(0).toUpperCase()}
                  <span className={`session-avatar-dot ${dotStatus}`} />
                  {s.pinned && <span className="session-pin-mark" title="Épinglée" />}
                  {attention !== 'idle' && (
                    <span
                      className={`attention-badge attention-${attention}`}
                      title={
                        attention === 'needs-input'
                          ? 'Demande une action'
                          : attention === 'alert'
                            ? 'Agent terminé / alerte'
                            : 'Activité'
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
                      title="Double-cliquer pour renommer"
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
                        <span title="URL localhost détectée">
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
                    title={s.pinned ? 'Désépingler' : 'Épingler'}
                  >
                    {s.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  {hasIdleTerm && (
                    <button
                      className="btn-icon session-action"
                      onClick={(e) => onRestartAll(e, s)}
                      title="Redémarrer les panes inactifs"
                    >
                      <RotateCw size={12} />
                    </button>
                  )}
                  <button
                    className="btn-icon session-action"
                    onClick={(e) => onRemove(e, s)}
                    title="Fermer la session"
                  >
                    <X size={12} />
                  </button>
                </div>
                {colorPickerFor === s.id && (
                  <div
                    className="color-picker"
                    onClick={(e) => e.stopPropagation()}
                  >
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
                      title="Réinitialiser"
                      aria-label="Réinitialiser la couleur"
                    >
                      <Palette size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

export const Sidebar = memo(SidebarImpl);
