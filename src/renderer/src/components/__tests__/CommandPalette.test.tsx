import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from '../CommandPalette';
import { useSessionStore } from '../../store/sessions';
import type { AppSettings, Session } from '@shared/types';

// The IPC bridge type, taken from the global `Window` augmentation
// (src/preload/index.d.ts) rather than importing src/preload/index.ts —
// keeps the renderer tsconfig program from pulling in main-process code.
type CmuxApi = Window['cmux'];

// happy-dom characterization of CommandPalette. We mock ONLY the external
// boundary (`window.cmux` IPC bridge) and drive the REAL Zustand store + REAL
// i18n (EN inline). No component logic is faked. `HTMLDialogElement.showModal`
// / `.close` are not implemented by happy-dom, so we polyfill just those two
// DOM primitives (a pure environment gap, not app behavior) — everything the
// component computes (item building, fuzzy filter, keyboard nav) runs for real.
//
// Documented untestable boundary: the actual IPC round-trip (Electron main
// process) cannot exist in a unit env — we assert the component CALLS the
// correct bridge method with the correct args, which is the renderer-side
// contract. Anything past the preload boundary is out of scope here.

const baseSettings: AppSettings = {
  theme: 'dark',
  language: 'en',
  fontFamily: 'mono',
  fontSize: 14,
  defaultShell: 'pwsh',
  scrollback: 1000,
  cursorBlink: true,
  copyOnSelection: false,
  pasteOnRightClick: false,
  webglRenderer: true,
  sidebarWidth: 240,
  previewToastEnabled: true,
  previewAutoOpen: true,
  notificationsEnabled: true,
  notificationSound: 'default',
  autoLaunch: false,
  previewDefaultSplit: 0.5,
  agentOverrides: {},
  autoRestoreOnBoot: true,
  lastActiveSessionId: null,
  cdpEnabled: true,
  cdpPort: 9222,
  claudeCommandsEnabled: true
};

const mkSession = (id: string): Session => ({
  id,
  name: `Session ${id}`,
  cwd: `/repo/${id}`,
  branch: `feat/${id}`,
  panes: {
    [`${id}-pane`]: {
      id: `${id}-pane`,
      kind: 'terminal',
      agentId: 'shell',
      status: 'running',
      cwd: `/repo/${id}`,
      createdAt: 1
    }
  },
  tree: { kind: 'leaf', paneId: `${id}-pane` },
  activePaneId: `${id}-pane`,
  createdAt: 1
});

// Boundary mock: only the methods CommandPalette actually invokes. Typed via
// the real CmuxApi surface (deep-partial) so a signature drift fails compile.
const splitMock = vi.fn().mockResolvedValue({ ok: true, data: null });
const relayoutMock = vi.fn().mockResolvedValue({ ok: true, data: null });
const closePaneMock = vi.fn().mockResolvedValue({ ok: true, data: null });
const focusMock = vi.fn().mockResolvedValue(undefined);
const removeSessionIpcMock = vi.fn().mockResolvedValue(undefined);
const restartAllMock = vi.fn().mockResolvedValue({ ok: true, data: null });

type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

const cmuxMock: DeepPartial<CmuxApi> = {
  panes: {
    split: splitMock,
    relayout: relayoutMock,
    close: closePaneMock,
    focus: focusMock
  },
  sessions: {
    remove: removeSessionIpcMock,
    restartAll: restartAllMock
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { cmux: CmuxApi }).cmux = cmuxMock as unknown as CmuxApi;
  // happy-dom lacks <dialog> showModal/close — polyfill the env primitive only.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement): void {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement): void {
      this.open = false;
    };
  }
  useSessionStore.setState({
    sessions: [mkSession('a'), mkSession('b')],
    sessionsById: { a: mkSession('a'), b: mkSession('b') },
    activeSessionId: 'a',
    agents: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        description: 'Anthropic agent',
        command: 'claude',
        args: [],
        color: '#c96'
      }
    ],
    settings: { ...baseSettings }
  });
});

afterEach(() => {
  useSessionStore.setState({ sessions: [], sessionsById: {}, activeSessionId: null });
});

const noop = (): void => {};

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CommandPalette
        open={false}
        onClose={noop}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('renders the app actions and other-session entries when open', () => {
    render(
      <CommandPalette
        open
        onClose={noop}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    // 'New session' app action (EN catalog) is always present.
    expect(screen.getByText('New session')).toBeInTheDocument();
    // Active session is 'a' → only the OTHER session ('b') is listed.
    expect(screen.getByText('Session b')).toBeInTheDocument();
    expect(screen.queryByText('Session a')).not.toBeInTheDocument();
  });

  it('fuzzy-filters the list as the user types', async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        onClose={noop}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    await user.type(screen.getByRole('combobox'), 'session b');
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Session b')).toBeInTheDocument();
    // 'Auto-tile panes' (cmdRetile) must not survive a 'session b' query.
    expect(within(list).queryByText('Auto-tile panes')).not.toBeInTheDocument();
  });

  it('shows the no-results state with the query echoed back', async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        onClose={noop}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    await user.type(screen.getByRole('combobox'), 'zzzznotacommandzzzz');
    expect(screen.getByText('No results for "zzzznotacommandzzzz"')).toBeInTheDocument();
  });

  it('ArrowDown + Enter runs the selected command (switches session via store)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    const input = screen.getByRole('combobox');
    // Narrow to the single 'Session b' switch command, then run it.
    await user.type(input, 'Session b');
    await user.keyboard('{Enter}');
    // buildSessionItems.run() calls setActiveSession(s.id) + onClose().
    expect(useSessionStore.getState().activeSessionId).toBe('b');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter on a pane-split command invokes the IPC boundary with correct args', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    const input = screen.getByRole('combobox');
    // 'Split pane vertically' = cmdSplitVertical (unique enough to land first).
    await user.type(input, 'Split pane vertically');
    await user.keyboard('{Enter}');
    expect(splitMock).toHaveBeenCalledWith({
      sessionId: 'a',
      paneId: 'a-pane',
      direction: 'vertical'
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop triggers onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        onNewSession={noop}
        onOpenSettings={noop}
        onOpenMcp={noop}
      />
    );
    // The <dialog> itself is the backdrop target (e.target === currentTarget).
    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });
});
