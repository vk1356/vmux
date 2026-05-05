import { useEffect, useState, type JSX } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';

export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.cmux.window.isMaximized().then(setMaximized);
    return window.cmux.window.onMaximizedChanged(setMaximized);
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
            <path
              d="M5 6 L11.5 18 L18 6"
              stroke="#1a0a00"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="titlebar-brand-name">vMux</span>
      </div>
      <span className="titlebar-title">orchestrateur multi-agents IA</span>
      <div className="titlebar-spacer" />
      <div className="titlebar-actions">
        <button
          className="titlebar-button"
          onClick={() => window.cmux.window.minimize()}
          aria-label="Réduire"
          title="Réduire"
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-button"
          onClick={() => window.cmux.window.maximize()}
          aria-label={maximized ? 'Restaurer' : 'Agrandir'}
          title={maximized ? 'Restaurer' : 'Agrandir'}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          className="titlebar-button danger"
          onClick={() => window.cmux.window.close()}
          aria-label="Fermer"
          title="Fermer"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
