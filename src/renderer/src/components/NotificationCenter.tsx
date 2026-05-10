import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Bell, BellRing, X, Trash2, CheckCircle2, XCircle, Rocket, FlaskConical, Sparkles } from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import type { DetectedEventKind } from '@shared/types';
import { useLocale, useT, type TKey } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL_KEY: Record<DetectedEventKind, TKey> = {
  'server-ready': 'notifKindServerReady',
  'build-success': 'notifKindBuildSuccess',
  'build-error': 'notifKindBuildError',
  'test-results': 'notifKindTests',
  'agent-done': 'notifKindAgentDone',
  notify: 'notifKindNotify'
};

export function NotificationCenter({ open, onClose }: Props): JSX.Element | null {
  const t = useT();
  const locale = useLocale();
  const eventHistory = useSessionStore((s) => s.eventHistory);
  const markEventsRead = useSessionStore((s) => s.markEventsRead);
  const clearEventHistory = useSessionStore((s) => s.clearEventHistory);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const [filter, setFilter] = useState<DetectedEventKind | 'all'>('all');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

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
      <div
        className="notif-drawer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('notificationsTitle')}
        onClick={(e) => e.stopPropagation()}
      >
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
          <FilterChip
            label={t('notifFilterAll')}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <FilterChip
            label={t('notifFilterReady')}
            active={filter === 'server-ready'}
            onClick={() => setFilter('server-ready')}
          />
          <FilterChip
            label={t('notifFilterBuild')}
            active={filter === 'build-success'}
            onClick={() => setFilter('build-success')}
          />
          <FilterChip
            label={t('notifFilterErrors')}
            active={filter === 'build-error'}
            onClick={() => setFilter('build-error')}
          />
          <FilterChip
            label={t('notifFilterTests')}
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
              <div style={{ fontSize: 11, opacity: 0.6 }}>{t('notifEmptyHint')}</div>
            </div>
          ) : (
            filtered.map((e) => (
              <button
                // Clé stable : timestamp + paneId est unique, ne dépend pas
                // de l'index dans la liste filtrée → pas de remount au change
                // de filtre, donc pas de perte de scroll position.
                key={`${e.event.timestamp}-${e.event.paneId}`}
                className="notif-item"
                onClick={() => {
                  setActiveSession(e.sessionId);
                  onClose();
                }}
              >
                <span className="notif-icon">{iconForKind(e.event.kind)}</span>
                <div className="notif-body">
                  <div className="notif-row1">
                    <span className="notif-kind">{t(KIND_LABEL_KEY[e.event.kind])}</span>
                    <span className="notif-session">{e.sessionName}</span>
                    <span className="notif-time">{formatTime(e.event.timestamp, locale)}</span>
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
    case 'notify':
      return <BellRing size={14} color="#f97316" />;
  }
}

/** Format relatif language-aware via Intl.RelativeTimeFormat. */
function formatTime(ts: number, locale: string): string {
  const d = new Date(ts);
  const diffSec = (Date.now() - ts) / 1000;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (diffSec < 60) return rtf.format(-Math.floor(diffSec), 'second');
    if (diffSec < 3600) return rtf.format(-Math.floor(diffSec / 60), 'minute');
    if (diffSec < 86400) return rtf.format(-Math.floor(diffSec / 3600), 'hour');
  } catch {
    /* fallback below */
  }
  return d.toLocaleDateString(locale);
}
