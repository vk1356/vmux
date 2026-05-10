import { useEffect } from 'react';

/**
 * Drag-drop d'un dossier sur la window → callback avec le path absolu.
 *
 * On skip si le drop atterrit dans un terminal (qui a son propre handler
 * insérant le path dans le PTY) — on lit `e.defaultPrevented` après que
 * le bubbling React ait laissé TerminalPane.onDrop appeler preventDefault.
 */
export function useFolderDragDrop(onFolderDropped: (path: string) => void): void {
  useEffect(() => {
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
          const p = window.cmux.fs.pathForFile(f);
          if (!p) continue;
          const isDir = await window.cmux.fs.isDirectory(p);
          if (isDir) {
            onFolderDropped(p);
            return;
          }
        }
      })();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFolderDropped]);
}
