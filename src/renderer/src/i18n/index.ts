import { useEffect, useMemo, useState } from 'react';
import type { Lang } from '@shared/types';
import { useSessionStore } from '../store/sessions';
import { EN } from './en';
import type { TKey } from './en';

export type { TKey } from './en';

/** Shape qu'un locale chunk doit respecter. `Partial` car les langues
 *  peuvent omettre des clés (fallback EN). Exporté pour `satisfies` côté
 *  chaque locale — garantit (TS-side) qu'on n'introduit pas de typo de clé
 *  et qu'on ne « stringifie » pas n'importe quoi. */
export type LocaleCatalog = Partial<Record<TKey, string>>;

export const LANG_LABELS: Record<Lang, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
  ja: '日本語',
  tr: 'Türkçe'
};

/** Lazy-loaded catalog. EN est inline (fallback toujours dispo, ~25KB).
 *  Les autres langues sont des chunks séparés via import.meta.glob — Vite
 *  crée un fichier par locale, fetché on-demand quand l'user change la langue.
 *  Cold start : on charge UNIQUEMENT le catalogue de la langue active.
 *
 *  Avant : 2200 lignes de strings packed → ~80KB minifié dans le bundle main.
 *  Après : EN inline + 1 chunk de la lang active à la 1re demande. */
const LOCALE_LOADERS = import.meta.glob<{ default: LocaleCatalog }>(
  './locales/*.ts'
);

/** Catalog déjà chargé en mémoire. EN est toujours présent (inline).
 *  Mutation directe — on bump `version` pour signaler aux subscribers. */
const loaded: Partial<Record<Lang, LocaleCatalog>> = { en: EN as LocaleCatalog };
let version = 0;
const subscribers = new Set<() => void>();
const inflight = new Map<Lang, Promise<void>>();

function notify(): void {
  version++;
  for (const sub of subscribers) sub();
}

async function ensureLoaded(lang: Lang): Promise<void> {
  if (lang === 'en' || loaded[lang]) return;
  const existing = inflight.get(lang);
  if (existing) return existing;
  const key = `./locales/${lang}.ts`;
  const loader = LOCALE_LOADERS[key];
  if (!loader) return; // langue inconnue → fallback EN silencieux
  const p = loader()
    .then((mod) => {
      const cat = mod.default;
      loaded[lang] = cat;
      // Dev-only invariant : warn si placeholders incompatibles avec EN.
      // (Le `satisfies` côté locale attrape déjà les typos de clé.)
      if (import.meta.env?.DEV) {
        warnPlaceholderMismatch(lang, cat);
      }
    })
    .catch((err) => {
      // En cas d'erreur réseau / chunk corrompu : on log et on laisse
      // les composants continuer en EN. Mieux que crasher l'UI entière.
      // eslint-disable-next-line no-console
      console.warn(`[i18n] failed to load locale "${lang}":`, err);
    })
    .finally(() => {
      inflight.delete(lang);
      notify();
    });
  inflight.set(lang, p);
  return p;
}

/** En dev, on signale les placeholders manquants (ex: `{name}` présent en EN
 *  mais oublié dans la traduction) — silent en prod. Pas de throw : on veut
 *  juste éclairer le dev pendant le travail de trad. */
const PLACEHOLDER_RE = /\{(\w+)\}/g;

function placeholdersOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return out;
}

function warnPlaceholderMismatch(lang: Lang, cat: LocaleCatalog): void {
  for (const k in cat) {
    const enVal = (EN as Record<string, string>)[k];
    const trVal = cat[k as TKey];
    if (typeof enVal !== 'string' || typeof trVal !== 'string') continue;
    const en = placeholdersOf(enVal);
    const tr = placeholdersOf(trVal);
    for (const p of tr) {
      if (!en.has(p)) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n][${lang}] extra placeholder {${p}} in "${k}"`);
      }
    }
    for (const p of en) {
      if (!tr.has(p)) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n][${lang}] missing placeholder {${p}} in "${k}"`);
      }
    }
  }
}

/** Interpolation safe sans regex : on splitte le template sur `{xxx}` une
 *  seule fois (résultat caché si on voulait), puis on join avec les valeurs.
 *  Avantage vs `.replace(/.../g, ...)` :
 *   - pas de surprise sur les literals `{` non-placeholders (ex: code,
 *     contenu JSON, etc.) — un token n'est extrait que s'il matche `{\w+}`,
 *     et tout le reste est conservé verbatim
 *   - 0 backtracking, 0 RegExp object alloué par appel
 *   - facile à tester */
function interpolate(template: string, vars: Record<string, string | number>): string {
  // Path rapide : pas de `{` du tout → retour direct.
  if (template.indexOf('{') === -1) return template;
  let out = '';
  let i = 0;
  const n = template.length;
  while (i < n) {
    const open = template.indexOf('{', i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    // Cherche un `}` qui ferme un placeholder « pur » `\w+`.
    const close = template.indexOf('}', open + 1);
    if (close === -1) {
      out += template.slice(open);
      break;
    }
    const name = template.slice(open + 1, close);
    // Un placeholder valide ne contient que [A-Za-z0-9_].
    if (name.length > 0 && /^\w+$/.test(name)) {
      const v = vars[name];
      out += v !== undefined && v !== null ? String(v) : `{${name}}`;
    } else {
      // Pas un placeholder — préserver le `{...}` brut (literal).
      out += template.slice(open, close + 1);
    }
    i = close + 1;
  }
  return out;
}

/** Renvoie la traduction d'une clé dans la langue donnée, fallback EN.
 *  Fallback robuste :
 *   - si la locale n'est pas (encore) loaded → EN
 *   - si la clé est manquante dans la locale → EN
 *   - si la clé est vide / whitespace dans la locale → EN (évite l'UI vide)
 *   - si la clé manque aussi en EN → on retourne la clé brute (visible bug). */
export function translate(
  lang: Lang,
  key: TKey,
  vars?: Record<string, string | number>
): string {
  const tr = loaded[lang]?.[key];
  const en = (EN as Record<string, string>)[key];
  // Object lookup direct (pas de Map.get) — plus rapide pour les hot paths.
  let raw: string;
  if (typeof tr === 'string' && tr.length > 0 && tr.trim().length > 0) {
    raw = tr;
  } else if (typeof en === 'string') {
    raw = en;
  } else {
    // Clé totalement inconnue — ne PAS crasher, surfacer la key pour repérage.
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] unknown key "${key}"`);
    }
    return key;
  }
  if (!vars) return raw;
  return interpolate(raw, vars);
}

/** Type de la fonction t() retournée par `useT()`. Réutilisable pour passer
 *  t à des helpers extraits hors du composant. */
export type TFunction = (key: TKey, vars?: Record<string, string | number>) => string;

/** Snapshot du store extrait dehors pour ne pas re-créer le selector à
 *  chaque render — Zustand v5 réuse la ref si la fonction est stable. */
const selectLang = (s: ReturnType<typeof useSessionStore.getState>): Lang =>
  (s.settings?.language ?? 'en') as Lang;

/** Hook : renvoie une fonction `t(key, vars?)` qui se met à jour automatiquement
 *  quand la langue change dans le store ET quand le catalogue lazy-loaded
 *  arrive. Pendant le fetch, on rend en EN (fallback transparent).
 *
 *  Stabilité d'identité : on retourne la MÊME fonction `t` tant que `lang` et
 *  le `version` du catalog n'ont pas changé. Critique pour `useMemo`/`useCallback`
 *  qui prennent `t` en dépendance — sinon ils s'invalident à chaque render. */
export function useT(): TFunction {
  const lang = useSessionStore(selectLang);
  // Subscribe au version counter : trigger re-render quand un nouveau
  // catalog est chargé.
  const [v, setV] = useState(version);
  useEffect(() => {
    const sub = (): void => setV(version);
    subscribers.add(sub);
    void ensureLoaded(lang);
    // Sync `<html lang>` côté DOM pour que les screen readers prononcent
    // l'UI dans la bonne langue. Sans ça, le `lang="en"` figé dans
    // index.html persiste même quand l'user passe en FR/JA/ZH.
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    }
    return () => {
      subscribers.delete(sub);
    };
  }, [lang]);
  // `v` est INTENTIONNEL et load-bearing : c'est le compteur de version du
  // catalogue, bumpé par notify() quand un chunk de locale lazy finit de charger
  // (lang est alors inchangé). C'est la SEULE chose qui redonne une identité
  // fraîche à `t`, pour que les useMemo/useCallback en aval (items CommandPalette…)
  // recalculent. Ne PAS retirer `v` pour satisfaire le linter → retraductions figées.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<TFunction>(() => (key, vars) => translate(lang, key, vars), [lang, v]);
}

/** Renvoie la lang BCP47 courante — utilisée pour `Intl.NumberFormat`,
 *  `Intl.RelativeTimeFormat`, etc. Pour `zh` on retourne `zh-CN` car les
 *  chaînes sont en chinois simplifié. */
export function useLocale(): string {
  const lang = useSessionStore(selectLang);
  return lang === 'zh' ? 'zh-CN' : lang;
}

// ---------------------------------------------------------------------------
// Intl formatter caches
// ---------------------------------------------------------------------------
// Re-créer un `Intl.NumberFormat` / `Intl.PluralRules` à chaque render est
// notoirement coûteux (parse de la locale, lookup CLDR). On garde un cache
// LRU-naïf : clé = `${locale}|${optionsHash}`, valeur = l'instance.
// Bénéfice : cas répétés (StatusBar, NotificationCenter, paneStats) ne
// payent la construction qu'une fois.

type IntlFormatter =
  | Intl.NumberFormat
  | Intl.PluralRules
  | Intl.DateTimeFormat
  | Intl.RelativeTimeFormat
  | Intl.ListFormat;

const formatterCache = new Map<string, IntlFormatter>();

function cacheKey(kind: string, locale: string, options?: object): string {
  return options ? `${kind}|${locale}|${JSON.stringify(options)}` : `${kind}|${locale}`;
}

export function getNumberFormat(
  locale: string,
  options?: Intl.NumberFormatOptions
): Intl.NumberFormat {
  const key = cacheKey('n', locale, options);
  let f = formatterCache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    formatterCache.set(key, f);
  }
  return f;
}

export function getPluralRules(
  locale: string,
  options?: Intl.PluralRulesOptions
): Intl.PluralRules {
  const key = cacheKey('p', locale, options);
  let f = formatterCache.get(key) as Intl.PluralRules | undefined;
  if (!f) {
    f = new Intl.PluralRules(locale, options);
    formatterCache.set(key, f);
  }
  return f;
}

export function getDateTimeFormat(
  locale: string,
  options?: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = cacheKey('d', locale, options);
  let f = formatterCache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, f);
  }
  return f;
}

export function getRelativeTimeFormat(
  locale: string,
  options?: Intl.RelativeTimeFormatOptions
): Intl.RelativeTimeFormat {
  const key = cacheKey('r', locale, options);
  let f = formatterCache.get(key) as Intl.RelativeTimeFormat | undefined;
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, options);
    formatterCache.set(key, f);
  }
  return f;
}

/** Hook combiné : retourne `t`, la locale BCP47 et un helper plural-aware.
 *  Pratique pour les composants qui ont besoin des trois (StatusBar, etc.). */
export function useI18n(): {
  t: TFunction;
  locale: string;
  /** Choisit la clé `oneKey` ou `otherKey` selon `Intl.PluralRules`. */
  plural: (count: number, oneKey: TKey, otherKey: TKey) => string;
} {
  const t = useT();
  const locale = useLocale();
  // useMemo donne déjà une identité stable de `plural` tant que
  // (locale, t) ne changent pas — pas besoin de ref additionnel.
  return useMemo(() => {
    const plural = (count: number, oneKey: TKey, otherKey: TKey): string => {
      const rules = getPluralRules(locale);
      const cat = rules.select(count);
      return t(cat === 'one' ? oneKey : otherKey, { n: count });
    };
    return { t, locale, plural };
  }, [t, locale]);
}
