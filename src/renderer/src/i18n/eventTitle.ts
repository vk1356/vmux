import type { DetectedEventKind, Lang } from '@shared/types';
import { translate } from './index';

/** Renvoie le titre traduit (avec emoji) d'un event détecté. Appelé au moment
 *  où on push un toast / une entrée d'historique — la lang est passée par
 *  l'appelant (lue dans le store).
 *
 *  Vit hors de Toast.tsx pour que ce dernier n'exporte que des composants
 *  (contrainte React Fast Refresh / react-refresh/only-export-components). */
export function eventTitleFor(kind: DetectedEventKind, lang: Lang = 'en'): string {
  switch (kind) {
    case 'server-ready':
      return `🚀 ${translate(lang, 'notifKindServerReady')}`;
    case 'build-success':
      return `✓ ${translate(lang, 'notifKindBuildSuccess')}`;
    case 'build-error':
      return `✗ ${translate(lang, 'notifKindBuildError')}`;
    case 'test-results':
      return `🧪 ${translate(lang, 'notifKindTests')}`;
    case 'agent-done':
      return `✓ ${translate(lang, 'notifKindAgentDone')}`;
    case 'notify':
      return `🔔 ${translate(lang, 'notifKindNotify')}`;
  }
}
