import { useEffect, useState, type JSX } from 'react';
import {
  X,
  Palette,
  Bot,
  Sliders,
  ExternalLink,
  Bell,
  Globe,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import type { AgentId, AppSettings, UpdateStatus } from '@shared/types';
import { useSessionStore } from '../store/sessions';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'apparence' | 'terminal' | 'notifs' | 'agents' | 'updates' | 'avance';

const FONT_PRESETS = [
  '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  'Consolas, monospace',
  '"Courier New", monospace'
];

const SHELL_PRESETS = [
  { value: 'pwsh', label: 'PowerShell 7+ (pwsh)' },
  { value: 'powershell', label: 'Windows PowerShell 5 (powershell)' },
  { value: 'cmd', label: 'cmd.exe' },
  { value: 'bash', label: 'Git Bash (bash)' }
];

export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const { settings, agents, agentAvailability, patchSettings } = useSessionStore();
  const [tab, setTab] = useState<Tab>('apparence');
  const [saving, setSaving] = useState(false);

  if (!open || !settings) return null;

  const apply = async (patch: Partial<AppSettings>): Promise<void> => {
    setSaving(true);
    patchSettings(patch);
    try {
      await window.cmux.settings.set(patch);
    } finally {
      setSaving(false);
    }
  };

  const applyAgentOverride = async (
    id: AgentId,
    patch: Partial<{ command: string; args: string[] }>
  ): Promise<void> => {
    const overrides = {
      ...settings.agentOverrides,
      [id]: { ...settings.agentOverrides[id], ...patch }
    };
    await apply({ agentOverrides: overrides });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        style={{ width: 'min(720px, 92vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="dialog-title">Paramètres</div>
          <button className="btn-icon" onClick={onClose} aria-label="Fermer">
            <X size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', minHeight: 420 }}>
          {/* Tabs */}
          <div
            style={{
              width: 170,
              borderRight: '1px solid var(--border)',
              padding: '12px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2
            }}
          >
            <SettingsTabButton
              label="Apparence"
              icon={<Palette size={14} />}
              active={tab === 'apparence'}
              onClick={() => setTab('apparence')}
            />
            <SettingsTabButton
              label="Terminal"
              icon={<Sliders size={14} />}
              active={tab === 'terminal'}
              onClick={() => setTab('terminal')}
            />
            <SettingsTabButton
              label="Notifications"
              icon={<Bell size={14} />}
              active={tab === 'notifs'}
              onClick={() => setTab('notifs')}
            />
            <SettingsTabButton
              label="Agents"
              icon={<Bot size={14} />}
              active={tab === 'agents'}
              onClick={() => setTab('agents')}
            />
            <SettingsTabButton
              label="Mises à jour"
              icon={<Download size={14} />}
              active={tab === 'updates'}
              onClick={() => setTab('updates')}
            />
            <SettingsTabButton
              label="Avancé"
              icon={<Sliders size={14} />}
              active={tab === 'avance'}
              onClick={() => setTab('avance')}
            />
          </div>

          {/* Body */}
          <div className="dialog-body" style={{ flex: 1, overflowY: 'auto' }}>
            {tab === 'apparence' && (
              <>
                <div className="field">
                  <label className="field-label">Thème</label>
                  <select
                    className="select"
                    value={settings.theme}
                    onChange={(e) =>
                      void apply({ theme: e.target.value as AppSettings['theme'] })
                    }
                  >
                    <option value="dark">Sombre</option>
                    <option value="light">Clair (à venir)</option>
                    <option value="system">Système</option>
                  </select>
                  <div className="hint">Le mode clair n'est pas encore stylé — reste sur sombre.</div>
                </div>
                <div className="field">
                  <label className="field-label">Police</label>
                  <select
                    className="select"
                    value={settings.fontFamily}
                    onChange={(e) => void apply({ fontFamily: e.target.value })}
                  >
                    {FONT_PRESETS.map((f) => (
                      <option key={f} value={f}>
                        {f.split(',')[0].replace(/"/g, '')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">Taille de police ({settings.fontSize}px)</label>
                  <input
                    type="range"
                    min={10}
                    max={20}
                    step={1}
                    value={settings.fontSize}
                    onChange={(e) => void apply({ fontSize: Number(e.target.value) })}
                  />
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.cursorBlink}
                    onChange={(e) => void apply({ cursorBlink: e.target.checked })}
                  />
                  Curseur clignotant
                </label>
              </>
            )}

            {tab === 'terminal' && (
              <>
                <div className="field">
                  <label className="field-label">Shell par défaut</label>
                  <select
                    className="select"
                    value={settings.defaultShell}
                    onChange={(e) => void apply({ defaultShell: e.target.value })}
                  >
                    {SHELL_PRESETS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <div className="hint">
                    Utilisé pour les nouveaux panes shell. Les sessions agent gardent leur commande.
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">
                    Scrollback ({settings.scrollback.toLocaleString('fr-FR')} lignes)
                  </label>
                  <input
                    type="range"
                    min={1000}
                    max={50000}
                    step={1000}
                    value={settings.scrollback}
                    onChange={(e) => void apply({ scrollback: Number(e.target.value) })}
                  />
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.copyOnSelection}
                    onChange={(e) => void apply({ copyOnSelection: e.target.checked })}
                  />
                  Copier la sélection automatiquement
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.pasteOnRightClick}
                    onChange={(e) => void apply({ pasteOnRightClick: e.target.checked })}
                  />
                  Coller au clic-droit
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.webglRenderer}
                    onChange={(e) => void apply({ webglRenderer: e.target.checked })}
                  />
                  Renderer WebGL (perf++)
                  <span className="hint" style={{ marginLeft: 8 }}>
                    redémarre l'app pour appliquer
                  </span>
                </label>
              </>
            )}

            {tab === 'notifs' && (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.notificationsEnabled}
                    onChange={(e) => void apply({ notificationsEnabled: e.target.checked })}
                  />
                  Notifications système Windows
                </label>
                <div className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
                  Reçois une notif push (avec icône vMux) quand un agent demande une action ou
                  qu'un événement (build, server, tests) est détecté en arrière-plan.
                </div>

                <div className="dialog-section-title">
                  <Globe size={12} /> Preview localhost
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.previewToastEnabled}
                    onChange={(e) => void apply({ previewToastEnabled: e.target.checked })}
                  />
                  Afficher un toast quand une URL localhost est détectée
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.previewAutoOpen}
                    onChange={(e) => void apply({ previewAutoOpen: e.target.checked })}
                  />
                  Ouvrir le preview embarqué automatiquement
                </label>
                <div className="field" style={{ marginTop: 8 }}>
                  <label className="field-label">
                    Taille du split preview ({settings.previewDefaultSplit}%)
                  </label>
                  <input
                    type="range"
                    min={30}
                    max={70}
                    step={5}
                    value={settings.previewDefaultSplit}
                    onChange={(e) =>
                      void apply({ previewDefaultSplit: Number(e.target.value) })
                    }
                  />
                  <div className="hint">
                    Pourcentage que prend le terminal vs le preview quand on ouvre un preview.
                  </div>
                </div>
              </>
            )}

            {tab === 'agents' && (
              <>
                {agents.map((a) => {
                  const av = agentAvailability[a.id];
                  const override = settings.agentOverrides[a.id];
                  const cmd = override?.command ?? a.command;
                  const argsStr = (override?.args ?? a.args).join(' ');
                  return (
                    <div key={a.id} className="field">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 4
                        }}
                      >
                        <span
                          className="agent-card-bullet"
                          style={{ background: a.color }}
                          aria-hidden
                        />
                        <span className="field-label" style={{ margin: 0 }}>
                          {a.label}
                        </span>
                        {av && av.found ? (
                          <span style={{ fontSize: 10, color: 'var(--success)' }}>
                            ✓ {av.resolvedPath}
                          </span>
                        ) : a.id !== 'shell' ? (
                          <a
                            style={{ fontSize: 10, color: 'var(--warn)', cursor: 'pointer' }}
                            onClick={() =>
                              a.installUrl && window.cmux.dialog.openExternal(a.installUrl)
                            }
                          >
                            non installé{' '}
                            <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
                          </a>
                        ) : null}
                      </div>
                      <div className="input-group">
                        <input
                          className="input"
                          style={{ flex: '0 0 30%' }}
                          placeholder="commande"
                          value={cmd}
                          onChange={(e) =>
                            void applyAgentOverride(a.id, { command: e.target.value })
                          }
                        />
                        <input
                          className="input"
                          placeholder="arguments séparés par espace"
                          value={argsStr}
                          onChange={(e) =>
                            void applyAgentOverride(a.id, {
                              args: e.target.value.split(/\s+/).filter(Boolean)
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {tab === 'updates' && <UpdatesTab />}

            {tab === 'avance' && (
              <>
                <div className="field">
                  <label className="field-label">Diagnostic</label>
                  <button
                    className="btn"
                    onClick={async () => {
                      await window.cmux.diagnostic.export();
                    }}
                  >
                    Exporter le diagnostic (.json)
                  </button>
                  <div className="hint">
                    Génère un rapport (versions, agents, sessions, derniers logs) à fournir
                    en cas de bug. Les overrides agents sont anonymisés.
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">Source</label>
                  <button
                    className="btn"
                    onClick={() =>
                      window.cmux.dialog.openExternal('https://github.com/vk1356/vmux')
                    }
                  >
                    Ouvrir le repo GitHub <ExternalLink size={11} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <span className="hint" style={{ flex: 1 }}>
            {saving ? 'Sauvegarde…' : 'Modifications appliquées en live.'}
          </span>
          <button className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

interface TabBtnProps {
  label: string;
  icon: JSX.Element;
  active: boolean;
  onClick: () => void;
}

function SettingsTabButton({ label, icon, active, onClick }: TabBtnProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: active ? 'var(--bg-elev-2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        textAlign: 'left',
        fontSize: 13,
        fontWeight: active ? 500 : 400
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/** Onglet Mises à jour : version actuelle, check manuel, statut live. */
function UpdatesTab(): JSX.Element {
  const [version, setVersion] = useState<string>('');
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    void window.cmux.app.version().then(setVersion);
    return window.cmux.updater.onStatus((s) => {
      setStatus(s);
      if (s.kind === 'checking') setCheckedAt(Date.now());
    });
  }, []);

  const onCheck = (): void => {
    setStatus({ kind: 'checking' });
    setCheckedAt(Date.now());
    void window.cmux.updater.check();
    // Watchdog UI : si après 25s on est toujours sur 'checking', on affiche
    // une erreur. Le main a aussi son watchdog 20s, ceci est un filet de sécurité.
    setTimeout(() => {
      setStatus((cur) =>
        cur.kind === 'checking'
          ? {
              kind: 'error',
              message: 'Pas de réponse — vérifie que tu utilises la version installée.'
            }
          : cur
      );
    }, 25000);
  };
  const onDownload = (): void => {
    void window.cmux.updater.download();
  };
  const onInstall = (): void => {
    void window.cmux.updater.install();
  };

  return (
    <>
      <div className="field">
        <label className="field-label">Version installée</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{ fontSize: 13, color: 'var(--text)' }}>vMux {version || '…'}</code>
        </div>
      </div>

      <div className="field">
        <label className="field-label">Statut</label>
        <UpdateStatusLine status={status} checkedAt={checkedAt} />
      </div>

      <div className="field" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn"
          onClick={onCheck}
          disabled={status.kind === 'checking' || status.kind === 'downloading'}
        >
          <RefreshCw
            size={12}
            className={status.kind === 'checking' ? 'spin' : undefined}
          />
          Vérifier maintenant
        </button>
        {status.kind === 'available' && (
          <button className="btn primary" onClick={onDownload}>
            <Download size={12} /> Télécharger v{status.version}
          </button>
        )}
        {status.kind === 'downloaded' && (
          <button className="btn primary" onClick={onInstall}>
            <CheckCircle2 size={12} /> Installer et redémarrer
          </button>
        )}
      </div>

      <div className="hint">
        vMux vérifie automatiquement les nouvelles versions au démarrage et toutes les 4 heures.
        Les mises à jour sont publiées sur GitHub Releases.
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <button
          className="btn"
          onClick={() =>
            window.cmux.dialog.openExternal('https://github.com/vk1356/vmux/releases')
          }
        >
          Voir toutes les versions <ExternalLink size={11} />
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
  switch (status.kind) {
    case 'idle':
      return <span style={{ color: 'var(--text-muted)' }}>Aucune vérification récente.</span>;
    case 'checking':
      return (
        <span style={{ color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={11} className="spin" /> Vérification en cours…
        </span>
      );
    case 'not-available':
      return (
        <span
          style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <CheckCircle2 size={11} /> À jour (v{status.currentVersion})
          {checkedAt && ` — il y a ${secondsAgo(checkedAt)}`}
        </span>
      );
    case 'available':
      return (
        <span style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Download size={11} /> Nouvelle version v{status.version} disponible
        </span>
      );
    case 'downloading': {
      const pct = Math.round(status.percent);
      const mbs = (status.bytesPerSecond / 1024 / 1024).toFixed(1);
      return (
        <span style={{ color: 'var(--info)' }}>
          Téléchargement {pct}% — {mbs} MB/s
        </span>
      );
    }
    case 'downloaded':
      return (
        <span
          style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <CheckCircle2 size={11} /> Mise à jour v{status.version} prête à être installée
        </span>
      );
    case 'error':
      return (
        <span style={{ color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={11} /> Erreur : {status.message}
        </span>
      );
  }
}

function secondsAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}
