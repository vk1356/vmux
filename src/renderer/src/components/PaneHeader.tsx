import { memo, useEffect, useState, type JSX } from 'react';
import { X, Globe, Terminal as TerminalIcon, Moon, Clock } from 'lucide-react';
import type { Pane, TerminalPane as TerminalPaneT } from '@shared/types';
import { useSessionStore } from '../store/sessions';
import { PaneStats } from './PaneStats';

interface Props {
  sessionId: string;
  pane: Pane;
  active: boolean;
  /** Couleur d'accent du pane (depuis l'agent ou la session). */
  accent?: string;
}

/** Seuil de "stale" : pas d'output PTY depuis 5 min → on affiche 💤. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function PaneHeaderImpl({ sessionId, pane, active, accent }: Props): JSX.Element {
  const attention = useSessionStore((s) => s.paneActivity[pane.id] ?? 'idle');
  let label = pane.label || '';
  let dotClass = 'idle';
  let icon: JSX.Element;
  let isRunningTerm = false;
  let term: TerminalPaneT | null = null;

  if (pane.kind === 'terminal') {
    term = pane as TerminalPaneT;
    label = label || term.agentId;
    dotClass = term.status;
    icon = <TerminalIcon size={11} />;
    isRunningTerm = term.status === 'running';
  } else {
    label = label || hostFromUrl(pane.url);
    dotClass = 'running';
    icon = <Globe size={11} style={{ color: 'var(--info)' }} />;
  }

  const uptime = useUptime(term?.lastStartedAt);
  const isStale = useStaleness(term);

  return (
    <div className={`pane-header ${active ? 'active' : ''} attention-${attention}`}>
      <span className={`session-dot ${dotClass}`} style={{ width: 6, height: 6, color: accent }} />
      <span className="pane-header-icon">{icon}</span>
      <span className="pane-header-label" title={label}>
        {label}
      </span>
      {isRunningTerm && uptime && (
        <span className="pane-header-uptime" title={`Démarré il y a ${uptime}`}>
          <Clock size={9} /> {uptime}
        </span>
      )}
      {isStale && (
        <span className="pane-header-stale" title="Aucune sortie récente — agent peut-être idle">
          <Moon size={10} />
        </span>
      )}
      {isRunningTerm && <PaneStats paneId={pane.id} compact />}
      <button
        className="pane-header-close"
        onClick={(e) => {
          e.stopPropagation();
          void window.cmux.panes.close(sessionId, pane.id);
        }}
        title="Fermer ce pane"
        aria-label="Fermer le pane"
      >
        <X size={11} />
      </button>
    </div>
  );
}

export const PaneHeader = memo(PaneHeaderImpl);

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 24);
  }
}

/** Re-render toutes les 30s pour rafraîchir l'uptime affiché. 30s = granularité
 *  utile (les minutes changent rarement, on ne perd rien à <30s). */
function useUptime(lastStartedAt: number | undefined): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lastStartedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [lastStartedAt]);
  if (!lastStartedAt) return null;
  return formatDuration(Date.now() - lastStartedAt);
}

/** Détecte si un pane terminal est "stale" : aucun output PTY depuis 5min.
 *  Re-check toutes les 30s. Sur les panes morts/restart, retourne false. */
function useStaleness(pane: TerminalPaneT | null): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!pane || pane.status !== 'running' || !pane.lastOutputAt) {
      setStale(false);
      return;
    }
    const check = (): void => {
      const age = Date.now() - (pane.lastOutputAt ?? Date.now());
      setStale(age > STALE_THRESHOLD_MS);
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [pane?.lastOutputAt, pane?.status]);
  return stale;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const remainMin = min % 60;
  if (h < 24) return remainMin > 0 ? `${h}h${remainMin}` : `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}j`;
}
