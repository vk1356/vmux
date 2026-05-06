import { useEffect, useState, type JSX } from 'react';
import { Activity, Folder, GitBranch, Cpu, Bell, AlertCircle } from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import { allPaneIds } from '@shared/tree';
import type { TerminalPane } from '@shared/types';
import { useT } from '../i18n';
import { PaneStats } from './PaneStats';

interface Props {
  onOpenNotifications: () => void;
}

export function StatusBar({ onOpenNotifications }: Props): JSX.Element {
  const t = useT();
  const { sessions, activeSessionId, eventHistory, paneActivity, setActiveSession } =
    useSessionStore();
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    void window.cmux.app?.version().then(setVersion);
  }, []);

  let runningPanes = 0;
  let totalPanes = 0;
  for (const s of sessions) {
    for (const id of allPaneIds(s.tree)) {
      const p = s.panes[id];
      if (p?.kind === 'terminal') {
        totalPanes++;
        if (p.status === 'running' || p.status === 'starting') runningPanes++;
      }
    }
  }

  const unreadCount = eventHistory.filter((e) => !e.readAt).length;

  // Global needs-input : sessions qui ont au moins un pane en attention 'needs-input' ou 'alert'.
  const needsInputSessions: { id: string; paneId: string; level: 'alert' | 'needs-input' }[] = [];
  for (const s of sessions) {
    for (const id of allPaneIds(s.tree)) {
      const a = paneActivity[id];
      if (a === 'needs-input' || a === 'alert') {
        needsInputSessions.push({ id: s.id, paneId: id, level: a });
        break;
      }
    }
  }
  const needsInputCount = needsInputSessions.length;
  const hasNeedsInput = needsInputSessions.some((x) => x.level === 'needs-input');

  const active = sessions.find((s) => s.id === activeSessionId);
  const activePane = active?.activePaneId ? active.panes[active.activePaneId] : null;
  const activeTerm =
    activePane && activePane.kind === 'terminal' ? (activePane as TerminalPane) : null;

  return (
    <div className="statusbar">
      <span className="statusbar-section">
        <Activity size={11} /> {runningPanes} {t('statusActive')} / {totalPanes}
      </span>
      {active && (
        <>
          {activeTerm && (
            <>
              <span className="statusbar-section">
                <Cpu size={11} /> PID&nbsp;{activeTerm.pid ?? '—'}
              </span>
              {activeTerm.status === 'running' && (
                <span className="statusbar-section statusbar-stats">
                  <PaneStats paneId={activeTerm.id} />
                </span>
              )}
            </>
          )}
          {active.branch && (
            <span className="statusbar-section">
              <GitBranch size={11} /> {active.branch}
            </span>
          )}
          <span
            className="statusbar-section"
            title={active.cwd}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 360
            }}
          >
            <Folder size={11} /> {activeTerm?.cwd ?? active.cwd}
          </span>
        </>
      )}
      <span className="statusbar-spacer" />
      {needsInputCount > 0 && (
        <button
          className={`statusbar-attention ${hasNeedsInput ? 'urgent' : 'soft'}`}
          onClick={() => {
            // Cycle vers la 1ère session qui demande de l'attention.
            const first = needsInputSessions[0];
            if (first) setActiveSession(first.id);
          }}
          title={`${needsInputCount} session${needsInputCount > 1 ? 's' : ''} demande${needsInputCount > 1 ? 'nt' : ''} attention — clique pour aller`}
        >
          <AlertCircle size={11} />
          {needsInputCount}
        </button>
      )}
      <button
        className="statusbar-bell"
        onClick={onOpenNotifications}
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell size={12} />
        {unreadCount > 0 && <span className="statusbar-bell-badge">{unreadCount}</span>}
      </button>
      <span className="statusbar-section" style={{ opacity: 0.6 }}>
        vMux {version ? `v${version}` : ''}
      </span>
    </div>
  );
}
