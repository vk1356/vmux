import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { useSessionStore, STATS_WINDOW, type PaneStatsHistory } from '../store/sessions';

/** Float32Array vide partagé pour les renders sans data — évite une alloc par render. */
const EMPTY_F32 = new Float32Array(0);

/** Intl.NumberFormat singletons — instancier un formatter coûte ~0.1ms, ce qui
 *  est négligeable mais multiplié par 10 panes × 0.5Hz redraw = 50 allocs/s
 *  qu'on évite. Plus important : `toFixed`+concat alloue 2-3 strings ; format()
 *  réutilise un pool interne. */
const CPU_FMT_LOW = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const CPU_FMT_HIGH = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0
});
const MEM_FMT_DEC = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const MEM_FMT_INT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0
});

/** Intervalle minimum entre deux redraws de canvas. Les samples arrivent à 0.5Hz
 *  (toutes les 2s) côté main mais d'autres triggers re-render le composant
 *  (cpuColor recalc, parent re-render) ; on plafonne à un redraw / 500ms pour
 *  garantir un rendu fluide même sous spam. */
const REDRAW_THROTTLE_MS = 500;

/** Floor d'auto-scale RAM : 128 MB. Sous ce seuil, on étire jusqu'à 128 pour
 *  ne pas amplifier le bruit d'un process qui tourne à 5 MB. */
const RAM_FLOOR_BYTES = 128 * 1024 * 1024;

/** Plancher d'auto-scale CPU : 30%. Si le pane reste à 2-3% pendant la fenêtre,
 *  pas la peine d'amplifier — on garde une référence à 30% pour que la sparkline
 *  soit lisible "ah, idle". */
const CPU_FLOOR_PCT = 30;

interface Props {
  paneId: string;
  /** Format compact (header de pane) vs étendu (status bar). */
  compact?: boolean;
}

/** prefers-reduced-motion : on lit une fois et on freeze. Cohérent avec le CSS
 *  global ; évite de redessiner la sparkline à chaque update sur les machines
 *  qui ont demandé reduced-motion. */
const PREFERS_REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/**
 * Mini-monitor CPU% + RAM avec sparkline canvas.
 * Le canvas est dessiné côté renderer à partir du buffer dans le store ;
 * le main ne fait que pousser des samples toutes les 2s (cf. pty-stats.ts).
 *
 * Affichage CPU : normalisé en `% machine` (cpu/cores). Sur 8 cœurs, un agent
 * qui prend tout 1 cœur affiche 12.5% (et non 100% comme avant). Le tooltip
 * conserve la valeur brute + le multiplicateur de cœur.
 *
 * Affichage RAM : auto-scale dynamique (max observé sur la fenêtre, floor 128MB).
 * Une ligne pointillée marque "10% de la RAM système" si dispo.
 */
function PaneStatsImpl({ paneId, compact = false }: Props): JSX.Element | null {
  const stats = useSessionStore((s) => s.paneStats[paneId]);
  const systemMemoryTotal = useSessionStore((s) => s.systemStats?.memoryTotal ?? 0);
  const canvasCpuRef = useRef<HTMLCanvasElement>(null);
  const canvasMemRef = useRef<HTMLCanvasElement>(null);
  // Refs pour throttle du redraw : on coalesce les bursts (re-renders multiples
  // dans la même fenêtre 500ms) en un seul rAF/draw.
  const lastDrawAtRef = useRef(0);
  const pendingDrawRef = useRef<number | null>(null);
  // Cache de la dernière draw pour pouvoir re-jouer dans le timer.
  const [drawTick, setDrawTick] = useState(0);

  // Couleur CPU bucketée par tranches de 30/70 % — un seul recompute quand
  // la tranche change réellement. Dep ciblée sur `cpu` (number) au lieu de
  // `last` (objet ref) : évite des re-render à chaque push du stats sample.
  const lastCpu = stats?.last?.cpu;
  const cores = stats?.cores;
  const cpuColor = useMemo(() => {
    if (lastCpu === undefined) return '#f97316';
    const machinePct = cores && cores > 0 ? lastCpu / cores : lastCpu;
    if (machinePct < 30) return '#22c55e'; // success
    if (machinePct < 70) return '#f97316'; // accent
    return '#ef4444'; // error
  }, [lastCpu, cores]);

  useEffect(() => {
    const now = performance.now();
    const elapsed = now - lastDrawAtRef.current;
    if (elapsed >= REDRAW_THROTTLE_MS) {
      lastDrawAtRef.current = now;
      if (PREFERS_REDUCED_MOTION) {
        drawStaticDot(canvasCpuRef.current, stats?.cpu, cpuColor);
        drawStaticDot(canvasMemRef.current, stats?.memory, '#3b82f6');
      } else {
        drawSparkline(canvasCpuRef.current, stats?.cpu ?? EMPTY_F32, cpuColor, {
          min: 0,
          softMax: CPU_FLOOR_PCT * (stats?.cores ?? 1)
        });
        drawSparkline(canvasMemRef.current, stats?.memory ?? EMPTY_F32, '#3b82f6', {
          min: 0,
          softMax: RAM_FLOOR_BYTES,
          refLine: systemMemoryTotal > 0 ? systemMemoryTotal * 0.1 : undefined,
          refColor: 'rgba(244, 63, 94, 0.3)'
        });
      }
    } else if (pendingDrawRef.current == null) {
      // Coalesce les bursts : un seul timer en flight, qui bump le tick pour
      // re-jouer l'effect avec les valeurs à jour (pas de stale closure).
      pendingDrawRef.current = window.setTimeout(() => {
        pendingDrawRef.current = null;
        setDrawTick((t) => t + 1);
      }, REDRAW_THROTTLE_MS - elapsed);
    }
    // PAS de cleanup ici : ça invaliderait le timer entre deux re-renders
    // rapprochés et l'on ne dessinerait jamais. L'unmount cleanup est géré
    // par l'effect dédié ci-dessous.
  }, [stats?.cpu, stats?.memory, stats?.cores, cpuColor, systemMemoryTotal, drawTick]);

  // Cleanup au unmount uniquement — vide le timer pendant pour ne pas
  // setState sur composant démonté (React warning).
  useEffect(() => {
    return () => {
      if (pendingDrawRef.current != null) {
        clearTimeout(pendingDrawRef.current);
        pendingDrawRef.current = null;
      }
    };
  }, []);

  if (!stats || !stats.last) {
    return compact ? null : (
      <span className="pane-stats-empty" aria-hidden>
        <Cpu size={11} /> —
      </span>
    );
  }

  // CPU : pas encore primé (1er sample) → affiche calculating.
  if (!stats.primed) {
    return (
      <span className={`pane-stats ${compact ? 'compact' : ''}`} title="Mesure en cours…">
        <span className="pane-stats-row">
          <Cpu size={11} className="pane-stats-icon cpu calculating" />
          <span className="pane-stats-value pane-stats-calc">…</span>
        </span>
      </span>
    );
  }

  const machineCpuPct = stats.cores > 0 ? stats.last.cpu / stats.cores : stats.last.cpu;
  const memMb = stats.last.memory / (1024 * 1024);
  const W = compact ? 36 : 56;
  const H = compact ? 12 : 14;

  return (
    <span
      className={`pane-stats ${compact ? 'compact' : ''}`}
      title={statsTooltip(stats, systemMemoryTotal)}
    >
      <span className="pane-stats-row">
        <Cpu size={11} className="pane-stats-icon cpu" style={{ color: cpuColor }} />
        <span className="pane-stats-value">{formatCpu(machineCpuPct)}</span>
        <canvas ref={canvasCpuRef} width={W} height={H} className="pane-stats-canvas" />
      </span>
      <span className="pane-stats-row">
        <MemoryStick size={11} className="pane-stats-icon mem" />
        <span className="pane-stats-value">{formatMb(memMb)}</span>
        <canvas ref={canvasMemRef} width={W} height={H} className="pane-stats-canvas" />
      </span>
    </span>
  );
}

export const PaneStats = memo(PaneStatsImpl);

function formatCpu(pct: number): string {
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return `${CPU_FMT_LOW.format(pct)}%`;
  return `${CPU_FMT_HIGH.format(pct)}%`;
}

function formatMb(mb: number): string {
  if (mb < 100) return `${MEM_FMT_DEC.format(mb)}M`;
  if (mb < 1024) return `${MEM_FMT_INT.format(mb)}M`;
  return `${MEM_FMT_DEC.format(mb / 1024)}G`;
}

function statsTooltip(stats: PaneStatsHistory, sysMemTotal: number): string {
  if (!stats.last) return '';
  const rawCpu = stats.last.cpu;
  const cores = stats.cores || 1;
  const machinePct = rawCpu / cores;
  const coreMul = (rawCpu / 100).toFixed(1);
  const memMb = stats.last.memory / (1024 * 1024);
  const sysMemLine =
    sysMemTotal > 0
      ? ` (${((stats.last.memory / sysMemTotal) * 100).toFixed(1)}% système)`
      : '';
  // Durée de la fenêtre d'historique pour situer la sparkline.
  const windowSec = stats.cpu.length * 2;
  const windowLabel =
    windowSec >= 60 ? `${Math.round(windowSec / 60)}min` : `${windowSec}s`;
  return [
    `CPU ${machinePct.toFixed(1)}% machine · ${coreMul}× cores · raw ${rawCpu.toFixed(0)}%`,
    `RAM ${memMb.toFixed(0)} MB${sysMemLine}`,
    `Fenêtre : ${windowLabel}`
  ].join('\n');
}

interface DrawOpts {
  min: number;
  /** Plancher du max — si toutes les valeurs sont basses, on fixe l'échelle ici
   *  pour ne pas faire dans une sparkline qui amplifie le bruit. */
  softMax: number;
  /** Ligne horizontale de référence (en unité brute des valeurs). */
  refLine?: number;
  refColor?: string;
}

/** Dessine seulement la dernière valeur — pour reduced-motion. */
function drawStaticDot(
  canvas: HTMLCanvasElement | null,
  values: ArrayLike<number> | undefined,
  color: string
): void {
  if (!canvas || !values || values.length === 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  // clientWidth/Height : CSS pixels lus du DOM. Robuste au 1er render
  // (canvas.width est en pixels canvas, pas CSS — donc inadapté ici).
  const cssW = canvas.clientWidth || 36;
  const cssH = canvas.clientHeight || 12;
  resize(canvas, cssW, cssH, dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cssW - 2, cssH / 2, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function resize(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): void {
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
}

/** Dessine une sparkline + dernière valeur en point. Aucun lib externe — canvas raw.
 *  Accepte Float32Array OU number[] (le store nous passe Float32Array, mais on
 *  reste compatible pour les call-sites externes éventuels). */
function drawSparkline(
  canvas: HTMLCanvasElement | null,
  values: ArrayLike<number>,
  color: string,
  opts: DrawOpts
): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width / dpr || canvas.width;
  const cssH = canvas.clientHeight || canvas.height / dpr || canvas.height;
  resize(canvas, cssW, cssH, dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const len = values.length;
  if (len < 2) {
    if (len === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cssW - 2, cssH / 2, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  // Compute max manuellement — Math.max(...values) sur un gros array spread
  // peut throw "too many arguments" et est plus lent qu'une boucle.
  let max = opts.softMax;
  for (let i = 0; i < len; i++) {
    const v = values[i];
    if (v > max) max = v;
  }
  // Padding de 20% au sommet pour ne pas coller la valeur max au bord.
  max = max * 1.2;
  const range = Math.max(1, max - opts.min);
  const stepX = cssW / (STATS_WINDOW - 1);
  const startX = cssW - (len - 1) * stepX;

  // Ligne de référence (avant la sparkline pour qu'elle soit en dessous).
  if (opts.refLine !== undefined && opts.refLine > opts.min && opts.refLine < max) {
    const refY = cssH - ((opts.refLine - opts.min) / range) * (cssH - 2) - 1;
    ctx.strokeStyle = opts.refColor ?? 'rgba(255,255,255,0.15)';
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, refY);
    ctx.lineTo(cssW, refY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Remplissage gradient subtil sous la courbe — donne du volume sans alourdir.
  ctx.fillStyle = color + '22'; // alpha ~13%
  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = startX + i * stepX;
    const y = cssH - ((values[i] - opts.min) / range) * (cssH - 2) - 1;
    if (i === 0) ctx.moveTo(x, cssH);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(startX + (len - 1) * stepX, cssH);
  ctx.closePath();
  ctx.fill();

  // Trait principal.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = startX + i * stepX;
    const y = cssH - ((values[i] - opts.min) / range) * (cssH - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Point sur la dernière valeur.
  const lastV = values[len - 1];
  const lastY = cssH - ((lastV - opts.min) / range) * (cssH - 2) - 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cssW - 1, lastY, 1.5, 0, Math.PI * 2);
  ctx.fill();
}
