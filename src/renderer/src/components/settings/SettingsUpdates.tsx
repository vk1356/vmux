import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import {
  Download,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ExternalLink
} from 'lucide-react';
import type { UpdateStatus } from '@shared/types';
import { useT } from '../../i18n';

/** Onglet Mises à jour : version actuelle, check manuel, statut live. */
export function SettingsUpdates(): JSX.Element {
  const t = useT();
  const [version, setVersion] = useState<string>('');
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const versionId = useId();
  const statusId = useId();

  useEffect(() => {
    let alive = true;
    void window.cmux.app.version().then((v) => {
      if (alive) setVersion(v);
    });
    const unsub = window.cmux.updater.onStatus((s) => {
      setStatus(s);
      if (s.kind === 'checking') setCheckedAt(Date.now());
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const onCheck = useCallback((): void => {
    setStatus({ kind: 'checking' });
    setCheckedAt(Date.now());
    void window.cmux.updater.check();
    const timeoutId = setTimeout(() => {
      setStatus((cur) =>
        cur.kind === 'checking'
          ? {
              kind: 'error',
              code: 'no-response',
              message: 'No response from update server. Check your internet connection.'
            }
          : cur
      );
    }, 60000);
    // Best-effort cleanup if the user navigates away during the wait; we can't
    // cancel the timeout from outside the closure but storing it on window is
    // unnecessary — setStatus checks `cur.kind === 'checking'` so a stale
    // resolution is a no-op.
    void timeoutId;
  }, []);

  const onDownload = useCallback((): void => {
    void window.cmux.updater.download();
  }, []);
  const onInstall = useCallback((): void => {
    void window.cmux.updater.install();
  }, []);

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={versionId}>
          {t('fieldInstalledVersion')}
        </label>
        <div
          id={versionId}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <code style={{ fontSize: 13, color: 'var(--text)' }}>vMux {version || '…'}</code>
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={statusId}>
          {t('fieldStatus')}
        </label>
        <div id={statusId}>
          <UpdateStatusLine status={status} checkedAt={checkedAt} />
        </div>
      </div>

      <div className="field" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          onClick={onCheck}
          disabled={status.kind === 'checking' || status.kind === 'downloading'}
        >
          <RefreshCw size={12} className={status.kind === 'checking' ? 'spin' : undefined} />
          {t('updateCheck')}
        </button>
        {status.kind === 'available' && (
          <button type="button" className="btn primary" onClick={onDownload}>
            <Download size={12} /> {t('updateDownload')}
            {status.version}
          </button>
        )}
        {status.kind === 'downloaded' && (
          <button type="button" className="btn primary" onClick={onInstall}>
            <CheckCircle2 size={12} /> {t('updateInstall')}
          </button>
        )}
      </div>

      <div className="hint">{t('updateAutoHint')}</div>

      <div className="field" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn"
          onClick={() =>
            window.cmux.dialog.openExternal('https://github.com/vk1356/vmux/releases')
          }
        >
          {t('updateSeeAll')} <ExternalLink size={11} />
        </button>
      </div>
    </>
  );
}

interface StatusLineProps {
  status: UpdateStatus;
  checkedAt: number | null;
}

function UpdateStatusLine({ status, checkedAt }: StatusLineProps): JSX.Element {
  const t = useT();
  switch (status.kind) {
    case 'idle':
      return <span style={{ color: 'var(--text-muted)' }}>{t('updateNoCheck')}</span>;
    case 'checking':
      return (
        <span style={{ color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={11} className="spin" /> {t('updateChecking')}
        </span>
      );
    case 'not-available':
      return (
        <span style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle2 size={11} /> {t('updateUpToDate')} (v{status.currentVersion})
          {checkedAt && ` — ${secondsAgo(checkedAt)}`}
        </span>
      );
    case 'available':
      return (
        <span style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Download size={11} /> {t('updateAvailable')} (v{status.version})
        </span>
      );
    case 'downloading': {
      const pct = Math.round(status.percent);
      const mbs = (status.bytesPerSecond / 1024 / 1024).toFixed(1);
      return (
        <span style={{ color: 'var(--info)' }}>
          {t('updateDownloading')} {pct}% — {mbs} MB/s
        </span>
      );
    }
    case 'downloaded':
      return (
        <span style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle2 size={11} /> {t('updateReady')} (v{status.version})
        </span>
      );
    case 'error':
      return (
        <span style={{ color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={11} /> {t('updateError')}: {translateUpdateError(t, status)}
        </span>
      );
  }
}

/** Traduit un message d'erreur d'update si on a un `code` connu, sinon affiche
 *  le message brut renvoyé par le main. */
function translateUpdateError(
  t: (k: import('../../i18n').TKey) => string,
  status: Extract<UpdateStatus, { kind: 'error' }>
): string {
  switch (status.code) {
    case 'install-no-download':
      return t('errInstallNoDownload');
    case 'no-installer-url':
      return t('errNoInstallerUrl');
    case 'github-api-failed':
      return t('errGithubApiFailed');
    case 'no-response':
      return t('errNoResponse');
    case 'dev-mode':
      return t('errDevMode');
    default:
      return status.message;
  }
}

function secondsAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}
