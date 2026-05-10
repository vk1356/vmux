import { memo, type JSX, type MouseEvent } from 'react';
import {
  X,
  GitBranch,
  CheckCircle2,
  XCircle,
  Rocket,
  Globe,
  RotateCw,
  Folder,
  Pin,
  PinOff,
  Palette
} from 'lucide-react';
import type { AgentPreset, DetectedEvent, Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { pathBasename } from '@shared/utils';
import { ATTENTION_RANK, type AttentionLevel } from '../store/sessions';
import type { TFunction } from '../i18n';

const SESSION_COLORS = [
  '#f97316',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#eab308',
  '#06b6d4',
  '#ef4444'
] as const;

export interface SessionItemMeta {
  session: Session;
  isRunning: boolean;
  isError: boolean;
  isExited: boolean;
}

interface Props {
  meta: SessionItemMeta;
  agents: AgentPreset[];
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  dragOverId: string | null;
  colorPickerOpen: boolean;
  paneActivity: Record<string, AttentionLevel | undefined>;
  lastEvent: DetectedEvent | undefined;
  t: TFunction;
  onActivate: (sessionId: string) => void;
  onStartRename: (e: MouseEvent, s: Session) => void;
  onChangeRename: (value: string) => void;
  onCommitRename: (s: Session) => Promise<void>;
  onCancelRename: () => void;
  onTogglePin: (e: MouseEvent, s: Session) => Promise<void>;
  onRestartAll: (e: MouseEvent, s: Session) => Promise<void>;
  onRemove: (e: MouseEvent, s: Session) => Promise<void>;
  onOpenColorPicker: (sessionId: string | null) => void;
  onPickColor: (sessionId: string, color: string | null) => Promise<void>;
  onDragStart: (s: Session) => void;
  onDragOver: (s: Session) => void;
  onDragLeave: (s: Session) => void;
  onDrop: (sourceId: string, targetId: string) => void;
  onFocusPane: (sessionId: string, paneId: string) => void;
}

/**
 * Item individuel de la sidebar — extrait de Sidebar.tsx pour permettre la
 * mémoisation par item. Avant : `renderItem` était une fonction inline du
 * composant Sidebar, recréée à chaque render → tous les items re-render quand
 * un seul change (rename, color, attention bump…).
 *
 * Maintenant chaque item est un composant memo() distinct ; React saute le
 * re-render des items dont les props ne changent pas.
 */
function SessionItemImpl(props: Props): JSX.Element {
  const {
    meta,
    agents,
    isActive,
    isRenaming,
    renameValue,
    dragOverId,
    colorPickerOpen,
    paneActivity,
    lastEvent,
    t,
    onActivate,
    onStartRename,
    onChangeRename,
    onCommitRename,
    onCancelRename,
    onTogglePin,
    onRestartAll,
    onRemove,
    onOpenColorPicker,
    onPickColor,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onFocusPane
  } = props;
  const s = meta.session;
  const paneIds = allPaneIds(s.tree);
  const terminalPanes = paneIds
    .map((id) => s.panes[id])
    .filter((p): p is TerminalPane => p?.kind === 'terminal');
  const main = terminalPanes[0];
  const agent = main ? agents.find((a) => a.id === main.agentId) : null;
  const running = terminalPanes.filter((p) => p.status === 'running' || p.status === 'starting')
    .length;
  const hasIdleTerm = terminalPanes.some(
    (p) => p.status === 'idle' || p.status === 'exited' || p.status === 'error'
  );
  const hasUrls = terminalPanes.some((p) => (p.recentUrls?.length ?? 0) > 0);

  const dotStatus =
    running > 0 ? 'running' : meta.isError ? 'error' : meta.isExited ? 'exited' : 'idle';

  const folderName = pathBasename(s.cwd);
  const accent = s.colorOverride ?? agent?.color ?? 'var(--text-muted)';

  let attention: AttentionLevel = 'idle';
  let triggerPaneId: string | undefined;
  for (const id of paneIds) {
    const a = paneActivity[id] ?? 'idle';
    if (ATTENTION_RANK[a] > ATTENTION_RANK[attention]) {
      attention = a;
      triggerPaneId = id;
    }
  }

  const hasNeeds = attention === 'needs-input';
  const hasAlert = attention === 'alert';
  const accentIsHex = typeof accent === 'string' && accent.startsWith('#');

  return (
    <div
      className={[
        'session-item',
        isActive ? 'active' : '',
        dragOverId === s.id ? 'drag-over' : '',
        hasNeeds ? 'has-needs-input' : '',
        hasAlert ? 'has-alert' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => onActivate(s.id)}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-vmux-session', s.id);
        onDragStart(s);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/x-vmux-session')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onDragOver(s);
        }
      }}
      onDragLeave={() => onDragLeave(s)}
      onDrop={(e) => {
        const sourceId = e.dataTransfer.getData('text/x-vmux-session');
        if (sourceId && sourceId !== s.id) onDrop(sourceId, s.id);
      }}
      style={
        isActive && accentIsHex
          ? ({ ['--session-accent']: accent } as React.CSSProperties & Record<string, string>)
          : undefined
      }
    >
      {isActive && <span className="session-active-bar" aria-hidden />}
      <div
        className={`session-avatar status-${dotStatus}`}
        style={
          accentIsHex
            ? ({ ['--avatar-color']: accent } as React.CSSProperties & Record<string, string>)
            : undefined
        }
        title={t('avatarHint', { agent: agent?.label ?? main?.agentId ?? 'shell' })}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenColorPicker(colorPickerOpen ? null : s.id);
        }}
      >
        {s.pinned && <span className="session-pin-mark" title={t('pinnedLabel')} />}
        {attention !== 'idle' && (
          <button
            type="button"
            className={`attention-badge attention-${attention}`}
            title={
              attention === 'needs-input'
                ? t('attentionNeedsInputLabel')
                : attention === 'alert'
                  ? t('attentionAlertLabel')
                  : t('attentionActivityLabel')
            }
            onClick={(e) => {
              e.stopPropagation();
              onActivate(s.id);
              if (triggerPaneId) onFocusPane(s.id, triggerPaneId);
            }}
          />
        )}
      </div>
      <div className="session-meta">
        {isRenaming ? (
          <input
            autoFocus
            className="input session-rename-input"
            value={renameValue}
            onChange={(e) => onChangeRename(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => void onCommitRename(s)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void onCommitRename(s);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancelRename();
              }
            }}
          />
        ) : (
          <div
            className="session-name"
            title={t('actionRenameHint')}
            onDoubleClick={(e) => onStartRename(e, s)}
          >
            {s.name}
          </div>
        )}
        <div className="session-sub">
          {s.branch ? (
            <span className="session-sub-tag">
              <GitBranch size={9} /> {s.branch}
            </span>
          ) : (
            <span className="session-sub-tag">
              <Folder size={9} /> {folderName}
            </span>
          )}
          {paneIds.length > 1 && <span className="session-sub-tag">{paneIds.length}p</span>}
          <span className="session-icons">
            {hasUrls && (
              <span title={t('urlDetectedLabel')}>
                <Globe size={10} style={{ color: 'var(--info)' }} />
              </span>
            )}
            {lastEvent?.kind === 'server-ready' && (
              <span title={lastEvent.message}>
                <Rocket size={10} style={{ color: 'var(--success)' }} />
              </span>
            )}
            {lastEvent?.kind === 'build-success' && (
              <span title={lastEvent.message}>
                <CheckCircle2 size={10} style={{ color: 'var(--success)' }} />
              </span>
            )}
            {lastEvent?.kind === 'build-error' && (
              <span title={lastEvent.message}>
                <XCircle size={10} style={{ color: 'var(--error)' }} />
              </span>
            )}
          </span>
        </div>
      </div>
      <div className="session-actions">
        <button
          className={`btn-icon session-action ${s.pinned ? 'pinned' : ''}`}
          onClick={(e) => onTogglePin(e, s)}
          title={s.pinned ? t('actionUnpin') : t('actionPin')}
        >
          {s.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
        {hasIdleTerm && (
          <button
            className="btn-icon session-action"
            onClick={(e) => onRestartAll(e, s)}
            title={t('actionRestartIdle')}
          >
            <RotateCw size={12} />
          </button>
        )}
        <button
          className="btn-icon session-action danger"
          onClick={(e) => onRemove(e, s)}
          title={t('actionCloseSession')}
        >
          <X size={12} />
        </button>
      </div>
      {colorPickerOpen && (
        <div className="color-picker" onClick={(e) => e.stopPropagation()}>
          {SESSION_COLORS.map((c) => (
            <button
              key={c}
              className="color-swatch"
              style={{ background: c }}
              onClick={() => void onPickColor(s.id, c)}
              title={c}
              aria-label={`Couleur ${c}`}
            />
          ))}
          <button
            className="color-swatch reset"
            onClick={() => void onPickColor(s.id, null)}
            title={t('actionResetColor')}
            aria-label={t('actionResetColor')}
          >
            <Palette size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

export const SessionItem = memo(SessionItemImpl);
