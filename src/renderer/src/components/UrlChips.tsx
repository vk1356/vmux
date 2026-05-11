import { memo, useMemo, useState, type JSX, type MouseEvent } from 'react';
import { Globe, X } from 'lucide-react';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useSessionStore } from '../store/sessions';

interface Props {
  session: Session;
}

/** Au-delà de ce seuil, on tronque l'affichage à VISIBLE_CHIPS + bouton "expand".
 *  Évite d'afficher 100 chips qui prennent 3 lignes et obscurcissent la UI ;
 *  les chips additionnelles restent accessibles via le toggle. */
const VISIBLE_CHIPS = 20;

interface ChipEntry {
  url: string;
  paneId: string;
}

/** Chips persistants pour les URLs localhost détectées dans la session.
 *  Click = (re)charger dans le preview embarqué. × = retirer la chip. */
function UrlChipsImpl({ session }: Props): JSX.Element | null {
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const [expanded, setExpanded] = useState(false);

  // useMemo : la collection est dérivée de session.panes/session.tree. Sans
  // memo, on re-créait deux Set + un array à chaque render du parent (qui
  // re-render à chaque paneStats update, soit toutes les 2s).
  const { entries, previewPaneId } = useMemo(() => {
    const openedInPreview = new Set<string>();
    let preview: string | undefined;
    for (const p of Object.values(session.panes)) {
      if (p?.kind === 'preview') {
        if (!preview) preview = p.id;
        if (p.url) openedInPreview.add(normalizeUrl(p.url));
      }
    }

    const out: ChipEntry[] = [];
    const seen = new Set<string>();
    for (const id of allPaneIds(session.tree)) {
      const p = session.panes[id];
      if (p?.kind !== 'terminal') continue;
      const term = p as TerminalPane;
      for (const url of term.recentUrls ?? []) {
        if (seen.has(url)) continue;
        seen.add(url);
        // Filtre de sécurité : on n'affiche jamais une chip vers un schéma
        // non-http(s). Le terminal pourrait théoriquement craher une URL
        // exotique (file://, javascript:) qu'on ne veut pas exposer.
        if (!isSafeHttpUrl(url)) continue;
        if (openedInPreview.has(normalizeUrl(url))) continue;
        out.push({ url, paneId: term.id });
      }
    }
    return { entries: out, previewPaneId: preview };
  }, [session.panes, session.tree]);

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

  const showAll = expanded || entries.length <= VISIBLE_CHIPS;
  const visibleEntries = showAll ? entries : entries.slice(0, VISIBLE_CHIPS);
  const overflow = entries.length - visibleEntries.length;

  return (
    <div className="url-chips">
      {visibleEntries.map(({ url, paneId }) => (
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
      {overflow > 0 && (
        <button
          className="url-chip url-chip-more"
          onClick={() => setExpanded(true)}
          title={`Afficher ${overflow} URL(s) supplémentaire(s)`}
        >
          +{overflow}
        </button>
      )}
      {expanded && entries.length > VISIBLE_CHIPS && (
        <button
          className="url-chip url-chip-more"
          onClick={() => setExpanded(false)}
          title="Réduire"
        >
          −
        </button>
      )}
    </div>
  );
}

export const UrlChips = memo(UrlChipsImpl);

function shortLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.host}${path}`.slice(0, 30);
  } catch {
    return url.slice(0, 30);
  }
}

/** Garde-fou : on n'affiche QUE http/https. Tout autre schéma (javascript:,
 *  file:, data:, …) est ignoré — le store ne devrait jamais en stocker mais
 *  on défend en profondeur. */
function isSafeHttpUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
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
