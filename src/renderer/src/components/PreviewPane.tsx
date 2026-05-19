import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  AlertCircle,
  Loader2,
  Terminal,
  Trash2,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import type { PreviewPane as PreviewPaneT, TerminalPane } from '@shared/types';
import { uuid } from '@shared/utils';
import { useSessionStore } from '../store/sessions';
import { useT } from '../i18n';

interface Props {
  sessionId: string;
  pane: PreviewPaneT;
  active: boolean;
  /** Visible = la session parente est l'active. Quand false, on démontre le
   *  <webview> pour libérer le process Chrome (gros gain quand l'user a 10+
   *  sessions empilées dans la sidebar). */
  visible: boolean;
}

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
interface ConsoleLog {
  id: string;
  level: ConsoleLevel;
  message: string;
  source?: string;
  line?: number;
  ts: number;
}

// Le type DOM React de <webview> est legacy (allowpopups: boolean) mais
// Electron attend "true" (string). On caste les props pour passer outre.
type WebviewProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  webpreferences?: string;
};

interface WebviewElement extends HTMLElement {
  src: string;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  openDevTools(): void;
}

const LEVEL_FROM_CODE: Record<number, ConsoleLevel> = {
  0: 'log',
  1: 'warn',
  2: 'error',
  3: 'info'
};

/** Schémas autorisés dans la barre d'adresse + dans pane.url. Tout le reste
 *  (javascript:, file:, data:, chrome:, …) est bloqué pour ne pas exécuter
 *  de code arbitraire dans le contexte de la <webview>. */
function sanitizeUrl(input: string): string | null {
  const trimmed = input.trim().replace(/^<+|>+$/g, '');
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      // URL constructor valide la syntaxe (rejette les espaces non-encoded, etc.)
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
  // Schéma reconnu mais non-http → bloque (javascript:, file:, data:, …).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  // Sans schéma : on assume http (cas typique : "localhost:3000").
  try {
    return new URL(`http://${trimmed}`).toString();
  } catch {
    return null;
  }
}

const MAX_LOGS = 500;
/** Quand on a > VISIBLE_LOGS entrées, on ne rend que les VISIBLE_LOGS dernières
 *  pour cap le coût DOM (chaque entry = ~3-4 nodes × 500 = 2000 nodes minimum).
 *  Le scrollback complet reste en mémoire pour le filter, juste pas peint.
 *  Un banner "older entries hidden" laisse l'option d'augmenter au runtime. */
const VISIBLE_LOGS = 200;

function PreviewPaneImpl({ sessionId, pane, active, visible }: Props): JSX.Element {
  const t = useT();
  const ref = useRef<WebviewElement | null>(null);
  // Lazy-mount du <webview> : invisible → on retire le webview du DOM et son
  // process Chrome est libéré. Au retour visible, on remonte avec la dernière URL.
  // L'addr/logs restent en React state donc rien n'est perdu côté UX.
  const [addr, setAddr] = useState(pane.url);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<ConsoleLog[]>([]);
  const [filter, setFilter] = useState<ConsoleLevel | 'all'>('all');
  const logsScrollRef = useRef<HTMLDivElement | null>(null);

  const dismissPreview = useSessionStore((s) => s.dismissPreview);

  const followingPane = useSessionStore((s) => {
    if (!pane.followsPaneId) return null;
    // O(1) via sessionsById index — évite un .find() O(N) qui re-tournait sur
    // chaque update du store (paneStats toutes les 2s, etc.).
    const session = s.sessionsById[sessionId];
    return (session?.panes[pane.followsPaneId] as TerminalPane | undefined) ?? null;
  });

  // Suivi auto de l'URL la plus récente du pane terminal référencé.
  useEffect(() => {
    if (!pane.followsPaneId || !followingPane?.recentUrls?.length) return;
    const latest = followingPane.recentUrls[followingPane.recentUrls.length - 1];
    if (!latest || latest === pane.url) return;
    // Même les URLs détectées en sortie de terminal passent par sanitizeUrl —
    // un agent qui imprime `javascript:alert(1)` ne doit pas charger ça dans
    // la <webview>.
    const safe = sanitizeUrl(latest);
    if (!safe) return;
    setAddr(safe);
    void window.cmux.panes.setUrl(sessionId, pane.id, safe);
    ref.current?.loadURL(safe).catch(() => setFailed(true));
  }, [followingPane?.recentUrls, pane.followsPaneId, pane.url, pane.id, sessionId]);

  // Re-sync `addr` quand pane.url change depuis l'extérieur (URL chip click,
  // command palette, etc.). On évite la boucle infinie avec le check d'égalité
  // — sinon chaque set local re-déclenche un setAddr identique.
  useEffect(() => {
    if (pane.url && pane.url !== addr) {
      setAddr(pane.url);
      ref.current?.loadURL(pane.url).catch(() => setFailed(true));
    }
    // addr volontairement exclu : on ne veut réagir qu'aux MAJ externes
    // de pane.url, pas aux frappes dans l'input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.url]);

  // Wire les events <webview> via DOM addEventListener (pas de React props pour ces events).
  // Re-run quand `visible` change car la <webview> est unmount/remount.
  useEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el) return;
    const onStart = (): void => {
      setLoading(true);
      setFailed(false);
    };
    const onStop = (): void => {
      setLoading(false);
      try {
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
      } catch {
        setCanBack(false);
        setCanForward(false);
      }
    };
    const onFail = (e: Event): void => {
      const ev = e as Event & { errorCode?: number; errorDescription?: string };
      // -3 = aborted (navigation Cancelled) — pas un échec mais ne pas
      // laisser le spinner bloqué : did-stop-loading ne fire pas sur abort.
      if (ev.errorCode === -3) {
        setLoading(false);
        return;
      }
      setLoading(false);
      setFailed(true);
      // Affiche aussi l'erreur dans la console intégrée.
      pushLog({
        level: 'error',
        message: `Failed to load: ${ev.errorDescription ?? 'unknown error'} (code ${ev.errorCode})`,
        source: 'webview'
      });
    };
    const onNav = (): void => {
      try {
        setAddr(el.getURL());
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
      } catch {
        /* webview pas encore initialisée */
      }
    };
    // Intercept console.* depuis la webview.
    type ConsoleMsgEvent = Event & {
      level: number;
      message: string;
      line: number;
      sourceId: string;
    };
    const onConsole = (e: Event): void => {
      const ev = e as ConsoleMsgEvent;
      pushLog({
        level: LEVEL_FROM_CODE[ev.level] ?? 'log',
        message: ev.message,
        source: ev.sourceId,
        line: ev.line
      });
    };

    // Webview crashed / killed → on log et on affiche l'erreur. Sans ça,
    // le spinner pouvait rester bloqué indéfiniment quand le renderer guest meurt.
    const onCrash = (): void => {
      setLoading(false);
      setFailed(true);
      pushLog({
        level: 'error',
        message: 'Webview renderer crashed',
        source: 'webview'
      });
    };
    // Bloque les navigations vers des schémas non-http (paranoia : un site
    // chargé pourrait tenter window.location = 'file:///…').
    const onWillNav = (e: Event): void => {
      const ev = e as Event & { url?: string };
      if (ev.url && !sanitizeUrl(ev.url)) {
        // Pas de preventDefault sur did-* events ; loadURL('about:blank') stoppe.
        try {
          el.loadURL('about:blank');
        } catch {
          /* swallow */
        }
      }
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-fail-load', onFail as EventListener);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('console-message', onConsole as EventListener);
    el.addEventListener('crashed', onCrash);
    el.addEventListener('destroyed', onCrash);
    el.addEventListener('will-navigate', onWillNav as EventListener);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-fail-load', onFail as EventListener);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('console-message', onConsole as EventListener);
      el.removeEventListener('crashed', onCrash);
      el.removeEventListener('destroyed', onCrash);
      el.removeEventListener('will-navigate', onWillNav as EventListener);
    };
    // pushLog est stable (useCallback []), pas besoin de l'ajouter aux deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Helper qui push un log et cap la taille à MAX_LOGS (FIFO).
  const pushLog = useCallback((entry: Omit<ConsoleLog, 'id' | 'ts'>): void => {
    setLogs((cur) => {
      const id = uuid();
      const next = [...cur, { ...entry, id, ts: Date.now() }];
      if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
      return next;
    });
  }, []);

  // Auto-scroll en bas quand un nouveau log arrive ET que l'user n'a pas scrollé
  // vers l'historique. Sans ce check, lire un vieux log était impossible : un
  // nouveau warn pendant la lecture re-scrollait au bas.
  useEffect(() => {
    if (!consoleOpen) return;
    const el = logsScrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 24) el.scrollTop = el.scrollHeight;
  }, [logs.length, consoleOpen]);

  const onAddrSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      const url = sanitizeUrl(addr);
      if (!url) {
        setFailed(true);
        return;
      }
      el.loadURL(url).catch(() => setFailed(true));
      void window.cmux.panes.setUrl(sessionId, pane.id, url);
    },
    [addr, pane.id, sessionId]
  );

  const reload = useCallback(() => {
    setFailed(false);
    ref.current?.reload();
  }, []);

  const back = useCallback(() => ref.current?.goBack(), []);
  const forward = useCallback(() => ref.current?.goForward(), []);
  const openExternal = useCallback(
    () => void window.cmux.dialog.openExternal(addr),
    [addr]
  );

  // useDeferredValue : quand le filter change rapidement (l'user tape sur 4
  // filters d'affilée) ou que `logs` augmente vite (console crachant 50 entries/s),
  // React peut prioriser l'input/UI et rendre la liste filtrée "à la traîne".
  const deferredFilter = useDeferredValue(filter);
  const deferredLogs = useDeferredValue(logs);
  const filteredLogs = useMemo(() => {
    if (deferredFilter === 'all') return deferredLogs;
    // "log" englobe log/info/debug pour cohérence avec DevTools — le bug avant
    // était que seul level=='log' passait, donc console.info() était invisible.
    if (deferredFilter === 'log') {
      return deferredLogs.filter(
        (l) => l.level === 'log' || l.level === 'info' || l.level === 'debug'
      );
    }
    return deferredLogs.filter((l) => l.level === deferredFilter);
  }, [deferredLogs, deferredFilter]);
  // Window de rendu : dernières VISIBLE_LOGS entrées seulement. Au-delà,
  // on aurait des centaines de nodes DOM à reconcile à chaque push.
  const renderedLogs =
    filteredLogs.length > VISIBLE_LOGS ? filteredLogs.slice(-VISIBLE_LOGS) : filteredLogs;
  const hiddenLogs = filteredLogs.length - renderedLogs.length;
  // Count en une seule passe — avant on filtrait `logs` deux fois par render
  // (errorCount + warnCount) sur potentiellement 500 entrées. Ajout du logCount
  // ici pour éviter le 3e filter() inline dans le JSX.
  const { errorCount, warnCount, logCount } = useMemo(() => {
    let err = 0;
    let warn = 0;
    let log = 0;
    for (const l of logs) {
      if (l.level === 'error') err++;
      else if (l.level === 'warn') warn++;
      else if (l.level === 'log' || l.level === 'info' || l.level === 'debug') log++;
    }
    return { errorCount: err, warnCount: warn, logCount: log };
  }, [logs]);

  return (
    <div
      className={`preview-pane ${active ? 'active' : ''}`}
      onClick={() => window.cmux.panes.focus(sessionId, pane.id)}
    >
      <div className="preview-toolbar">
        <button
          className="btn-icon"
          onClick={back}
          disabled={!canBack}
          title={t('previewBack')}
          aria-label={t('previewBack')}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="btn-icon"
          onClick={forward}
          disabled={!canForward}
          title={t('previewForward')}
          aria-label={t('previewForward')}
        >
          <ArrowRight size={14} />
        </button>
        <button
          className="btn-icon"
          onClick={reload}
          title={t('previewReload')}
          aria-label={t('previewReload')}
        >
          {loading ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
        </button>
        <form onSubmit={onAddrSubmit} className="preview-addr">
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            spellCheck={false}
            placeholder="http://localhost:3000"
          />
        </form>
        <button
          className={`btn-icon preview-console-toggle ${consoleOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setConsoleOpen((v) => !v);
          }}
          title={consoleOpen ? t('previewConsoleHide') : t('previewConsoleShow')}
          aria-label="Console"
        >
          <Terminal size={14} />
          {(errorCount > 0 || warnCount > 0) && !consoleOpen && (
            <span
              className="preview-console-badge"
              style={{ background: errorCount > 0 ? 'var(--error)' : 'var(--warn)' }}
              aria-hidden
            >
              {errorCount > 0 ? errorCount : warnCount}
            </span>
          )}
        </button>
        <button
          className="btn-icon"
          onClick={openExternal}
          title={t('previewOpenExternal')}
          aria-label={t('previewOpenExternal')}
        >
          <ExternalLink size={14} />
        </button>
        <button
          className="btn-icon"
          onClick={() => {
            dismissPreview(sessionId);
            void window.cmux.panes.close(sessionId, pane.id);
          }}
          title={t('previewClose')}
          aria-label={t('previewClose')}
        >
          ×
        </button>
      </div>

      <div className="preview-host" aria-busy={loading || undefined}>
        {visible &&
          React.createElement<WebviewProps>('webview', {
            ref: (el: HTMLElement | null) => {
              // null à l'unmount : sans ça, ref.current pointait sur un node
              // détaché du DOM tant que le composant React vivait — toute
              // tentative de loadURL/getURL ratait silencieusement après
              // qu'on ait flippé visible=false → true (nouveau node créé).
              ref.current = el as unknown as WebviewElement | null;
            },
            // sanitizeUrl appelé sur pane.url aussi : si la persistence a un
            // jour stocké une URL malformée, on ne la charge pas.
            src: sanitizeUrl(addr || pane.url) ?? 'about:blank',
            partition: 'persist:cmux-preview',
            allowpopups: 'true',
            webpreferences: 'contextIsolation=yes,nodeIntegration=no',
            style: { width: '100%', height: '100%', display: 'inline-flex' }
          })}
        {failed && (
          <div className="preview-error">
            <AlertCircle size={20} />
            <div className="preview-error-title">{t('previewLoadFailed', { url: addr })}</div>
            <div className="preview-error-sub">{t('previewLoadFailedHint')}</div>
            <button className="btn primary" onClick={reload}>
              <RotateCw size={14} /> {t('previewReload')}
            </button>
          </div>
        )}
      </div>

      {consoleOpen && (
        <div className="preview-console" onClick={(e) => e.stopPropagation()}>
          <div className="preview-console-header">
            <span className="preview-console-title">
              <Terminal size={11} /> Console
            </span>
            <ConsoleFilterBtn
              label="All"
              count={logs.length}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            <ConsoleFilterBtn
              label="Errors"
              count={errorCount}
              active={filter === 'error'}
              onClick={() => setFilter('error')}
              tone="error"
            />
            <ConsoleFilterBtn
              label="Warnings"
              count={warnCount}
              active={filter === 'warn'}
              onClick={() => setFilter('warn')}
              tone="warn"
            />
            <ConsoleFilterBtn
              label="Logs"
              count={logCount}
              active={filter === 'log'}
              onClick={() => setFilter('log')}
            />
            <span style={{ flex: 1 }} />
            <button
              className="btn-icon"
              onClick={() => setLogs([])}
              title={t('previewConsoleClear')}
              aria-label={t('previewConsoleClear')}
            >
              <Trash2 size={11} />
            </button>
            <button
              className="btn-icon"
              onClick={() => setConsoleOpen(false)}
              title={t('previewConsoleHide')}
              aria-label={t('previewConsoleHide')}
            >
              <ChevronDown size={11} />
            </button>
          </div>
          <div className="preview-console-body" ref={logsScrollRef}>
            {filteredLogs.length === 0 ? (
              <div className="preview-console-empty">
                {logs.length === 0 ? t('previewConsoleEmpty') : t('previewConsoleEmptyFiltered')}
              </div>
            ) : (
              <>
                {hiddenLogs > 0 && (
                  <div
                    style={{
                      padding: '4px 8px',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      borderBottom: '1px solid var(--border)',
                      fontStyle: 'italic'
                    }}
                  >
                    {hiddenLogs} older entries hidden (showing last {renderedLogs.length})
                  </div>
                )}
                {renderedLogs.map((l) => (
                  <ConsoleEntry key={l.id} entry={l} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {!consoleOpen && (errorCount > 0 || warnCount > 0) && (
        <button
          className="preview-console-peek"
          onClick={(e) => {
            e.stopPropagation();
            setConsoleOpen(true);
          }}
          title="Cliquer pour ouvrir la console"
        >
          <ChevronUp size={11} />
          {errorCount > 0 && (
            <span style={{ color: 'var(--error)' }}>{errorCount} error{errorCount > 1 ? 's' : ''}</span>
          )}
          {warnCount > 0 && (
            <span style={{ color: 'var(--warn)' }}>{warnCount} warning{warnCount > 1 ? 's' : ''}</span>
          )}
        </button>
      )}
    </div>
  );
}

interface FilterBtnProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: 'error' | 'warn';
}

function ConsoleFilterBtn({ label, count, active, onClick, tone }: FilterBtnProps): JSX.Element {
  return (
    <button
      className={`preview-console-filter ${active ? 'active' : ''} ${tone ?? ''}`}
      onClick={onClick}
    >
      {label}
      <span className="preview-console-filter-count">{count}</span>
    </button>
  );
}

function ConsoleEntry({ entry }: { entry: ConsoleLog }): JSX.Element {
  const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
  return (
    <div className={`preview-console-entry level-${entry.level}`}>
      <span className="preview-console-entry-time">{time}</span>
      <span className="preview-console-entry-level">{entry.level}</span>
      <span className="preview-console-entry-msg">{entry.message}</span>
      {entry.source && entry.line !== undefined && (
        <span className="preview-console-entry-src">
          {shortSource(entry.source)}:{entry.line}
        </span>
      )}
    </div>
  );
}

function shortSource(src: string): string {
  try {
    const u = new URL(src);
    return u.pathname.split('/').pop() || u.host;
  } catch {
    return src.split('/').pop() || src;
  }
}

export const PreviewPane = memo(PreviewPaneImpl);
