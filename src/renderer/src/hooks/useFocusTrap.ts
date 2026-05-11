import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** Liste les focusables visibles dans `container`. */
function visibleFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
  );
}

/**
 * Focus trap pour les dialogs : Tab/Shift+Tab cyclent à l'intérieur du
 * conteneur. Restaure le focus à l'élément actif au moment de l'ouverture
 * quand le dialog se ferme.
 *
 * Le ref doit pointer sur le conteneur racine du dialog (la div avec
 * role="dialog"). Ne fait rien si `open === false`.
 *
 * AbortSignal centralise tout le cleanup (keydown listener + rAF guard).
 * Si le composant unmount avant que le rAF de focus initial ne tire, on
 * skip l'appel `.focus()` qui sinon volerait le focus à l'élément suivant.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const ac = new AbortController();
    const { signal } = ac;

    // Focus initial : premier focusable du dialog (sauf s'il a un autoFocus
    // explicite qui a déjà pris la main). rAF guard évite un focus tardif
    // après unmount.
    const raf = requestAnimationFrame(() => {
      if (signal.aborted) return;
      if (!container.contains(document.activeElement)) {
        const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        first?.focus();
      }
    });

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const focusables = visibleFocusables(container);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const ae = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (ae === first || !container.contains(ae)) {
          e.preventDefault();
          last.focus();
        }
      } else if (ae === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown, { signal });
    return () => {
      ac.abort();
      cancelAnimationFrame(raf);
      // Restore focus à la fermeture si l'élément précédent existe encore
      // et n'a pas été détaché du DOM (move dans un autre subtree par ex.).
      if (previouslyFocused && previouslyFocused.isConnected) {
        try {
          previouslyFocused.focus();
        } catch {
          /* ignore — élément non focusable */
        }
      }
    };
  }, [ref, open]);
}
