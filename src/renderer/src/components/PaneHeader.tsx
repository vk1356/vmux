import { memo, useCallback, useEffect, useState, type JSX, type MouseEvent } from 'react';
import { X, Globe, Terminal as TerminalIcon, Moon, Clock } from 'lucide-react';
import type { Pane, TerminalPane as TerminalPaneT } from '@shared/types';
import { hostFromUrl } from '@shared/utils';
import { useSessionStore } from '../store/sessions';
import { useT } from '../i18n';
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

/** Style constants — hissés hors du composant pour rester identité-stable
 *  d'un render à l'autre (sinon `memo` se déclenche sur chaque tick du store). */
const DOT_STYLE = { width: 6, height: 6 } as const;
const ICON_STYLE = { color: 'var(--info)' } as const;

function PaneHeaderImpl({ sessionId, pane, active, accent }: Props): JSX.Element {
  const attention = useSessionStore((s) => s.paneActivity[pane.id] ?? 'idle');
  const t = useT();
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
    icon = <Globe size={11} style={ICON_STYLE} />;
  }

  const uptime = useUptime(term?.lastStartedAt);
  const isStale = useStaleness(term);
  const isTyping = useIsTyping(isRunningTerm ? term?.lastOutputAt : undefined);

  // Close handler stable — sinon chaque re-render du header recrée la lambda
  // et invalide le sub-component du bouton (négligeable mais propre).
  const onClose = useCallback(
    (e: MouseEvent): void => {
      e.stopPropagation();
      void window.cmux.panes.close(sessionId, pane.id);
    },
    [sessionId, pane.id]
  );

  // Style d'accent : on n'alloue que si accent défini. Hors de ce cas,
  // on partage DOT_STYLE et le `color` du span est piloté en CSS via la classe.
  const dotStyle = accent ? { ...DOT_STYLE, color: accent } : DOT_STYLE;

  return (
    <div className={`pane-header ${active ? 'active' : ''} attention-${attention}`}>
      <span className={`session-dot ${dotClass}`} style={dotStyle} />
      <span className="pane-header-icon">{icon}</span>
      <span className="pane-header-label" title={label}>
        {label}
      </span>
      {isTyping && (
        <span
          className="pane-header-typing"
          title={t('paneTypingTitle')}
          aria-label={t('paneTypingAria')}
        >
          <span />
          <span />
          <span />
        </span>
      )}
      {isRunningTerm && uptime && (
        <span className="pane-header-uptime" title={t('paneStartedAgo', { uptime })}>
          <Clock size={9} /> {uptime}
        </span>
      )}
      {/* Stale et typing sont mutuellement exclusifs : un agent qui tape n'est pas stale. */}
      {isStale && !isTyping && (
        <span className="pane-header-stale" title={t('paneStaleHint')}>
          <Moon size={10} />
        </span>
      )}
      {isRunningTerm && <PaneStats paneId={pane.id} compact />}
      <button
        className="pane-header-close"
        onClick={onClose}
        title={t('paneCloseTitle')}
        aria-label={t('paneCloseAria')}
        type="button"
      >
        <X size={11} />
      </button>
    </div>
  );
}

export const PaneHeader = memo(PaneHeaderImpl);

/** Re-render toutes les 30s pour rafraîchir l'uptime affiché. 30s = granularité
 *  utile (les minutes changent rarement, on ne perd rien à <30s). On stocke
 *  la string formatée directement et ne re-render que si elle change. */
function useUptime(lastStartedAt: number | undefined): string | null {
  const [label, setLabel] = useState<string | null>(() =>
    lastStartedAt ? formatDuration(Date.now() - lastStartedAt) : null
  );
  useEffect(() => {
    if (!lastStartedAt) {
      setLabel(null);
      return;
    }
    // Recompute immédiatement (lastStartedAt vient peut-être de changer).
    setLabel(formatDuration(Date.now() - lastStartedAt));
    const id = setInterval(() => {
      const next = formatDuration(Date.now() - lastStartedAt);
      // setState avec valeur identique : React déjà bailout, mais on évite
      // l'appel pour de bon (réduit le bruit dans React DevTools).
      setLabel((prev) => (prev === next ? prev : next));
    }, 30_000);
    return () => clearInterval(id);
  }, [lastStartedAt]);
  return label;
}

/** Détecte si un agent est "en train d'écrire" : output PTY < 1.5s.
 *  Tick 600ms. setState bailout-aware : on ne déclenche un render que si la
 *  valeur change réellement (avant : `setTyping(...)` à chaque tick → 1 render
 *  toutes les 600ms par PaneHeader, même quand l'état est stable). */
function useIsTyping(lastOutputAt: number | undefined): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!lastOutputAt) {
      setTyping(false);
      return;
    }
    const check = (): void => {
      const next = Date.now() - lastOutputAt < 1500;
      setTyping((prev) => (prev === next ? prev : next));
    };
    check();
    const id = setInterval(check, 600);
    return () => clearInterval(id);
  }, [lastOutputAt]);
  return typing;
}

/** Détecte si un pane terminal est "stale" : aucun output PTY depuis 5min.
 *  Re-check toutes les 30s. Sur les panes morts/restart, retourne false. */
function useStaleness(pane: TerminalPaneT | null): boolean {
  const [stale, setStale] = useState(false);
  const lastOutputAt = pane?.lastOutputAt;
  const status = pane?.status;
  useEffect(() => {
    if (!pane || status !== 'running' || !lastOutputAt) {
      setStale(false);
      return;
    }
    const check = (): void => {
      const age = Date.now() - lastOutputAt;
      const next = age > STALE_THRESHOLD_MS;
      setStale((prev) => (prev === next ? prev : next));
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
    // `pane` lui-même n'est pas dans les deps : seuls les 2 fields lus comptent.
  }, [pane, lastOutputAt, status]);
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
