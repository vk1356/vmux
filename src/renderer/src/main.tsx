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
 *  Gelé au boot : un changement de hash en runtime ne switch pas le mode. */
function getDetachedSessionId(): string | null {
  const m = window.location.hash.match(/^#detached=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const detachedSessionId = getDetachedSessionId();

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {detachedSessionId ? <DetachedApp sessionId={detachedSessionId} /> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
