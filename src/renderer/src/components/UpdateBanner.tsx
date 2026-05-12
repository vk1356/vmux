import { useEffect, useState, type JSX } from 'react';
import { Download, RefreshCw, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { UpdateStatus } from '@shared/types';
import { useT } from '../i18n';

const DISMISSED_KEY = 'vmux-update-dismissed-version';

/** Bannière de mise à jour. Affichée dès qu'electron-updater détecte une nouvelle
 *  release GitHub. L'user peut télécharger puis installer (redémarrage auto).
 *
 *  Persistance du dismiss : on stocke la version dismissée en localStorage,
 *  pas un booléen. Sans ça, fermer la bannière puis recharger réaffiche la
 *  même version (et même au sein d'une session, electron-updater peut ré-émettre
 *  le status à chaque recheck). Quand une *nouvelle* version sort, on re-affiche. */
export function UpdateBanner(): JSX.Element | null {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [dismissedVersion, setDismissedVersion] = useState<string>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    return window.cmux.updater.onStatus((s) => {
      setStatus(s);
    });
  }, []);

  const dismiss = (version: string | undefined): void => {
    const v = version ?? '';
    try {
      localStorage.setItem(DISMISSED_KEY, v);
    } catch {
      /* quota / disabled — best-effort */
    }
    setDismissedVersion(v);
  };

  // Hide la bannière si la version courante a déjà été dismissée.
  // Pour les statuts sans version (error sans version, downloading sans version),
  // on permet le dismiss via la valeur sentinelle vide.
  const versionForStatus =
    'version' in status && typeof status.version === 'string' ? status.version : '';
  if (dismissedVersion && dismissedVersion === versionForStatus) return null;
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
      <div className="update-banner update-banner-available" role="status" aria-live="polite">
        <Download size={14} />
        <div className="update-banner-text">
          <strong>{t('bannerAvailable')}</strong>
          <span>{t('bannerAvailableBody', { version: status.version })}</span>
        </div>
        <button className="btn btn-primary update-banner-action" onClick={onDownload}>
          {t('bannerDownloadBtn')}
        </button>
        <button
          className="btn-icon update-banner-close"
          onClick={() => dismiss(versionForStatus)}
          title={t('bannerLater')}
          aria-label={t('bannerLater')}
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
      <div
        className="update-banner update-banner-downloading"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        <RefreshCw size={14} className="spin" />
        <div className="update-banner-text">
          <strong>{t('bannerDownloading', { pct })}</strong>
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
      <div className="update-banner update-banner-ready" role="status" aria-live="polite">
        <CheckCircle2 size={14} />
        <div className="update-banner-text">
          <strong>{t('bannerReady')}</strong>
          <span>{t('bannerReadyBody', { version: status.version })}</span>
        </div>
        <button className="btn btn-primary update-banner-action" onClick={onInstall}>
          {t('bannerInstallBtn')}
        </button>
        <button
          className="btn-icon update-banner-close"
          onClick={() => dismiss(versionForStatus)}
          title={t('bannerLater')}
          aria-label={t('bannerLater')}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="update-banner update-banner-error" role="alert" aria-live="assertive">
        <AlertTriangle size={14} />
        <div className="update-banner-text">
          <strong>{t('bannerError')}</strong>
          <span>{status.message}</span>
        </div>
        <button
          className="btn-icon update-banner-close"
          onClick={() => dismiss(versionForStatus)}
          title={t('bannerLater')}
          aria-label={t('bannerLater')}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return null;
}
