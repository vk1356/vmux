import React, { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  AlertCircle,
  Loader2
} from 'lucide-react';
import type { PreviewPane as PreviewPaneT, TerminalPane } from '@shared/types';
import { useSessionStore } from '../store/sessions';

interface Props {
  sessionId: string;
  pane: PreviewPaneT;
  active: boolean;
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
}

function PreviewPaneImpl({ sessionId, pane, active }: Props): JSX.Element {
  const ref = useRef<WebviewElement | null>(null);
  const [addr, setAddr] = useState(pane.url);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

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
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-fail-load', onFail as EventListener);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-fail-load', onFail as EventListener);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
    };
  }, []);

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
          title="Précédent"
          aria-label="Précédent"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="btn-icon"
          onClick={forward}
          disabled={!canForward}
          title="Suivant"
          aria-label="Suivant"
        >
          <ArrowRight size={14} />
        </button>
        <button className="btn-icon" onClick={reload} title="Recharger" aria-label="Recharger">
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
          className="btn-icon"
          onClick={openExternal}
          title="Ouvrir dans le navigateur"
          aria-label="Ouvrir dans le navigateur"
        >
          <ExternalLink size={14} />
        </button>
        <button
          className="btn-icon"
          onClick={() => {
            // Marque la session comme "preview dismissé" → pas d'auto-open
            // jusqu'à ce que le user en relance un manuellement.
            dismissPreview(sessionId);
            void window.cmux.panes.close(sessionId, pane.id);
          }}
          title="Fermer le preview"
          aria-label="Fermer le preview"
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
            <div className="preview-error-title">Impossible de charger {addr}</div>
            <div className="preview-error-sub">
              Le serveur n'est peut-être pas encore prêt. Réessaye dans quelques secondes.
            </div>
            <button className="btn primary" onClick={reload}>
              <RotateCw size={14} /> Recharger
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const PreviewPane = memo(PreviewPaneImpl);
