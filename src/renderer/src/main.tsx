import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DetachedApp } from './DetachedApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { schedulePrewarm } from './store/xtermPrewarm';
import './styles/global.css';
import '@xterm/xterm/css/xterm.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

/** Détecte le mode détaché via le hash route — `#detached=<sessionId>`.
 *  Gelé au boot : un changement de hash en runtime ne switch pas le mode.
 *  Valide la forme UUID v1-7 pour ne PAS faire confiance aveuglément à un hash
 *  potentiellement modifié (le sessionId sert ensuite de clé dans le store et
 *  doit pouvoir être loggé/sérialisé en toute sécurité). On accepte v1..v7 pour
 *  rester forward-compatible avec d'éventuels backends générateurs (crypto.randomUUID
 *  émet du v4, mais certains libs Node émettent du v7 désormais). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function getDetachedSessionId(): string | null {
  const m = window.location.hash.match(/^#detached=(.+)$/);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    // Hash malformé (%-encoding cassé) → on ignore, on retombe en mode normal.
    return null;
  }
  return UUID_RE.test(id) ? id : null;
}

const detachedSessionId = getDetachedSessionId();

// Filets de sécurité globaux : ErrorBoundary ne capture QUE les erreurs de
// render. Les rejections de Promises fire-and-forget (`void window.cmux.*`)
// et les exceptions dans des event handlers async passent à côté. Sans ces
// listeners, ces erreurs sont silencieuses en prod — on les loggue au moins
// dans la console pour qu'elles apparaissent dans la diagnostic export.
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[vmux] uncaught error', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[vmux] unhandled rejection', e.reason);
});

// StrictMode reste actif en dev — double-invoque les effets pour révéler les
// fuites de cleanup ; aucun bug actuel n'en dépend. Pas de polyfills : tous
// les browsers Electron-supported couvrent ES2023.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {detachedSessionId !== null ? (
        <DetachedApp sessionId={detachedSessionId} />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);

// Pré-warm xterm.js en idle time après le first paint. Réduit le temps de
// mount du premier TerminalPane (charge Unicode11 widths, JIT-warmup xterm,
// alloue les caches V8 internes).
schedulePrewarm();
