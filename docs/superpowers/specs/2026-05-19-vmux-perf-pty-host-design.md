# vMux — Refonte performance : PTY Host + transport zero-copy + renderer mutualisé

**Date :** 2026-05-19
**Statut :** Design validé (sections 1–6 approuvées), prêt pour plan d'implémentation
**Échelle cible :** 5–12 panes simultanés, refonte profonde acceptée

## Problème

vMux est déjà fortement optimisé sur le batching et xterm. À l'échelle 5–12 panes,
le goulot réel n'est plus là : c'est le **thread `main` unique** qui possède node-pty,
exécute `stripAnsi` + détecteurs + agent-state **synchroniquement par chunk**,
ré-encode UTF-8, puis sérialise en structured-clone sur l'IPC — tout en gérant
les fenêtres. Sous spew de 12 PTY ce thread sature ; **toute** la latence
(y compris frappe→écho) en dépend.

Symptômes observés (tous) : latence frappe→écho, lag sous spew agent,
lenteur multi-pane, démarrage app/session.

## Architecture cible

### Topologie des process

Introduction d'un **PTY Host** : un `utilityProcess` Electron (vrai process Node,
accès natif → node-pty y vit). PTY Host **unique**, partagé par toutes les
fenêtres (les PTY sont déjà cross-window aujourd'hui ; un host unique est plus
simple qu'un host par fenêtre détachée).

```
┌─────────────┐   contrôle (spawn/kill/resize)        ┌──────────────┐
│   main      │◀─── invoke/handle ──────────────────▶│  PTY Host    │
│  fenêtres,  │                                       │ utilityProc  │
│  sessions,  │                                       │  node-pty ×N │
│  persist,   │                                       │  PaneData-   │
│  méta       │                                       │  Buffer,     │
│             │                                       │  strip/detect│
│             │                                       │  /state      │
└──────┬──────┘                                       └──────┬───────┘
       │ crée MessageChannelMain                              │
       │  ┌───────────────────────────────────────────────┐  │
       └─▶│  port renderer ◀═══ data PTY (zero-copy) ═════▶│◀─┘
          └───────────────────────────────────────────────┘
                 BYPASS du thread main sur le hot path
```

**Répartition des responsabilités :**

- **main** : fenêtres, arbre de panes, persistance sessions, settings, updater,
  métadonnées agrégées (status, URLs, agent-state). N'achemine plus les octets PTY.
- **PTY Host** : possède les `pty.IPty`, le `PaneDataBuffer`, et **tout** le
  pipeline `stripAnsi` / détecteurs / agent-state. Émet vers `main` uniquement
  des events méta basse fréquence (déjà throttlés aujourd'hui).
- **Transport data** : à la création d'une fenêtre, `main` crée un
  `MessageChannelMain` ; un port va au renderer (via `postMessage` exposé par le
  preload), l'autre au PTY Host. Les chunks PTY ne touchent jamais le thread main.

**Lifecycle :** PTY Host spawné au boot ; superviseur dans `main` qui le respawn
s'il crash (état sessions persistant côté main → reconstruction possible).
Isolation gagnée : un bug détecteur ne tue plus les fenêtres. `shutdown()`
orchestré par `main` ; le kill-tree (pidtree) est déplacé dans le host.

### Transport data zero-copy

Aujourd'hui : `pty.onData` (string UTF-16) → `PaneDataBuffer` concat strings →
`TextEncoder.encode` (transcode UTF-8) → `webContents.send` (structured-clone =
copie) → preload → bus.

Cible :

- node-pty en **mode Buffer** (`encoding: null`) → octets bruts, **zéro transcode**.
- `PaneDataBuffer` concatène des `Uint8Array` (réutiliser l'algo `concatU8`
  déjà présent côté renderer ; remonter dans un module partagé).
- Flush → `port.postMessage(arrayBuffer, [arrayBuffer])` : **transfert**
  (neutering), zero-copy, hors thread main.
- Renderer : un handler `port.onmessage` global remplace `subscribePaneData` +
  l'IPC `paneData`. `term.write(Uint8Array)` direct.

**Flush adaptatif (latence frappe→écho) :** si buffer < `INTERACTIVE_THRESHOLD`
(~512 octets) **et** silence préalable > ~50 ms → flush **immédiat** (écho
clavier). Sinon coalescing 16 ms (spew = priorité débit). Un petit écho ne paie
plus jamais 16 ms de latence fixe.

### Pipeline d'analyse relocalisé

`stripAnsi` + `updateAgentState` + `emitAttention` + `detectOscEvents` +
détecteurs throttlés URL/event : **déplacés tels quels** dans le PTY Host
(logique inchangée, relocalisée hors du chemin renderer et hors `main`).

- Décodage pour détecteurs : `TextDecoder` **incrémental** (`stream: true`) sur
  un tail roulant, **jamais** sur le chemin data. Les octets bruts filent vers
  le renderer en parallèle, non bloqués par l'analyse.
- Le host émet vers `main` les events méta (`paneStatus`, `urlsDetected`,
  `paneAgentState`, `paneAttention`) via l'IPC `utilityProcess` — basse
  fréquence, déjà throttlée. `main` les relaie aux fenêtres comme aujourd'hui.

### Renderer : pool WebGL + virtualisation

Problème à 5–12 panes : chaque pane = 1 contexte WebGL ; plafond navigateur
~16 → au-delà, context-loss en cascade → fallback DOM lent.

Cible :

- **Pool de renderers WebGL borné** (configurable, défaut 6–8) attribué aux
  panes visibles par LRU. Pane visible sans slot → addon canvas DOM temporaire.
- **Virtualisation réelle** : pane jamais visible → xterm non instancié (déjà
  le cas via `visible`) mais buffer d'octets sérialisé conservé ; premier
  affichage = `write()` du buffer concaténé. Généraliser la mécanique `pending`
  existante comme source de vérité unique.
- Pane caché > 30 s → `dispose()` complet du Terminal + libération du slot
  WebGL ; état conservé en buffer ; réattache transparent au retour.

### Démarrage

- node-pty chargé **dans le PTY Host pendant que la fenêtre peint**
  (parallélisé, hors chemin critique du premier render).
- Addons xterm en **import dynamique** lazy (search / ligatures / clipboard à
  la demande, pas au mount).
- `autoRestoreSessions` : spawn **échelonné** piloté par le host, priorité au
  pane actif de la session affichée.
- Flags GPU explicites (`app.commandLine`) pour stabiliser WebGL au cold start.

## Phasage

Chaque phase est shippable (bump semver + `npm run release` selon le workflow
projet).

1. **PTY Host process** + relocalisation node-pty / `PaneDataBuffer` / pipeline
   d'analyse. Transport encore via `main` (IPC inchangé). → isole le CPU spew.
2. **MessageChannelMain zero-copy** renderer↔host + path octets bruts. →
   latence + CPU transcode.
3. **Flush adaptatif**. → frappe→écho.
4. **Pool WebGL + virtualisation/dispose**. → rendu multi-pane.
5. **Optimisations startup**.

## Tests

- `PaneDataBuffer` et détecteurs sont déjà testés en isolation → réutilisables
  tels quels dans le host.
- Ajouts : tests d'intégration host (spawn / data / kill / restart), bench
  latence frappe→écho et débit spew, intégrés en régression gate.
- Tests cross-process : corréler les logs par `paneId`.

## Risques

- **node-pty/ConPTY en utilityProcess sous Windows** : point dur, à valider
  dès la Phase 1 (PoC spawn + data + resize + kill avant d'aller plus loin).
- **Debug cross-process** : mitigé par logs corrélés `paneId` + `--inspect`
  sur le host.
- **Lifecycle/crash du host** : superviseur + respawn dans `main`, état
  sessions persistant.

## Hors scope (YAGNI)

- Addon natif custom de parsing ANSI : non retenu (xterm WebGL suffit une fois
  le main libéré).
- Multi-host (un par fenêtre) : non retenu (host unique suffit).
- Transport partagé `SharedArrayBuffer`/ring-buffer : non retenu en première
  intention (le transfert d'`ArrayBuffer` zero-copy couvre le besoin ; à
  reconsidérer seulement si bench Phase 2 insuffisant).

## Gain réaliste attendu

5–15x sur le débit spew / scaling multi-pane (thread main jamais bloqué),
latence frappe→écho quasi divisée par 2 (un hop supprimé + zero-copy + flush
adaptatif). Le « 100x » initial n'est pas un objectif réaliste sur un pipeline
déjà optimisé ; ces gains-ci le sont.
