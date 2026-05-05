import { useEffect, useState, type JSX } from 'react';
import { Download, RefreshCw, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { UpdateStatus } from '@shared/types';

/** Bannière de mise à jour. Affichée dès qu'electron-updater détecte une nouvelle
 *  release GitHub. L'user peut télécharger puis installer (redémarrage auto). */
export function UpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return window.cmux.updater.onStatus((s) => {
      setStatus(s);
      // Re-affiche si nouvelle update détectée après dismiss.
      if (s.kind === 'available' || s.kind === 'downloaded') setDismissed(false);
    });
  }, []);

  if (dismissed) return null;
  if (status.kind === 'idle' || status.kind === 'checking' || status.kind === 'not-available') {
    return null;
  }

  const onDownload = (): void => {
    void window.cmux.updater.download();
  };
  const onInstall = (): void => {
    void window.cmux.updater.install();
  };

  if (status.kind === 'available') {
    return (
      <div className="update-banner update-banner-available">
        <Download size={14} />
        <div className="update-banner-text">
          <strong>Mise à jour disponible</strong>
          <span>Version {status.version} prête à être téléchargée.</span>
        </div>
        <button className="btn btn-primary update-banner-action" onClick={onDownload}>
          Télécharger
        </button>
        <button
          className="btn-icon update-banner-close"
          onClick={() => setDismissed(true)}
          title="Plus tard"
          aria-label="Plus tard"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (status.kind === 'downloading') {
    const pct = Math.round(status.percent);
    const mbs = (status.bytesPerSecond / 1024 / 1024).toFixed(1);
    return (
      <div className="update-banner update-banner-downloading">
        <RefreshCw size={14} className="spin" />
        <div className="update-banner-text">
          <strong>Téléchargement en cours… {pct}%</strong>
          <span>{mbs} MB/s</span>
        </div>
        <div className="update-banner-progress">
          <div className="update-banner-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  if (status.kind === 'downloaded') {
    return (
      <div className="update-banner update-banner-ready">
        <CheckCircle2 size={14} />
        <div className="update-banner-text">
          <strong>Mise à jour prête</strong>
          <span>Version {status.version} — redémarre pour installer.</span>
        </div>
        <button className="btn btn-primary update-banner-action" onClick={onInstall}>
          Installer et redémarrer
        </button>
        <button
          className="btn-icon update-banner-close"
          onClick={() => setDismissed(true)}
          title="Plus tard"
          aria-label="Plus tard"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="update-banner update-banner-error">
        <AlertTriangle size={14} />
        <div className="update-banner-text">
          <strong>Échec de la mise à jour</strong>
          <span>{status.message}</span>
        </div>
        <button
          className="btn-icon update-banner-close"
          onClick={() => setDismissed(true)}
          title="Fermer"
          aria-label="Fermer"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return null;
}
