import { useEffect, useRef } from 'react';

/**
 * Drag-drop d'un dossier sur la window → callback avec le path absolu.
 *
 * On skip si le drop atterrit dans un terminal (qui a son propre handler
 * insérant le path dans le PTY) — on lit `e.defaultPrevented` après que
 * le bubbling React ait laissé TerminalPane.onDrop appeler preventDefault.
 *
 * `onFolderDropped` est lu via ref live : si le caller passe une lambda
 * inline (non memoizée), on évite de ré-attacher les listeners DOM à
 * chaque render. AbortController centralise le cleanup via `{ signal }`.
 */
export function useFolderDragDrop(onFolderDropped: (path: string) => void): void {
  const cbRef = useRef(onFolderDropped);
  cbRef.current = onFolderDropped;

  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;

    const onDragOver = (e: DragEvent): void => {
      // preventDefault sur dragover est nécessaire pour autoriser le drop
      // au niveau window. Sans ça, l'OS rejette le drop.
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };

    const onDrop = (e: DragEvent): void => {
      // Si TerminalPane a déjà géré le drop, on ne fait rien.
      if (e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (target?.closest?.('.terminal-host')) return;
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (files.length === 0) return;
      e.preventDefault();
      // Premier File qui résout en dossier → callback.
      void (async (): Promise<void> => {
        for (const f of files) {
          if (signal.aborted) return;
          const p = window.cmux.fs.pathForFile(f);
          if (!p) continue;
          const isDir = await window.cmux.fs.isDirectory(p);
          if (signal.aborted) return;
          if (isDir) {
            cbRef.current(p);
            return;
          }
        }
      })();
    };

    window.addEventListener('dragover', onDragOver, { signal });
    window.addEventListener('drop', onDrop, { signal });
    return () => ac.abort();
  }, []);
}
