// Catalogue des textes de notifications natives Windows envoyées depuis le main.
// Séparé de `renderer/i18n` pour ne pas importer React/store dans le main process.
// Source de vérité pour les titres d'événements et les messages d'attention.

import type { DetectedEventKind, Lang } from './types';

export interface NotifBundle {
  /** Titre de la notif système pour chaque type d'event détecté. */
  eventTitle: Readonly<Record<DetectedEventKind, string>>;
  /** Corps de la notif quand l'agent demande une action. `{agent}` est remplacé. */
  attentionWithAgent: string;
  /** Corps fallback quand on ne connaît pas l'agent. */
  attentionGeneric: string;
  /** Préfixe titre attention (ex: "vMux — Session") — la session est concaténée. */
  attentionTitlePrefix: string;
  /** Titres de dialogues système. */
  dialogPickDirectory: string;
  dialogPickRepo: string;
  dialogPickSound: string;
  dialogExportDiagnostic: string;
}

const EN: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 Server ready',
    'build-success': '✓ Build successful',
    'build-error': '✗ Build failed',
    'test-results': '🧪 Tests finished',
    'agent-done': '✓ Agent done',
    notify: '🔔 Notification'
  },
  attentionWithAgent: '{agent} needs an action',
  attentionGeneric: 'Agent needs an action',
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: 'Pick a folder',
  dialogPickRepo: 'Pick a Git repository',
  dialogPickSound: 'Pick a sound file',
  dialogExportDiagnostic: 'Export vMux diagnostic'
};

const FR: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 Serveur prêt',
    'build-success': '✓ Build réussi',
    'build-error': '✗ Build en erreur',
    'test-results': '🧪 Tests terminés',
    'agent-done': '✓ Agent terminé',
    notify: '🔔 Notification'
  },
  attentionWithAgent: '{agent} demande une action',
  attentionGeneric: "L'agent demande une action",
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: 'Choisir un dossier',
  dialogPickRepo: 'Choisir un dépôt Git',
  dialogPickSound: 'Choisir un fichier son',
  dialogExportDiagnostic: 'Exporter le diagnostic vMux'
};

const DE: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 Server bereit',
    'build-success': '✓ Build erfolgreich',
    'build-error': '✗ Build fehlgeschlagen',
    'test-results': '🧪 Tests abgeschlossen',
    'agent-done': '✓ Agent fertig',
    notify: '🔔 Benachrichtigung'
  },
  attentionWithAgent: '{agent} benötigt eine Aktion',
  attentionGeneric: 'Der Agent benötigt eine Aktion',
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: 'Ordner auswählen',
  dialogPickRepo: 'Git-Repository auswählen',
  dialogPickSound: 'Sounddatei auswählen',
  dialogExportDiagnostic: 'vMux-Diagnose exportieren'
};

const ES: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 Servidor listo',
    'build-success': '✓ Build correcto',
    'build-error': '✗ Build con errores',
    'test-results': '🧪 Tests finalizados',
    'agent-done': '✓ Agente completado',
    notify: '🔔 Notificación'
  },
  attentionWithAgent: '{agent} necesita una acción',
  attentionGeneric: 'El agente necesita una acción',
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: 'Elegir una carpeta',
  dialogPickRepo: 'Elegir un repositorio Git',
  dialogPickSound: 'Elegir un archivo de sonido',
  dialogExportDiagnostic: 'Exportar diagnóstico de vMux'
};

const ZH: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 服务器就绪',
    'build-success': '✓ 构建成功',
    'build-error': '✗ 构建失败',
    'test-results': '🧪 测试完成',
    'agent-done': '✓ 代理完成',
    notify: '🔔 通知'
  },
  attentionWithAgent: '{agent} 需要操作',
  attentionGeneric: '代理需要操作',
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: '选择文件夹',
  dialogPickRepo: '选择 Git 仓库',
  dialogPickSound: '选择声音文件',
  dialogExportDiagnostic: '导出 vMux 诊断'
};

const JA: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 サーバー準備完了',
    'build-success': '✓ ビルド成功',
    'build-error': '✗ ビルド失敗',
    'test-results': '🧪 テスト完了',
    'agent-done': '✓ エージェント完了',
    notify: '🔔 通知'
  },
  attentionWithAgent: '{agent} がアクションを要求しています',
  attentionGeneric: 'エージェントがアクションを要求しています',
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: 'フォルダーを選択',
  dialogPickRepo: 'Git リポジトリを選択',
  dialogPickSound: 'サウンドファイルを選択',
  dialogExportDiagnostic: 'vMux 診断をエクスポート'
};

const TR: NotifBundle = {
  eventTitle: {
    'server-ready': '🚀 Sunucu hazır',
    'build-success': '✓ Derleme başarılı',
    'build-error': '✗ Derleme başarısız',
    'test-results': '🧪 Testler tamamlandı',
    'agent-done': '✓ Ajan tamamlandı',
    notify: '🔔 Bildirim'
  },
  attentionWithAgent: '{agent} bir eylem istiyor',
  attentionGeneric: 'Ajan bir eylem istiyor',
  attentionTitlePrefix: 'vMux',
  dialogPickDirectory: 'Bir klasör seç',
  dialogPickRepo: 'Bir Git deposu seç',
  dialogPickSound: 'Bir ses dosyası seç',
  dialogExportDiagnostic: 'vMux tanılamasını dışa aktar'
};

const BUNDLES: Record<Lang, NotifBundle> = {
  en: EN,
  fr: FR,
  de: DE,
  es: ES,
  zh: ZH,
  ja: JA,
  tr: TR
};

export function notifBundle(lang: Lang): NotifBundle {
  return BUNDLES[lang] ?? EN;
}

export function attentionBody(lang: Lang, agent?: string): string {
  const b = notifBundle(lang);
  if (!agent) return b.attentionGeneric;
  return b.attentionWithAgent.replace('{agent}', agent);
}
