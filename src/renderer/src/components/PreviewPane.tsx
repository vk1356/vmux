import React, { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
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
import { useSessionStore } from '../store/sessions';
import { useT } from '../i18n';

interface Props {
  sessionId: string;
  pane: PreviewPaneT;
  active: boolean;
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

const MAX_LOGS = 500;

function PreviewPaneImpl({ sessionId, pane, active }: Props): JSX.Element {
  const t = useT();
  const ref = useRef<WebviewElement | null>(null);
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
    const session = s.sessions.find((x) => x.id === sessionId);
    return (session?.panes[pane.followsPaneId] as TerminalPane | undefined) ?? null;
  });

  // Suivi auto de l'URL la plus récente du pane terminal référencé.
  useEffect(() => {
    if (!pane.followsPaneId || !followingPane?.recentUrls?.length) return;
    const latest = followingPane.recentUrls[followingPane.recentUrls.length - 1];
    if (latest && latest !== pane.url) {
      setAddr(latest);
      void window.cmux.panes.setUrl(sessionId, pane.id, latest);
      ref.current?.loadURL(latest).catch(() => setFailed(true));
    }
  }, [followingPane?.recentUrls, pane.followsPaneId, pane.url, pane.id, sessionId]);

  // Wire les events <webview> via DOM addEventListener (pas de React props pour ces events).
  useEffect(() => {
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
      // -3 = aborted (navigation Cancelled, ignore)
      if (ev.errorCode === -3) return;
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

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-fail-load', onFail as EventListener);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('console-message', onConsole as EventListener);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-fail-load', onFail as EventListener);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('console-message', onConsole as EventListener);
    };
  }, []);

  // Helper qui push un log et cap la taille à MAX_LOGS (FIFO).
  const pushLog = useCallback((entry: Omit<ConsoleLog, 'id' | 'ts'>): void => {
    setLogs((cur) => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const next = [...cur, { ...entry, id, ts: Date.now() }];
      if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
      return next;
    });
  }, []);

  // Auto-scroll en bas quand un nouveau log arrive et que la console est visible.
  useEffect(() => {
    if (!consoleOpen) return;
    const el = logsScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, consoleOpen]);

  const onAddrSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      const url = addr.startsWith('http://') || addr.startsWith('https://') ? addr : `http://${addr}`;
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

  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.level === filter);
  const errorCount = logs.filter((l) => l.level === 'error').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;

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

      <div className="preview-host">
        {/* eslint-disable-next-line react/no-unknown-property */}
        {React.createElement<WebviewProps>('webview', {
          ref: (el: HTMLElement | null) => {
            ref.current = el as unknown as WebviewElement;
          },
          src: pane.url,
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
              count={logs.filter((l) => l.level === 'log' || l.level === 'info').length}
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
              filteredLogs.map((l) => <ConsoleEntry key={l.id} entry={l} />)
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
