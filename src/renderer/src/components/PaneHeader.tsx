import { memo, type JSX } from 'react';
import { X, Globe, Terminal as TerminalIcon } from 'lucide-react';
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

function PaneHeaderImpl({ sessionId, pane, active, accent }: Props): JSX.Element {
  const attention = useSessionStore((s) => s.paneActivity[pane.id] ?? 'idle');
  let label = pane.label || '';
  let dotClass = 'idle';
  let icon: JSX.Element;
  let isRunningTerm = false;

  if (pane.kind === 'terminal') {
    const t = pane as TerminalPaneT;
    label = label || t.agentId;
    dotClass = t.status;
    icon = <TerminalIcon size={11} />;
    isRunningTerm = t.status === 'running';
  } else {
    label = label || hostFromUrl(pane.url);
    dotClass = 'running';
    icon = <Globe size={11} style={{ color: 'var(--info)' }} />;
  }

  return (
    <div className={`pane-header ${active ? 'active' : ''} attention-${attention}`}>
      <span className={`session-dot ${dotClass}`} style={{ width: 6, height: 6, color: accent }} />
      <span className="pane-header-icon">{icon}</span>
      <span className="pane-header-label" title={label}>
        {label}
      </span>
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
