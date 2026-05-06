import { useEffect, useMemo, useState, type JSX } from 'react';
import { Bell, X, Trash2, CheckCircle2, XCircle, Rocket, FlaskConical, Sparkles } from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import type { DetectedEventKind } from '@shared/types';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_LABELS: Record<DetectedEventKind, string> = {
  'server-ready': 'Serveur prêt',
  'build-success': 'Build réussi',
  'build-error': 'Build erreur',
  'test-results': 'Tests',
  'agent-done': 'Agent terminé'
};

export function NotificationCenter({ open, onClose }: Props): JSX.Element | null {
  const t = useT();
  const eventHistory = useSessionStore((s) => s.eventHistory);
  const markEventsRead = useSessionStore((s) => s.markEventsRead);
  const clearEventHistory = useSessionStore((s) => s.clearEventHistory);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const [filter, setFilter] = useState<DetectedEventKind | 'all'>('all');

  // Mark all as read when drawer opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => markEventsRead(), 600);
      return () => clearTimeout(t);
    }
  }, [open, markEventsRead]);

  const filtered = useMemo(() => {
    if (filter === 'all') return eventHistory;
    return eventHistory.filter((e) => e.event.kind === filter);
  }, [eventHistory, filter]);

  if (!open) return null;

  return (
    <div className="notif-backdrop" onClick={onClose}>
      <div className="notif-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="notif-header">
          <div className="notif-title">
            <Bell size={14} /> {t('notificationsTitle')}
            <span className="notif-count">{eventHistory.length}</span>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label={t('windowClose')}>
            <X size={14} />
          </button>
        </div>

        <div className="notif-filters">
          <FilterChip label="Tous" active={filter === 'all'} onClick={() => setFilter('all')} />
          <FilterChip
            label="🚀 Ready"
            active={filter === 'server-ready'}
            onClick={() => setFilter('server-ready')}
          />
          <FilterChip
            label="✓ Build"
            active={filter === 'build-success'}
            onClick={() => setFilter('build-success')}
          />
          <FilterChip
            label="✗ Erreurs"
            active={filter === 'build-error'}
            onClick={() => setFilter('build-error')}
          />
          <FilterChip
            label="🧪 Tests"
            active={filter === 'test-results'}
            onClick={() => setFilter('test-results')}
          />
          <button
            className="btn-icon notif-clear"
            onClick={clearEventHistory}
            disabled={eventHistory.length === 0}
            title={t('notificationsClear')}
          >
            <Trash2 size={12} />
          </button>
        </div>

        <div className="notif-list">
          {filtered.length === 0 ? (
            <div className="notif-empty">
              <Sparkles size={20} style={{ opacity: 0.4 }} />
              <div>{t('notificationsEmpty')}</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>
                Detected events (server ready, build, tests…) will appear here.
              </div>
            </div>
          ) : (
            filtered.map((e, i) => (
              <button
                key={`${e.event.timestamp}-${i}`}
                className="notif-item"
                onClick={() => {
                  setActiveSession(e.sessionId);
                  onClose();
                }}
              >
                <span className="notif-icon">{iconForKind(e.event.kind)}</span>
                <div className="notif-body">
                  <div className="notif-row1">
                    <span className="notif-kind">{KIND_LABELS[e.event.kind]}</span>
                    <span className="notif-session">{e.sessionName}</span>
                    <span className="notif-time">{formatTime(e.event.timestamp)}</span>
                  </div>
                  <div className="notif-msg">{e.event.message}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button className={`notif-filter ${active ? 'active' : ''}`} onClick={onClick}>
      {label}
    </button>
  );
}

function iconForKind(kind: DetectedEventKind): JSX.Element {
  switch (kind) {
    case 'server-ready':
      return <Rocket size={14} color="#22c55e" />;
    case 'build-success':
    case 'agent-done':
      return <CheckCircle2 size={14} color="#22c55e" />;
    case 'build-error':
      return <XCircle size={14} color="#ef4444" />;
    case 'test-results':
      return <FlaskConical size={14} color="#3b82f6" />;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = (now - ts) / 1000;
  if (diff < 60) return `il y a ${Math.floor(diff)}s`;
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}
