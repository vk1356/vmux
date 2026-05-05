import type { JSX, MouseEvent } from 'react';
import { Globe, X } from 'lucide-react';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useSessionStore } from '../store/sessions';

interface Props {
  session: Session;
}

/** Chips persistants pour les URLs localhost détectées dans la session.
 *  Click = (re)charger dans le preview embarqué. × = retirer la chip. */
export function UrlChips({ session }: Props): JSX.Element | null {
  const upsertSession = useSessionStore((s) => s.upsertSession);

  // URLs déjà ouvertes dans un preview pane : pas la peine d'afficher une chip
  // qui ferait doublon avec le tab du preview.
  const openedInPreview = new Set<string>();
  let previewPaneId: string | undefined;
  for (const p of Object.values(session.panes)) {
    if (p?.kind === 'preview') {
      if (!previewPaneId) previewPaneId = p.id;
      if (p.url) openedInPreview.add(normalizeUrl(p.url));
    }
  }

  const entries: { url: string; paneId: string }[] = [];
  const seen = new Set<string>();
  for (const id of allPaneIds(session.tree)) {
    const p = session.panes[id];
    if (p?.kind !== 'terminal') continue;
    const term = p as TerminalPane;
    for (const url of term.recentUrls ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (openedInPreview.has(normalizeUrl(url))) continue;
      entries.push({ url, paneId: term.id });
    }
  }
  if (entries.length === 0) return null;

  const onClickChip = (url: string, paneId: string): void => {
    if (previewPaneId) {
      void window.cmux.panes.setUrl(session.id, previewPaneId, url);
    } else {
      void window.cmux.panes.openPreview(session.id, paneId, url);
    }
  };

  const onRemoveChip = async (
    e: MouseEvent,
    url: string,
    paneId: string
  ): Promise<void> => {
    e.stopPropagation();
    const r = await window.cmux.panes.removeUrl(session.id, paneId, url);
    if (r.ok && r.data) upsertSession(r.data);
  };

  return (
    <div className="url-chips">
      {entries.map(({ url, paneId }) => (
        <div
          key={url}
          className="url-chip"
          onClick={() => onClickChip(url, paneId)}
          title={previewPaneId ? `Charger ${url} dans le preview` : `Ouvrir le preview sur ${url}`}
        >
          <Globe size={11} />
          <span className="url-chip-label">{shortLabel(url)}</span>
          <button
            className="url-chip-close"
            onClick={(e) => void onRemoveChip(e, url, paneId)}
            title="Retirer cette URL"
            aria-label="Retirer"
          >
            <X size={9} />
          </button>
        </div>
      ))}
    </div>
  );
}

function shortLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.host}${path}`.slice(0, 30);
  } catch {
    return url.slice(0, 30);
  }
}

/** Normalise une URL pour comparaison : strip trailing slash, lowercase host. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}
