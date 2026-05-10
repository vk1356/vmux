import { useEffect, useRef, useState, type JSX } from 'react';
import { X, Plus, Trash2, Edit3, Power, Server } from 'lucide-react';
import type { McpServer, McpServerType } from '@shared/types';
import { useT } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface Props {
  open: boolean;
  onClose: () => void;
}

type EditDraft = {
  /** Nom original — vide si nouveau. Sert à détecter un rename pour le dropping. */
  originalName: string;
  server: McpServer;
};

function emptyDraft(): EditDraft {
  return {
    originalName: '',
    server: { name: '', type: 'stdio', command: '', args: [], env: {} }
  };
}

export function McpManagerDialog({ open, onClose }: Props): JSX.Element | null {
  const t = useT();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [configPath, setConfigPath] = useState<string>('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.cmux.mcp.list();
      if (res.ok) setServers(res.data);
      else setError(res.error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setEdit(null);
    void refresh();
    void window.cmux.mcp.configPath().then(setConfigPath);
  }, [open]);

  if (!open) return null;

  const handleSave = async (): Promise<void> => {
    if (!edit) return;
    setError(null);
    // Si rename : drop l'ancien d'abord (le backend déduplique mais on est explicite).
    if (edit.originalName && edit.originalName !== edit.server.name) {
      const r1 = await window.cmux.mcp.remove(edit.originalName);
      if (!r1.ok) {
        setError(r1.error);
        return;
      }
    }
    const r2 = await window.cmux.mcp.add(edit.server);
    if (!r2.ok) {
      setError(r2.error);
      return;
    }
    setServers(r2.data);
    setEdit(null);
  };

  const handleRemove = async (name: string): Promise<void> => {
    setError(null);
    const r = await window.cmux.mcp.remove(name);
    if (r.ok) setServers(r.data);
    else setError(r.error);
  };

  const handleToggle = async (name: string): Promise<void> => {
    setError(null);
    const r = await window.cmux.mcp.toggle(name);
    if (r.ok) setServers(r.data);
    else setError(r.error);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('mcpTitle')}
        style={{ width: 'min(720px, 92vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Server size={14} /> {t('mcpTitle')}
          </div>
          <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
            <X size={14} />
          </button>
        </div>

        <div className="dialog-body" style={{ overflowY: 'auto', maxHeight: '70vh' }}>
          {edit ? (
            <McpEditForm
              draft={edit}
              onChange={setEdit}
              onCancel={() => {
                setEdit(null);
                setError(null);
              }}
              onSave={() => void handleSave()}
              error={error}
            />
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 12 }}>
                {t('mcpHint')}
              </div>
              {error && (
                <div
                  style={{
                    padding: '8px 10px',
                    border: '1px solid var(--danger, #c0392b)',
                    borderRadius: 6,
                    color: 'var(--danger, #c0392b)',
                    fontSize: 12,
                    marginBottom: 12
                  }}
                >
                  {error}
                </div>
              )}
              {loading ? (
                <div className="hint">…</div>
              ) : servers.length === 0 ? (
                <div className="palette-empty" style={{ padding: 24, textAlign: 'center' }}>
                  <div>{t('mcpEmpty')}</div>
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    {t('mcpEmptyHint')}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {servers.map((s) => (
                    <McpServerRow
                      key={s.name}
                      server={s}
                      onEdit={() =>
                        setEdit({
                          originalName: s.name,
                          server: { ...s, args: s.args ?? [], env: s.env ?? {} }
                        })
                      }
                      onRemove={() => void handleRemove(s.name)}
                      onToggle={() => void handleToggle(s.name)}
                    />
                  ))}
                </div>
              )}
              {configPath && (
                <div className="hint" style={{ marginTop: 16, fontSize: 11 }}>
                  {t('mcpConfigPathLabel')} <code>{configPath}</code>
                </div>
              )}
            </>
          )}
        </div>

        {!edit && (
          <div className="dialog-footer">
            <span className="hint" style={{ flex: 1 }}>
              {t('mcpFooterHint')}
            </span>
            <button className="btn primary" onClick={() => setEdit(emptyDraft())}>
              <Plus size={12} /> {t('mcpAdd')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  server: McpServer;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: () => void;
}

function McpServerRow({ server, onEdit, onRemove, onToggle }: RowProps): JSX.Element {
  const t = useT();
  const summary =
    server.type === 'stdio'
      ? `${server.command ?? ''}${server.args && server.args.length > 0 ? ' ' + server.args.join(' ') : ''}`
      : server.url ?? '';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: server.disabled ? 'transparent' : 'var(--bg-elev-2)',
        opacity: server.disabled ? 0.55 : 1
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>{server.name}</strong>
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.5
            }}
          >
            {server.type}
          </span>
          {server.disabled && (
            <span
              style={{
                fontSize: 10,
                padding: '2px 6px',
                borderRadius: 4,
                background: 'var(--bg-elev-3, var(--bg-elev-2))',
                color: 'var(--text-muted)'
              }}
            >
              {t('mcpDisabledLabel')}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'monospace'
          }}
        >
          {summary || '—'}
        </div>
      </div>
      <button
        className="btn-icon"
        onClick={onToggle}
        title={server.disabled ? t('mcpToggleEnable') : t('mcpToggleDisable')}
        aria-label={server.disabled ? t('mcpToggleEnable') : t('mcpToggleDisable')}
      >
        <Power size={12} />
      </button>
      <button className="btn-icon" onClick={onEdit} title={t('mcpEdit')} aria-label={t('mcpEdit')}>
        <Edit3 size={12} />
      </button>
      <button
        className="btn-icon"
        onClick={onRemove}
        title={t('mcpRemove')}
        aria-label={t('mcpRemove')}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

interface FormProps {
  draft: EditDraft;
  error: string | null;
  onChange: (d: EditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

function McpEditForm({ draft, error, onChange, onSave, onCancel }: FormProps): JSX.Element {
  const t = useT();
  const s = draft.server;

  const setField = <K extends keyof McpServer>(key: K, value: McpServer[K]): void => {
    onChange({ ...draft, server: { ...s, [key]: value } });
  };

  // Args : édité comme texte ligne unique (espaces = séparateurs). Robuste pour
  // 95% des cas. L'user qui veut un argument avec espaces utilisera la CLI claude.
  const argsText = (s.args ?? []).join(' ');
  // Env : édité comme `KEY=value` une par ligne. Filtre les lignes vides.
  const envText = Object.entries(s.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const setArgsFromText = (txt: string): void => {
    const parts = txt
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    setField('args', parts);
  };
  const setEnvFromText = (txt: string): void => {
    const env: Record<string, string> = {};
    for (const line of txt.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    setField('env', env);
  };

  const canSave =
    s.name.trim().length > 0 &&
    (s.type === 'stdio' ? (s.command ?? '').trim().length > 0 : (s.url ?? '').trim().length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>
        {draft.originalName ? t('mcpEditTitle') : t('mcpAddTitle')}
      </h3>

      {error && (
        <div
          style={{
            padding: '8px 10px',
            border: '1px solid var(--danger, #c0392b)',
            borderRadius: 6,
            color: 'var(--danger, #c0392b)',
            fontSize: 12
          }}
        >
          {error}
        </div>
      )}

      <div className="field">
        <label className="field-label">{t('mcpFieldName')}</label>
        <input
          type="text"
          value={s.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="my-server"
          autoFocus
        />
      </div>

      <div className="field">
        <label className="field-label">{t('mcpFieldType')}</label>
        <select
          value={s.type}
          onChange={(e) => setField('type', e.target.value as McpServerType)}
        >
          <option value="stdio">{t('mcpTypeStdio')}</option>
          <option value="http">{t('mcpTypeHttp')}</option>
          <option value="sse">{t('mcpTypeSse')}</option>
        </select>
      </div>

      {s.type === 'stdio' ? (
        <>
          <div className="field">
            <label className="field-label">{t('mcpFieldCommand')}</label>
            <input
              type="text"
              value={s.command ?? ''}
              onChange={(e) => setField('command', e.target.value)}
              placeholder="npx"
            />
          </div>
          <div className="field">
            <label className="field-label">{t('mcpFieldArgs')}</label>
            <input
              type="text"
              value={argsText}
              onChange={(e) => setArgsFromText(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-..."
            />
            <div className="hint">{t('mcpFieldArgsHint')}</div>
          </div>
          <div className="field">
            <label className="field-label">{t('mcpFieldEnv')}</label>
            <textarea
              value={envText}
              onChange={(e) => setEnvFromText(e.target.value)}
              placeholder="KEY=value"
              rows={3}
              style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
            />
            <div className="hint">{t('mcpFieldEnvHint')}</div>
          </div>
        </>
      ) : (
        <div className="field">
          <label className="field-label">{t('mcpFieldUrl')}</label>
          <input
            type="text"
            value={s.url ?? ''}
            onChange={(e) => setField('url', e.target.value)}
            placeholder="https://example.com/mcp"
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn" onClick={onCancel}>
          {t('mcpCancel')}
        </button>
        <button className="btn primary" onClick={onSave} disabled={!canSave}>
          {t('mcpSave')}
        </button>
      </div>
    </div>
  );
}
