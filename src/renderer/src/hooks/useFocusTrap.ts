import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Focus trap pour les dialogs : Tab/Shift+Tab cyclent à l'intérieur du
 * conteneur. Restaure le focus à l'élément actif au moment de l'ouverture
 * quand le dialog se ferme.
 *
 * Le ref doit pointer sur le conteneur racine du dialog (la div avec
 * role="dialog"). Ne fait rien si `open === false`.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus initial : premier focusable du dialog (sauf s'il a un autoFocus
    // explicite qui a déjà pris la main).
    requestAnimationFrame(() => {
      if (!container.contains(document.activeElement)) {
        const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        first?.focus();
      }
    });

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
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
      } else {
        if (ae === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus à la fermeture si l'élément précédent existe encore.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [ref, open]);
}
