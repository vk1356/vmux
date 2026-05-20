// Per-window MessageChannelMain wiring for the zero-copy PTY data path.
//
// At window creation, main:
//   1. new MessageChannelMain() → port1 (host side), port2 (renderer side)
//   2. supervisor.sendWithPorts({kind:'attachDataPort'}, [port1])
//      → PTY Host receives port1 in its parentPort 'message' event (e.ports[0])
//   3. After the window's webContents has finished loading,
//      win.webContents.postMessage(IPC.paneDataPort, null, [port2])
//      → preload picks port2 up in its IPC handler and exposes it to the
//        renderer behind window.cmux.panes.onData (unchanged surface).
//
// Both halves are entangled. PTY byte frames flow host → renderer over them
// with ArrayBuffer transfer (zero-copy). The main thread is bypassed entirely
// for PTY output bytes.
//
// On crash respawn: the OLD child's port1 dies with it; the renderer's port2
// becomes inert. rebuildAll() (bound to PtyHostSupervisor.onRespawn) tears down
// every channel and rebuilds fresh ones for every live window.

import { BrowserWindow, MessageChannelMain } from 'electron';
import log from 'electron-log/main';
import { IPC } from '@shared/types';
import { getSettings } from './settings-store';
import type { PtyHostSupervisor } from './pty-host-supervisor';

interface ChannelEntry {
  win: BrowserWindow;
  channel: MessageChannelMain;
}

export class PaneDataChannelManager {
  private entries: ChannelEntry[] = [];

  constructor(private supervisor: PtyHostSupervisor) {
    this.supervisor.onRespawn(() => this.rebuildAll());
  }

  /** Create a fresh channel for a window. Safe to call before the window's
   *  webContents has loaded — we wait for `did-finish-load` before posting
   *  port2 to the renderer. */
  attachWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const channel = new MessageChannelMain();
    this.entries.push({ win, channel });

    // Host side: hand port1 to the PTY Host now (utilityProcess is already
    // forked at this point — bootPtyHost runs before window creation). The
    // `useDirectPort` flag tells the host whether to actually route paneData
    // through this port (zero-copy path) or to keep using parentPort routing.
    const useDirectPort = getSettings().experimentalZeroCopyIpc === true;
    try {
      this.supervisor.sendWithPorts(
        { kind: 'attachDataPort', useDirectPort },
        [channel.port1]
      );
    } catch (err) {
      log.error('[pane-data-channel] sendWithPorts failed', err);
    }

    // Renderer side: defer until did-finish-load so the preload handler is
    // registered (otherwise the IPC event arrives before the listener does).
    const sendPort2 = (): void => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      try {
        win.webContents.postMessage(IPC.paneDataPort, null, [channel.port2]);
      } catch (err) {
        log.error('[pane-data-channel] postMessage to renderer failed', err);
      }
    };
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', sendPort2);
    } else {
      sendPort2();
    }

    // Self-clean on window close.
    win.once('closed', () => this.detachWindow(win));
  }

  detachWindow(win: BrowserWindow): void {
    const idx = this.entries.findIndex((e) => e.win === win);
    if (idx < 0) return;
    this.entries.splice(idx, 1);
    // No explicit close API on MessageChannelMain — letting GC reclaim the
    // ports is fine; the renderer side observes its port being closed/inert.
  }

  /** Rebuild every live window's channel — invoked after a host crash respawn
   *  because the new child has no entanglement with the old ports. */
  rebuildAll(): void {
    log.info('[pane-data-channel] rebuilding all channels after host respawn');
    const live = this.entries.filter((e) => !e.win.isDestroyed());
    this.entries = [];
    for (const { win } of live) this.attachWindow(win);
  }

  /** Test/debug accessor. */
  _stats(): { count: number; wins: number[] } {
    return {
      count: this.entries.length,
      wins: this.entries.map((e) => e.win.id)
    };
  }
}
