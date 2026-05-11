import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  Activity,
  Folder,
  GitBranch,
  Cpu,
  Bell,
  AlertCircle,
  MemoryStick,
  Server,
  Check
} from 'lucide-react';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { allPaneIds } from '@shared/tree';
import type { TerminalPane } from '@shared/types';
import { useT } from '../i18n';
import { PaneStats } from './PaneStats';

interface Props {
  onOpenNotifications: () => void;
}

function StatusBarImpl({ onOpenNotifications }: Props): JSX.Element {
  const t = useT();
  const {
    sessions,
    activeSessionId,
    eventHistory,
    paneActivity,
    setActiveSession,
    systemStats,
    systemCpuHistory
  } = useSessionStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      eventHistory: s.eventHistory,
      paneActivity: s.paneActivity,
      setActiveSession: s.setActiveSession,
      systemStats: s.systemStats,
      systemCpuHistory: s.systemCpuHistory
    }))
  );
  const [version, setVersion] = useState<string>('');
  const [pidCopied, setPidCopied] = useState(false);
  const pidCopiedTimerRef = useRef<number | null>(null);
  useEffect(() => {
    void window.cmux.app?.version().then(setVersion);
  }, []);
  // Cleanup du timer "pid copied" au unmount — sinon setState after unmount
  // si la status bar est détruite pendant les 1200ms d'affichage du tick.
  useEffect(
    () => () => {
      if (pidCopiedTimerRef.current !== null) {
        window.clearTimeout(pidCopiedTimerRef.current);
        pidCopiedTimerRef.current = null;
      }
    },
    []
  );

  // Memoized — sinon ce calcul O(sessions × panes) re-tournait à chaque
  // re-render (et la StatusBar re-rend sur n'importe quel store update).
  const { runningPanes, totalPanes } = useMemo(() => {
    let running = 0;
    let total = 0;
    for (const s of sessions) {
      for (const id of allPaneIds(s.tree)) {
        const p = s.panes[id];
        if (p?.kind === 'terminal') {
          total++;
          if (p.status === 'running' || p.status === 'starting') running++;
        }
      }
    }
    return { runningPanes: running, totalPanes: total };
  }, [sessions]);

  const unreadCount = useMemo(
    () => eventHistory.filter((e) => !e.readAt).length,
    [eventHistory]
  );

  // Global needs-input : sessions qui ont au moins un pane en attention 'needs-input' ou 'alert'.
  const needsInputSessions = useMemo(() => {
    const out: { id: string; paneId: string; level: 'alert' | 'needs-input' }[] = [];
    for (const s of sessions) {
      for (const id of allPaneIds(s.tree)) {
        const a = paneActivity[id];
        if (a === 'needs-input' || a === 'alert') {
          out.push({ id: s.id, paneId: id, level: a });
          break;
        }
      }
    }
    return out;
  }, [sessions, paneActivity]);
  const needsInputCount = needsInputSessions.length;
  const hasNeedsInput = needsInputSessions.some((x) => x.level === 'needs-input');

  const active = sessions.find((s) => s.id === activeSessionId);
  const activePane = active?.activePaneId ? active.panes[active.activePaneId] : null;
  const activeTerm =
    activePane && activePane.kind === 'terminal' ? (activePane as TerminalPane) : null;

  const onCopyPid = (pid: number): void => {
    void window.cmux.clipboard.write(String(pid));
    setPidCopied(true);
    if (pidCopiedTimerRef.current !== null) {
      window.clearTimeout(pidCopiedTimerRef.current);
    }
    pidCopiedTimerRef.current = window.setTimeout(() => {
      setPidCopied(false);
      pidCopiedTimerRef.current = null;
    }, 1200);
  };

  const hasProcessGroup =
    !!activeTerm && (activeTerm.pid !== undefined || activeTerm.status === 'running');
  const hasLocationGroup = !!active && (!!active.branch || !!(activeTerm?.cwd ?? active.cwd));

  return (
    <div className="statusbar">
      {/* Group 1 — État global */}
      <div className="statusbar-group">
        <span className="statusbar-section" title={`${runningPanes} pane(s) en cours sur ${totalPanes}`}>
          <Activity size={11} /> {runningPanes} {t('statusActive')} / {totalPanes}
        </span>
      </div>

      {/* Group 2 — Process info (PID + stats du pane actif) */}
      {hasProcessGroup && (
        <>
          <span className="statusbar-divider" aria-hidden />
          <div className="statusbar-group">
            {activeTerm && activeTerm.pid !== undefined && (
              <button
                className="statusbar-section statusbar-pid"
                onClick={() => onCopyPid(activeTerm.pid as number)}
                title="Cliquer pour copier le PID"
              >
                {pidCopied ? <Check size={11} /> : <Cpu size={11} />} PID&nbsp;
                {activeTerm.pid}
              </button>
            )}
            {activeTerm && activeTerm.status === 'running' && (
              <span className="statusbar-section statusbar-stats">
                <PaneStats paneId={activeTerm.id} />
              </span>
            )}
          </div>
        </>
      )}

      {/* Group 3 — Localisation (branch + cwd) */}
      {hasLocationGroup && active && (
        <>
          <span className="statusbar-divider" aria-hidden />
          <div className="statusbar-group">
            {active.branch && (
              <span className="statusbar-section" title={`Branche : ${active.branch}`}>
                <GitBranch size={11} /> {active.branch}
              </span>
            )}
            <span
              className="statusbar-section statusbar-path"
              title={activeTerm?.cwd ?? active.cwd}
            >
              <Folder size={11} /> {activeTerm?.cwd ?? active.cwd}
            </span>
          </div>
        </>
      )}

      <span className="statusbar-spacer" />

      {/* Group 4 — Ressources système */}
      {systemStats && (
        <>
          <div className="statusbar-group">
            <SystemStatsWidget
              stats={systemStats}
              history={systemCpuHistory}
            />
          </div>
          <span className="statusbar-divider" aria-hidden />
        </>
      )}

      {/* Group 5 — Attention + bell */}
      <div className="statusbar-group">
        {needsInputCount > 0 && (
          <button
            className={`statusbar-attention ${hasNeedsInput ? 'urgent' : 'soft'}`}
            onClick={() => {
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
      </div>

      <span className="statusbar-divider" aria-hidden />

      {/* Group 6 — Version */}
      <div className="statusbar-group">
        <span className="statusbar-section statusbar-version">
          vMux {version ? `v${version}` : ''}
        </span>
      </div>
    </div>
  );
}

export const StatusBar = memo(StatusBarImpl);

interface SystemStatsProps {
  stats: NonNullable<ReturnType<typeof useSessionStore.getState>['systemStats']>;
  history: Float32Array;
}

/** Mini-widget système : CPU machine + sparkline + RAM utilisée + part vMux.
 *  Rendu uniquement quand au moins 1 pane tourne (sinon stats === null). */
function SystemStatsWidget({ stats, history }: SystemStatsProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cpuColor =
    stats.cpu < 30 ? '#22c55e' : stats.cpu < 70 ? '#f97316' : '#ef4444';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = 48;
    const cssH = 14;
    if (canvas.width !== cssW * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const len = history.length;
    if (len < 2) return;
    const step = cssW / 149; // STATS_WINDOW - 1
    const startX = cssW - (len - 1) * step;
    ctx.strokeStyle = cpuColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = startX + i * step;
      const y = cssH - (history[i] / 100) * (cssH - 2) - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [history, cpuColor]);

  const memUsedGb = stats.memoryUsed / (1024 * 1024 * 1024);
  const memTotalGb = stats.memoryTotal / (1024 * 1024 * 1024);
  const memPct = (stats.memoryUsed / stats.memoryTotal) * 100;
  const vmuxMemMb = stats.vmuxMemory / (1024 * 1024);
  const vmuxMemPart = (stats.vmuxMemory / stats.memoryTotal) * 100;

  const tooltip = [
    `CPU machine : ${stats.cpu.toFixed(1)}% (${stats.cores} cœurs)`,
    `vMux + agents : ${stats.vmuxCpu.toFixed(1)}% CPU · ${vmuxMemMb.toFixed(0)} MB (${vmuxMemPart.toFixed(1)}%)`,
    `RAM système : ${memUsedGb.toFixed(1)} / ${memTotalGb.toFixed(1)} GB (${memPct.toFixed(0)}%)`
  ].join('\n');

  return (
    <span
      className="statusbar-section statusbar-system"
      title={tooltip}
      aria-label={`Ressources système. ${tooltip.replace(/\n/g, '. ')}`}
    >
      <Server size={11} style={{ color: cpuColor }} />
      <span className="statusbar-system-cpu" style={{ color: cpuColor }}>
        {Math.round(stats.cpu)}%
      </span>
      <canvas
        ref={canvasRef}
        className="statusbar-system-spark"
        aria-label={`Historique CPU 60s — actuel ${stats.cpu.toFixed(1)}%`}
      />
      <MemoryStick size={11} style={{ marginLeft: 6, opacity: 0.7 }} />
      <span className="statusbar-system-mem">
        {memUsedGb.toFixed(1)}/{memTotalGb.toFixed(0)}G
      </span>
    </span>
  );
}
