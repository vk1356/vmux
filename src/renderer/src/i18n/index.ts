import type { Lang } from '@shared/types';
import { useSessionStore } from '../store/sessions';

/** Catalogue des chaînes traduites. EN est la source de vérité — les autres
 *  langues peuvent omettre des clés, on retombe alors sur EN. */
export type TKey = keyof typeof EN;

const EN = {
  // App / window
  appTagline: 'AI multi-agent orchestrator',

  // Hero / EmptyState
  heroTitleA: 'Multiple AI agents,',
  heroTitleB: 'one window.',
  heroLead:
    "vMux orchestrates Claude Code, Codex, Aider and more in parallel — each in its own git worktree. No branch collisions, just agents working in silence.",
  heroCta: 'New session',
  heroCtaHint: 'or press',
  heroFeatureSplitsTitle: 'Tmux-style splits',
  heroFeatureSplitsBody:
    'Split horizontally, vertically, or auto-tile in a 2D grid — one shortcut.',
  heroFeaturePreviewTitle: 'Localhost preview',
  heroFeaturePreviewBody:
    'URL detected → embedded preview inside the window, no flow break.',
  heroFeatureWorktreesTitle: 'Git worktrees',
  heroFeatureWorktreesBody:
    'Each agent in its own worktree — isolated branches, zero collisions.',
  heroFeatureMultiAgentTitle: 'Multi-agent',
  heroFeatureMultiAgentBody:
    'Claude Code, Codex, Aider, Cursor, Gemini — all from the same window.',
  heroFeatureNotifsTitle: 'Native notifications',
  heroFeatureNotifsBody:
    'Windows push + taskbar flash when an agent needs attention in the background.',
  heroFeaturePtyTitle: 'Native ConPTY',
  heroFeaturePtyBody:
    'Native Windows terminal via node-pty — performance and shell compatibility.',
  shortcutNewSession: 'New session',
  shortcutAddPane: 'Add pane',
  shortcutRetile: 'Retile',
  shortcutPalette: 'Palette',
  shortcutSettings: 'Settings',

  // Settings dialog
  settingsTitle: 'Settings',
  settingsClose: 'Close',
  settingsSavingHint: 'Saving…',
  settingsLiveHint: 'Changes applied live.',
  tabAppearance: 'Appearance',
  tabTerminal: 'Terminal',
  tabNotifications: 'Notifications',
  tabAgents: 'Agents',
  tabUpdates: 'Updates',
  tabAdvanced: 'Advanced',

  // Settings → Appearance
  fieldLanguage: 'Language',
  fieldTheme: 'Theme',
  themeDark: 'Dark',
  themeLight: 'Light (coming)',
  themeSystem: 'System',
  themeLightHint: "Light mode isn't styled yet — stay on dark.",
  fieldFont: 'Font',
  fieldFontSize: 'Font size',
  fieldCursorBlink: 'Blinking cursor',

  // Settings → Terminal
  fieldShell: 'Default shell',
  fieldShellHint: 'Used for new shell panes. Agent sessions keep their own command.',
  fieldScrollback: 'Scrollback',
  scrollbackUnit: 'lines',
  fieldCopyOnSelect: 'Copy selection automatically',
  fieldPasteRightClick: 'Paste on right-click',
  fieldWebgl: 'WebGL renderer (perf++)',
  fieldWebglHint: 'restart the app to apply',

  // Settings → Notifications
  fieldNotifs: 'Windows system notifications',
  fieldNotifsHint:
    'Receive a push notification (with vMux icon) when an agent needs an action or an event (build, server, tests) is detected in the background.',
  sectionPreviewLocalhost: 'Localhost preview',
  fieldPreviewToast: 'Show a toast when a localhost URL is detected',
  fieldPreviewAutoOpen: 'Open the embedded preview automatically',
  fieldPreviewSplit: 'Preview split size',
  fieldPreviewSplitHint:
    'Percentage taken by the terminal vs the preview when opening a preview.',

  // Settings → Agents
  agentsHint:
    'Overrides are saved but not yet applied to spawn (coming).',
  agentNotInstalled: 'not installed',

  // Settings → Updates
  fieldInstalledVersion: 'Installed version',
  fieldStatus: 'Status',
  updateCheck: 'Check now',
  updateDownload: 'Download v',
  updateInstall: 'Install and restart',
  updateAutoHint:
    'vMux automatically checks for new versions at startup and every 4 hours. Updates are published on GitHub Releases.',
  updateSeeAll: 'See all versions',
  updateNoCheck: 'No recent check.',
  updateChecking: 'Checking…',
  updateUpToDate: 'Up to date',
  updateAvailable: 'New version available',
  updateDownloading: 'Downloading',
  updateReady: 'Update ready to install',
  updateError: 'Error',
  errInstallNoDownload:
    'Download not completed yet — re-run download or install manually from the website.',
  errNoInstallerUrl: 'Installer URL not found in the latest release.',
  errGithubApiFailed: 'GitHub API call failed. Check your connection.',
  errNoResponse: 'No response from update server. Check your internet connection.',
  errDevMode: 'Available only in the installed app, not in dev mode.',

  // Settings → Advanced
  fieldDiagnostic: 'Diagnostic',
  diagnosticBtn: 'Export diagnostic (.json)',
  diagnosticHint:
    'Generates a report (versions, agents, sessions, recent logs) to attach to bug reports. Agent overrides are anonymized.',
  fieldSource: 'Source',
  sourceBtn: 'Open GitHub repo',

  // Update banner
  bannerAvailable: 'Update available',
  bannerAvailableBody: 'Version {version} is ready to download.',
  bannerDownloading: 'Downloading… {pct}%',
  bannerReady: 'Update ready',
  bannerReadyBody: 'Version {version} — restart to install.',
  bannerError: 'Update failed',
  bannerLater: 'Later',
  bannerDownloadBtn: 'Download',
  bannerInstallBtn: 'Install and restart',

  // StatusBar
  statusActive: 'active',
  statusAttentionCount:
    '{n} session(s) need attention — click to switch',

  // Sidebar
  sidebarTitle: 'Sessions',
  sidebarFilter: 'Filter…',
  sidebarEmptyTitle: 'No session.',
  sidebarEmptyBody: 'Create one to launch an AI agent in its own worktree.',
  sidebarNoResults: 'No results.'
} as const;

const FR: Partial<Record<TKey, string>> = {
  appTagline: 'orchestrateur multi-agents IA',
  heroTitleA: 'Plusieurs agents IA,',
  heroTitleB: 'une seule fenêtre.',
  heroLead:
    "vMux orchestre Claude Code, Codex, Aider et bien d'autres en parallèle — chacun dans son propre worktree git. Aucune collision de branche, juste des agents qui bossent en silence.",
  heroCta: 'Nouvelle session',
  heroCtaHint: 'ou tape',
  heroFeatureSplitsTitle: 'Splits tmux-like',
  heroFeatureSplitsBody:
    'Découpe horizontalement, verticalement, ou auto-tile en grille 2D — un raccourci.',
  heroFeaturePreviewTitle: 'Preview localhost',
  heroFeaturePreviewBody:
    'URL détectée → preview embarqué dans la fenêtre, sans quitter ton flow.',
  heroFeatureWorktreesTitle: 'Worktrees git',
  heroFeatureWorktreesBody:
    'Chaque agent dans son propre worktree — branches isolées, zéro collision.',
  heroFeatureMultiAgentTitle: 'Multi-agents',
  heroFeatureMultiAgentBody:
    'Claude Code, Codex, Aider, Cursor, Gemini — tous gérés depuis la même fenêtre.',
  heroFeatureNotifsTitle: 'Notifications natives',
  heroFeatureNotifsBody:
    "Push Windows + flash taskbar quand l'agent demande une action en background.",
  heroFeaturePtyTitle: 'PTY natif ConPTY',
  heroFeaturePtyBody:
    'Terminal Windows natif via node-pty — performances et compatibilité shell.',
  shortcutNewSession: 'Nouvelle session',
  shortcutAddPane: 'Ajouter un pane',
  shortcutRetile: 'Re-tile',
  shortcutPalette: 'Palette',
  shortcutSettings: 'Paramètres',
  settingsTitle: 'Paramètres',
  settingsClose: 'Fermer',
  settingsSavingHint: 'Sauvegarde…',
  settingsLiveHint: 'Modifications appliquées en live.',
  tabAppearance: 'Apparence',
  tabTerminal: 'Terminal',
  tabNotifications: 'Notifications',
  tabAgents: 'Agents',
  tabUpdates: 'Mises à jour',
  tabAdvanced: 'Avancé',
  fieldLanguage: 'Langue',
  fieldTheme: 'Thème',
  themeDark: 'Sombre',
  themeLight: 'Clair (à venir)',
  themeSystem: 'Système',
  themeLightHint: "Le mode clair n'est pas encore stylé — reste sur sombre.",
  fieldFont: 'Police',
  fieldFontSize: 'Taille de police',
  fieldCursorBlink: 'Curseur clignotant',
  fieldShell: 'Shell par défaut',
  fieldShellHint:
    'Utilisé pour les nouveaux panes shell. Les sessions agent gardent leur commande.',
  fieldScrollback: 'Scrollback',
  scrollbackUnit: 'lignes',
  fieldCopyOnSelect: 'Copier la sélection automatiquement',
  fieldPasteRightClick: 'Coller au clic-droit',
  fieldWebgl: 'Renderer WebGL (perf++)',
  fieldWebglHint: "redémarre l'app pour appliquer",
  fieldNotifs: 'Notifications système Windows',
  fieldNotifsHint:
    "Reçois une notif push (avec icône vMux) quand un agent demande une action ou qu'un événement (build, server, tests) est détecté en arrière-plan.",
  sectionPreviewLocalhost: 'Preview localhost',
  fieldPreviewToast: 'Afficher un toast quand une URL localhost est détectée',
  fieldPreviewAutoOpen: 'Ouvrir le preview embarqué automatiquement',
  fieldPreviewSplit: 'Taille du split preview',
  fieldPreviewSplitHint:
    "Pourcentage que prend le terminal vs le preview quand on ouvre un preview.",
  agentsHint:
    "Les overrides sont sauvegardés mais ne sont pas encore appliqués au spawn (à venir).",
  agentNotInstalled: 'non installé',
  fieldInstalledVersion: 'Version installée',
  fieldStatus: 'Statut',
  updateCheck: 'Vérifier maintenant',
  updateDownload: 'Télécharger v',
  updateInstall: 'Installer et redémarrer',
  updateAutoHint:
    'vMux vérifie automatiquement les nouvelles versions au démarrage et toutes les 4 heures. Les mises à jour sont publiées sur GitHub Releases.',
  updateSeeAll: 'Voir toutes les versions',
  updateNoCheck: 'Aucune vérification récente.',
  updateChecking: 'Vérification…',
  updateUpToDate: 'À jour',
  updateAvailable: 'Nouvelle version disponible',
  updateDownloading: 'Téléchargement',
  updateReady: 'Mise à jour prête à être installée',
  updateError: 'Erreur',
  errInstallNoDownload:
    "Téléchargement non terminé — relance le download ou installe manuellement depuis le site.",
  errNoInstallerUrl: "URL de l'installateur introuvable dans la dernière release.",
  errGithubApiFailed: "L'appel à l'API GitHub a échoué. Vérifie ta connexion.",
  errNoResponse: 'Pas de réponse du serveur de mise à jour. Vérifie ta connexion internet.',
  errDevMode: "Disponible uniquement dans l'app installée, pas en mode dev.",
  fieldDiagnostic: 'Diagnostic',
  diagnosticBtn: 'Exporter le diagnostic (.json)',
  diagnosticHint:
    "Génère un rapport (versions, agents, sessions, derniers logs) à fournir en cas de bug. Les overrides agents sont anonymisés.",
  fieldSource: 'Source',
  sourceBtn: 'Ouvrir le repo GitHub',
  bannerAvailable: 'Mise à jour disponible',
  bannerAvailableBody: 'Version {version} prête à être téléchargée.',
  bannerDownloading: 'Téléchargement en cours… {pct}%',
  bannerReady: 'Mise à jour prête',
  bannerReadyBody: 'Version {version} — redémarre pour installer.',
  bannerError: 'Échec de la mise à jour',
  bannerLater: 'Plus tard',
  bannerDownloadBtn: 'Télécharger',
  bannerInstallBtn: 'Installer et redémarrer',
  statusActive: 'actif',
  statusAttentionCount:
    '{n} session(s) demande(nt) attention — clique pour aller',
  sidebarTitle: 'Sessions',
  sidebarFilter: 'Filtrer…',
  sidebarEmptyTitle: 'Aucune session.',
  sidebarEmptyBody: "Crée-en une pour lancer un agent IA dans son propre worktree.",
  sidebarNoResults: 'Aucun résultat.'
};

const DE: Partial<Record<TKey, string>> = {
  appTagline: 'KI-Multi-Agent-Orchestrator',
  heroTitleA: 'Mehrere KI-Agenten,',
  heroTitleB: 'ein Fenster.',
  heroLead:
    'vMux orchestriert Claude Code, Codex, Aider und mehr parallel — jeder in seinem eigenen Git-Worktree. Keine Branch-Konflikte, nur Agenten, die im Hintergrund arbeiten.',
  heroCta: 'Neue Sitzung',
  heroCtaHint: 'oder drücke',
  heroFeatureSplitsTitle: 'Tmux-Splits',
  heroFeatureSplitsBody:
    'Teile horizontal, vertikal oder auto-tile in einem 2D-Raster — eine Tastenkombination.',
  heroFeaturePreviewTitle: 'Localhost-Vorschau',
  heroFeaturePreviewBody:
    'URL erkannt → eingebettete Vorschau im Fenster, ohne Unterbrechung.',
  heroFeatureWorktreesTitle: 'Git-Worktrees',
  heroFeatureWorktreesBody:
    'Jeder Agent in seinem eigenen Worktree — isolierte Branches, keine Kollisionen.',
  heroFeatureMultiAgentTitle: 'Multi-Agent',
  heroFeatureMultiAgentBody:
    'Claude Code, Codex, Aider, Cursor, Gemini — alles aus demselben Fenster.',
  heroFeatureNotifsTitle: 'Native Benachrichtigungen',
  heroFeatureNotifsBody:
    'Windows-Push + Taskbar-Blink, wenn ein Agent im Hintergrund Aufmerksamkeit braucht.',
  heroFeaturePtyTitle: 'Natives ConPTY',
  heroFeaturePtyBody:
    'Natives Windows-Terminal über node-pty — Performance und Shell-Kompatibilität.',
  shortcutNewSession: 'Neue Sitzung',
  shortcutAddPane: 'Pane hinzufügen',
  shortcutRetile: 'Neu kacheln',
  shortcutPalette: 'Palette',
  shortcutSettings: 'Einstellungen',
  settingsTitle: 'Einstellungen',
  settingsClose: 'Schließen',
  tabAppearance: 'Erscheinungsbild',
  tabTerminal: 'Terminal',
  tabNotifications: 'Benachrichtigungen',
  tabAgents: 'Agenten',
  tabUpdates: 'Updates',
  tabAdvanced: 'Erweitert',
  fieldLanguage: 'Sprache',
  fieldTheme: 'Design',
  themeDark: 'Dunkel',
  themeLight: 'Hell (kommt)',
  themeSystem: 'System',
  fieldFont: 'Schriftart',
  fieldFontSize: 'Schriftgröße',
  fieldCursorBlink: 'Blinkender Cursor',
  fieldShell: 'Standard-Shell',
  fieldNotifs: 'Windows-Systembenachrichtigungen',
  updateCheck: 'Jetzt prüfen',
  updateDownload: 'Herunterladen v',
  updateInstall: 'Installieren und neu starten',
  bannerAvailable: 'Update verfügbar',
  bannerDownloadBtn: 'Herunterladen',
  bannerInstallBtn: 'Installieren und neu starten',
  bannerLater: 'Später',
  sidebarTitle: 'Sitzungen',
  sidebarFilter: 'Filtern…',
  errInstallNoDownload:
    'Download nicht abgeschlossen — erneut herunterladen oder manuell installieren.',
  errNoInstallerUrl: 'Installer-URL im neuesten Release nicht gefunden.',
  errGithubApiFailed: 'GitHub-API-Aufruf fehlgeschlagen. Verbindung prüfen.',
  errNoResponse: 'Keine Antwort vom Update-Server. Internetverbindung prüfen.',
  errDevMode: 'Nur in der installierten App verfügbar, nicht im Dev-Modus.'
};

const ES: Partial<Record<TKey, string>> = {
  appTagline: 'orquestador multi-agente IA',
  heroTitleA: 'Múltiples agentes IA,',
  heroTitleB: 'una sola ventana.',
  heroLead:
    'vMux orquesta Claude Code, Codex, Aider y más en paralelo — cada uno en su propio worktree git. Sin colisiones de ramas, solo agentes trabajando en silencio.',
  heroCta: 'Nueva sesión',
  heroCtaHint: 'o pulsa',
  heroFeatureSplitsTitle: 'Splits estilo tmux',
  heroFeatureSplitsBody:
    'Divide horizontal, vertical o auto-tile en cuadrícula 2D — un atajo.',
  heroFeaturePreviewTitle: 'Vista previa localhost',
  heroFeaturePreviewBody:
    'URL detectada → vista previa embebida en la ventana, sin interrumpir el flujo.',
  heroFeatureWorktreesTitle: 'Worktrees git',
  heroFeatureWorktreesBody:
    'Cada agente en su propio worktree — ramas aisladas, cero colisiones.',
  heroFeatureMultiAgentTitle: 'Multi-agente',
  heroFeatureMultiAgentBody:
    'Claude Code, Codex, Aider, Cursor, Gemini — todos desde la misma ventana.',
  heroFeatureNotifsTitle: 'Notificaciones nativas',
  heroFeatureNotifsBody:
    'Push Windows + parpadeo de la barra de tareas cuando un agente requiere atención.',
  heroFeaturePtyTitle: 'ConPTY nativo',
  heroFeaturePtyBody:
    'Terminal Windows nativo vía node-pty — rendimiento y compatibilidad de shell.',
  shortcutNewSession: 'Nueva sesión',
  shortcutAddPane: 'Añadir panel',
  shortcutRetile: 'Re-organizar',
  shortcutPalette: 'Paleta',
  shortcutSettings: 'Ajustes',
  settingsTitle: 'Ajustes',
  settingsClose: 'Cerrar',
  tabAppearance: 'Apariencia',
  tabTerminal: 'Terminal',
  tabNotifications: 'Notificaciones',
  tabAgents: 'Agentes',
  tabUpdates: 'Actualizaciones',
  tabAdvanced: 'Avanzado',
  fieldLanguage: 'Idioma',
  fieldTheme: 'Tema',
  themeDark: 'Oscuro',
  themeLight: 'Claro (próximamente)',
  themeSystem: 'Sistema',
  fieldFont: 'Fuente',
  fieldFontSize: 'Tamaño de fuente',
  fieldCursorBlink: 'Cursor parpadeante',
  fieldShell: 'Shell por defecto',
  fieldNotifs: 'Notificaciones del sistema Windows',
  updateCheck: 'Comprobar ahora',
  updateInstall: 'Instalar y reiniciar',
  bannerAvailable: 'Actualización disponible',
  bannerDownloadBtn: 'Descargar',
  bannerInstallBtn: 'Instalar y reiniciar',
  bannerLater: 'Más tarde',
  sidebarTitle: 'Sesiones',
  sidebarFilter: 'Filtrar…',
  errInstallNoDownload:
    'Descarga no completada — vuelve a descargar o instala manualmente.',
  errNoInstallerUrl: 'URL del instalador no encontrada en la última versión.',
  errGithubApiFailed: 'Llamada a la API de GitHub fallida. Comprueba tu conexión.',
  errNoResponse: 'Sin respuesta del servidor de actualizaciones. Comprueba tu conexión.',
  errDevMode: 'Disponible solo en la app instalada, no en modo dev.'
};

const ZH: Partial<Record<TKey, string>> = {
  appTagline: 'AI 多智能体编排器',
  heroTitleA: '多个 AI 智能体,',
  heroTitleB: '同一个窗口。',
  heroLead:
    'vMux 并行编排 Claude Code、Codex、Aider 等智能体——每个智能体都在自己的 git worktree 中。没有分支冲突,只有静默工作的智能体。',
  heroCta: '新建会话',
  heroCtaHint: '或按',
  heroFeatureSplitsTitle: 'Tmux 风格分屏',
  heroFeatureSplitsBody: '水平、垂直或 2D 网格自动平铺——一个快捷键。',
  heroFeaturePreviewTitle: 'Localhost 预览',
  heroFeaturePreviewBody: '检测到 URL → 窗口内嵌预览,不打断工作流。',
  heroFeatureWorktreesTitle: 'Git worktrees',
  heroFeatureWorktreesBody: '每个智能体独立的 worktree——隔离分支,零冲突。',
  heroFeatureMultiAgentTitle: '多智能体',
  heroFeatureMultiAgentBody:
    'Claude Code、Codex、Aider、Cursor、Gemini——同一窗口管理。',
  heroFeatureNotifsTitle: '原生通知',
  heroFeatureNotifsBody: '后台时 Windows 推送 + 任务栏闪烁。',
  heroFeaturePtyTitle: '原生 ConPTY',
  heroFeaturePtyBody: '通过 node-pty 的原生 Windows 终端——性能和兼容性。',
  shortcutNewSession: '新建会话',
  shortcutAddPane: '添加面板',
  shortcutRetile: '重新平铺',
  shortcutPalette: '命令面板',
  shortcutSettings: '设置',
  settingsTitle: '设置',
  settingsClose: '关闭',
  tabAppearance: '外观',
  tabTerminal: '终端',
  tabNotifications: '通知',
  tabAgents: '智能体',
  tabUpdates: '更新',
  tabAdvanced: '高级',
  fieldLanguage: '语言',
  fieldTheme: '主题',
  themeDark: '暗色',
  themeLight: '亮色(即将推出)',
  themeSystem: '系统',
  fieldFont: '字体',
  fieldFontSize: '字体大小',
  fieldNotifs: 'Windows 系统通知',
  updateCheck: '立即检查',
  updateInstall: '安装并重启',
  bannerAvailable: '有可用更新',
  bannerDownloadBtn: '下载',
  bannerInstallBtn: '安装并重启',
  bannerLater: '稍后',
  sidebarTitle: '会话',
  sidebarFilter: '筛选…',
  errInstallNoDownload: '下载未完成 — 请重新下载或手动安装。',
  errNoInstallerUrl: '在最新版本中未找到安装程序 URL。',
  errGithubApiFailed: 'GitHub API 调用失败。请检查网络连接。',
  errNoResponse: '更新服务器无响应。请检查网络连接。',
  errDevMode: '仅在已安装的应用中可用,开发模式下不可用。'
};

const JA: Partial<Record<TKey, string>> = {
  appTagline: 'AIマルチエージェント・オーケストレーター',
  heroTitleA: '複数のAIエージェントを、',
  heroTitleB: '一つのウィンドウで。',
  heroLead:
    'vMuxはClaude Code、Codex、Aiderなどを並列にオーケストレーション — 各エージェントは独自のgit worktree内で動作。ブランチ衝突なし、静かに働くエージェントだけ。',
  heroCta: '新しいセッション',
  heroCtaHint: 'または',
  heroFeatureSplitsTitle: 'tmux風スプリット',
  heroFeatureSplitsBody:
    '水平・垂直・2Dグリッド自動タイル — ショートカット一つ。',
  heroFeaturePreviewTitle: 'Localhostプレビュー',
  heroFeaturePreviewBody:
    'URL検出 → ウィンドウ内に組み込みプレビュー、フローを中断しない。',
  heroFeatureWorktreesTitle: 'Git worktrees',
  heroFeatureWorktreesBody:
    '各エージェントは独自のworktree — 分離ブランチ、衝突ゼロ。',
  heroFeatureMultiAgentTitle: 'マルチエージェント',
  heroFeatureMultiAgentBody:
    'Claude Code、Codex、Aider、Cursor、Gemini — 同じウィンドウから管理。',
  heroFeatureNotifsTitle: 'ネイティブ通知',
  heroFeatureNotifsBody:
    'バックグラウンド時にWindowsプッシュ通知+タスクバー点滅。',
  heroFeaturePtyTitle: 'ネイティブConPTY',
  heroFeaturePtyBody:
    'node-pty経由のネイティブWindowsターミナル — 性能とシェル互換性。',
  shortcutNewSession: '新しいセッション',
  shortcutAddPane: 'ペインを追加',
  shortcutRetile: '再配置',
  shortcutPalette: 'パレット',
  shortcutSettings: '設定',
  settingsTitle: '設定',
  settingsClose: '閉じる',
  tabAppearance: '外観',
  tabTerminal: 'ターミナル',
  tabNotifications: '通知',
  tabAgents: 'エージェント',
  tabUpdates: '更新',
  tabAdvanced: '詳細',
  fieldLanguage: '言語',
  fieldTheme: 'テーマ',
  themeDark: 'ダーク',
  themeLight: 'ライト(近日)',
  themeSystem: 'システム',
  fieldFont: 'フォント',
  fieldFontSize: 'フォントサイズ',
  fieldNotifs: 'Windowsシステム通知',
  updateCheck: '今すぐ確認',
  updateInstall: 'インストールして再起動',
  bannerAvailable: '更新があります',
  bannerDownloadBtn: 'ダウンロード',
  bannerInstallBtn: 'インストールして再起動',
  bannerLater: '後で',
  sidebarTitle: 'セッション',
  sidebarFilter: 'フィルタ…',
  errInstallNoDownload:
    'ダウンロードが完了していません — 再ダウンロードするか手動でインストールしてください。',
  errNoInstallerUrl: '最新リリースにインストーラーURLが見つかりません。',
  errGithubApiFailed: 'GitHub API 呼び出しに失敗しました。接続を確認してください。',
  errNoResponse: '更新サーバーから応答がありません。インターネット接続を確認してください。',
  errDevMode: 'インストールされたアプリでのみ利用可能、開発モードでは不可。'
};

const TR: Partial<Record<TKey, string>> = {
  appTagline: 'AI çoklu-ajan orkestratörü',
  heroTitleA: 'Birden çok AI ajanı,',
  heroTitleB: 'tek pencere.',
  heroLead:
    "vMux, Claude Code, Codex, Aider ve daha fazlasını paralel olarak yönetir — her biri kendi git worktree'sinde. Branş çakışması yok, sadece sessizce çalışan ajanlar.",
  heroCta: 'Yeni oturum',
  heroCtaHint: 'veya',
  heroFeatureSplitsTitle: 'Tmux benzeri bölmeler',
  heroFeatureSplitsBody:
    'Yatay, dikey ya da 2D ızgara halinde otomatik döşeme — tek kısayol.',
  heroFeaturePreviewTitle: 'Localhost önizleme',
  heroFeaturePreviewBody:
    'URL algılandı → pencere içinde gömülü önizleme, akışı bozmadan.',
  heroFeatureWorktreesTitle: 'Git worktree',
  heroFeatureWorktreesBody:
    "Her ajan kendi worktree'sinde — izole branşlar, sıfır çakışma.",
  heroFeatureMultiAgentTitle: 'Çoklu ajan',
  heroFeatureMultiAgentBody:
    'Claude Code, Codex, Aider, Cursor, Gemini — hepsi aynı pencereden.',
  heroFeatureNotifsTitle: 'Yerel bildirimler',
  heroFeatureNotifsBody:
    'Arka planda ajan ilgi istediğinde Windows push + görev çubuğu yanıp sönmesi.',
  heroFeaturePtyTitle: 'Yerel ConPTY',
  heroFeaturePtyBody:
    'node-pty ile yerel Windows terminali — performans ve shell uyumluluğu.',
  shortcutNewSession: 'Yeni oturum',
  shortcutAddPane: 'Bölme ekle',
  shortcutRetile: 'Yeniden döşe',
  shortcutPalette: 'Komut paleti',
  shortcutSettings: 'Ayarlar',
  settingsTitle: 'Ayarlar',
  settingsClose: 'Kapat',
  tabAppearance: 'Görünüm',
  tabTerminal: 'Terminal',
  tabNotifications: 'Bildirimler',
  tabAgents: 'Ajanlar',
  tabUpdates: 'Güncellemeler',
  tabAdvanced: 'Gelişmiş',
  fieldLanguage: 'Dil',
  fieldTheme: 'Tema',
  themeDark: 'Koyu',
  themeLight: 'Açık (yakında)',
  themeSystem: 'Sistem',
  fieldFont: 'Yazı tipi',
  fieldFontSize: 'Yazı tipi boyutu',
  fieldNotifs: 'Windows sistem bildirimleri',
  updateCheck: 'Şimdi kontrol et',
  updateInstall: 'Yükle ve yeniden başlat',
  bannerAvailable: 'Güncelleme mevcut',
  bannerDownloadBtn: 'İndir',
  bannerInstallBtn: 'Yükle ve yeniden başlat',
  bannerLater: 'Daha sonra',
  sidebarTitle: 'Oturumlar',
  sidebarFilter: 'Filtrele…',
  errInstallNoDownload:
    'İndirme tamamlanmadı — yeniden indir veya manuel olarak yükle.',
  errNoInstallerUrl: 'En son sürümde yükleyici URL bulunamadı.',
  errGithubApiFailed: 'GitHub API çağrısı başarısız. Bağlantını kontrol et.',
  errNoResponse: 'Güncelleme sunucusundan yanıt yok. İnternet bağlantını kontrol et.',
  errDevMode: 'Yalnızca yüklü uygulamada kullanılabilir, dev modunda değil.'
};

const CATALOG: Record<Lang, Partial<Record<TKey, string>>> = {
  en: EN,
  fr: FR,
  de: DE,
  es: ES,
  zh: ZH,
  ja: JA,
  tr: TR
};

export const LANG_LABELS: Record<Lang, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
  ja: '日本語',
  tr: 'Türkçe'
};

/** Renvoie la traduction d'une clé dans la langue donnée, fallback EN.
 *  Supporte une simple substitution `{var}` via `vars`. */
export function translate(
  lang: Lang,
  key: TKey,
  vars?: Record<string, string | number>
): string {
  const fromLang = CATALOG[lang]?.[key];
  const raw = (fromLang ?? EN[key]) as string;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

/** Hook : renvoie une fonction `t(key, vars?)` qui se met à jour automatiquement
 *  quand la langue change dans le store. */
export function useT(): (key: TKey, vars?: Record<string, string | number>) => string {
  const lang = useSessionStore((s) => s.settings?.language ?? 'en');
  return (key, vars) => translate(lang as Lang, key, vars);
}
