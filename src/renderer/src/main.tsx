import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DetachedApp } from './DetachedApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/global.css';
import '@xterm/xterm/css/xterm.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

/** Détecte le mode détaché via le hash route — `#detached=<sessionId>`.
 *  Gelé au boot : un changement de hash en runtime ne switch pas le mode.
 *  Valide la forme UUID v4 pour ne PAS faire confiance aveuglément à un hash
 *  potentiellement modifié (le sessionId sert ensuite de clé dans le store et
 *  doit pouvoir être loggé/sérialisé en toute sécurité). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function getDetachedSessionId(): string | null {
  const m = window.location.hash.match(/^#detached=(.+)$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return UUID_RE.test(id) ? id : null;
}

const detachedSessionId = getDetachedSessionId();

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {detachedSessionId ? <DetachedApp sessionId={detachedSessionId} /> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
