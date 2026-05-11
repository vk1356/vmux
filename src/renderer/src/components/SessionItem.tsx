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
  Palette,
  Brain,
  Zap,
  AlertCircle,
  Moon
} from 'lucide-react';
import type { AgentPreset, AgentRunState, DetectedEvent, Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { pathBasename } from '@shared/utils';
import { ATTENTION_RANK, type AttentionLevel } from '../store/sessions';
import type { TFunction } from '../i18n';
import claudeLogo from '../assets/agents/claude-code.png';
import codexLogo from '../assets/agents/codex.png';
import cursorLogo from '../assets/agents/cursor-agent.png';
import aiderLogo from '../assets/agents/aider.png';
import geminiLogo from '../assets/agents/gemini.png';
import shellLogo from '../assets/agents/shell.png';

const AGENT_LOGOS: Record<string, string> = {
  'claude-code': claudeLogo,
  codex: codexLogo,
  'cursor-agent': cursorLogo,
  aider: aiderLogo,
  gemini: geminiLogo,
  shell: shellLogo
};

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

/** Ordre de priorité d'agrégation entre panes : needs-input > thinking > generating > idle.
 *  Quand une session a plusieurs panes, on remonte l'état le plus "exigeant"
 *  pour que l'user voie tout de suite ce qui demande son attention. */
const AGENT_STATE_RANK: Record<AgentRunState, number> = {
  idle: 0,
  generating: 1,
  thinking: 2,
  'needs-input': 3
};

const AGENT_STATE_LABEL_KEY = {
  idle: 'agentStateIdle',
  thinking: 'agentStateThinking',
  generating: 'agentStateGenerating',
  'needs-input': 'agentStateNeedsInput'
} as const;

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
  paneAgentState: Record<string, AgentRunState | undefined>;
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
    paneAgentState,
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

  // Agrégation de l'état "live" des agents : on prend le plus "actif" parmi
  // les panes terminaux. Ordre de priorité : needs-input > thinking > generating > idle.
  // Affiché uniquement si la session a au moins un pane qui tourne — sinon
  // c'est juste du bruit (pane fermé / exited).
  let agentRun: AgentRunState = 'idle';
  if (running > 0) {
    for (const p of terminalPanes) {
      const s = paneAgentState[p.id] ?? 'idle';
      if (AGENT_STATE_RANK[s] > AGENT_STATE_RANK[agentRun]) agentRun = s;
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
        {(() => {
          const logo = main?.agentId ? AGENT_LOGOS[main.agentId] : undefined;
          return logo ? (
            <img
              className="session-avatar-logo"
              src={logo}
              alt=""
              draggable={false}
            />
          ) : null;
        })()}
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
          <AgentStatePill state={agentRun} t={t} />
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

/**
 * Custom equality pour SessionItem — la version shallow par défaut de memo()
 * re-render à chaque mutation de paneActivity / paneAgentState / lastEvent
 * même si rien de visible pour CET item n'a changé. On compare uniquement les
 * champs qui peuvent altérer le rendu de cet item :
 *   - identité + nom + état de la session
 *   - état UI (active, renaming, drag-over, color picker)
 *   - attention/agent state des panes de cette session uniquement
 *
 * Les callbacks sont supposés stables (useCallback côté Sidebar) — comparaison
 * référentielle suffisante.
 */
function arePropsEqual(prev: Props, next: Props): boolean {
  const ps = prev.meta.session;
  const ns = next.meta.session;
  if (ps.id !== ns.id) return false;
  if (ps.name !== ns.name) return false;
  if (ps.pinned !== ns.pinned) return false;
  if (ps.branch !== ns.branch) return false;
  if (ps.cwd !== ns.cwd) return false;
  if (ps.colorOverride !== ns.colorOverride) return false;
  if (ps.activePaneId !== ns.activePaneId) return false;
  // Le tree (panes) peut bouger sans changer la session ID — comparer par ref
  // est suffisant ici car le store immute le tree quand il change.
  if (ps.tree !== ns.tree) return false;
  if (ps.panes !== ns.panes) return false;

  if (prev.meta.isRunning !== next.meta.isRunning) return false;
  if (prev.meta.isError !== next.meta.isError) return false;
  if (prev.meta.isExited !== next.meta.isExited) return false;

  if (prev.isActive !== next.isActive) return false;
  if (prev.isRenaming !== next.isRenaming) return false;
  // renameValue n'est lu QUE quand isRenaming=true : on évite des re-renders
  // de tous les autres items qui voient renameValue muter (state remonté dans
  // Sidebar pour des raisons de focus).
  if (next.isRenaming && prev.renameValue !== next.renameValue) return false;
  if (prev.dragOverId !== next.dragOverId && (prev.dragOverId === ps.id || next.dragOverId === ns.id)) return false;
  if (prev.colorPickerOpen !== next.colorPickerOpen) return false;

  // paneActivity / paneAgentState : on compare uniquement les ids des panes
  // de CETTE session — un changement dans une autre session ne doit pas
  // forcer ce SessionItem à re-render.
  const paneIds = allPaneIds(ns.tree);
  for (const id of paneIds) {
    if (prev.paneActivity[id] !== next.paneActivity[id]) return false;
    if (prev.paneAgentState[id] !== next.paneAgentState[id]) return false;
  }

  if (prev.lastEvent !== next.lastEvent) return false;
  if (prev.agents !== next.agents) return false;
  if (prev.t !== next.t) return false;

  // Callbacks supposés stables — comparaison référentielle.
  if (prev.onActivate !== next.onActivate) return false;
  if (prev.onStartRename !== next.onStartRename) return false;
  if (prev.onChangeRename !== next.onChangeRename) return false;
  if (prev.onCommitRename !== next.onCommitRename) return false;
  if (prev.onCancelRename !== next.onCancelRename) return false;
  if (prev.onTogglePin !== next.onTogglePin) return false;
  if (prev.onRestartAll !== next.onRestartAll) return false;
  if (prev.onRemove !== next.onRemove) return false;
  if (prev.onOpenColorPicker !== next.onOpenColorPicker) return false;
  if (prev.onPickColor !== next.onPickColor) return false;
  if (prev.onDragStart !== next.onDragStart) return false;
  if (prev.onDragOver !== next.onDragOver) return false;
  if (prev.onDragLeave !== next.onDragLeave) return false;
  if (prev.onDrop !== next.onDrop) return false;
  if (prev.onFocusPane !== next.onFocusPane) return false;

  return true;
}

export const SessionItem = memo(SessionItemImpl, arePropsEqual);

interface AgentStatePillProps {
  state: AgentRunState;
  t: TFunction;
}

/** Pill visuel pour l'état live de l'agent — icône + label, couleur dynamique.
 *  Pas de pill quand l'agent est idle pour ne pas alourdir la sidebar. */
function AgentStatePill({ state, t }: AgentStatePillProps): JSX.Element | null {
  if (state === 'idle') {
    return (
      <span className="agent-state-pill state-idle" title={t(AGENT_STATE_LABEL_KEY.idle)}>
        <Moon size={9} />
        {t(AGENT_STATE_LABEL_KEY.idle)}
      </span>
    );
  }
  const Icon =
    state === 'thinking' ? Brain : state === 'generating' ? Zap : AlertCircle;
  return (
    <span
      className={`agent-state-pill state-${state}`}
      title={t(AGENT_STATE_LABEL_KEY[state])}
    >
      <Icon size={9} />
      {t(AGENT_STATE_LABEL_KEY[state])}
    </span>
  );
}
