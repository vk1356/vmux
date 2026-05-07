import { memo, useEffect, useRef, type JSX } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { useSessionStore, STATS_WINDOW } from '../store/sessions';

/** Float32Array vide partagé pour les renders sans data — évite une alloc par render. */
const EMPTY_F32 = new Float32Array(0);

interface Props {
  paneId: string;
  /** Format compact (header de pane) vs étendu (status bar). */
  compact?: boolean;
}

/**
 * Mini-monitor CPU% + RAM avec sparkline canvas.
 * Le canvas est dessiné côté renderer à partir du buffer dans le store ;
 * le main ne fait que pousser des samples toutes les 2s (cf. pty-stats.ts).
 */
function PaneStatsImpl({ paneId, compact = false }: Props): JSX.Element | null {
  const stats = useSessionStore((s) => s.paneStats[paneId]);
  const canvasCpuRef = useRef<HTMLCanvasElement>(null);
  const canvasMemRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    drawSparkline(canvasCpuRef.current, stats?.cpu ?? EMPTY_F32, '#f97316', { min: 0, softMax: 100 });
    drawSparkline(canvasMemRef.current, stats?.memory ?? EMPTY_F32, '#3b82f6', {
      min: 0,
      softMax: 256 * 1024 * 1024
    });
  }, [stats?.cpu, stats?.memory]);

  if (!stats || !stats.last) {
    // Aucune donnée encore — placeholder discret pour ne pas faire sauter le layout.
    return compact ? null : (
      <span className="pane-stats-empty" aria-hidden>
        <Cpu size={11} /> —
      </span>
    );
  }

  const cpuPct = clampDisplay(stats.last.cpu);
  const memMb = stats.last.memory / (1024 * 1024);
  const W = compact ? 36 : 56;
  const H = compact ? 12 : 14;

  return (
    <span className={`pane-stats ${compact ? 'compact' : ''}`} title={statsTooltip(stats.last)}>
      <span className="pane-stats-row">
        <Cpu size={11} className="pane-stats-icon cpu" />
        <span className="pane-stats-value">{formatCpu(cpuPct)}</span>
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

function clampDisplay(cpu: number): number {
  // pidusage renvoie 0..100*vcore ; on ramène à 100 pour l'affichage.
  return Math.max(0, Math.min(100, cpu));
}

function formatCpu(pct: number): string {
  if (pct < 1) return '<1%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function formatMb(mb: number): string {
  if (mb < 100) return `${mb.toFixed(1)}M`;
  if (mb < 1024) return `${Math.round(mb)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

function statsTooltip(last: { cpu: number; memory: number; timestamp: number }): string {
  const cpu = last.cpu.toFixed(1);
  const memMb = (last.memory / (1024 * 1024)).toFixed(0);
  return `CPU ${cpu}% · RAM ${memMb} MB`;
}

interface DrawOpts {
  min: number;
  /** Plancher du max — si toutes les valeurs sont basses, on fixe l'échelle ici
   *  pour ne pas faire dans une sparkline qui amplifie le bruit. */
  softMax: number;
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
  const cssW = canvas.width;
  const cssH = canvas.height;
  // Resize avec DPR pour rester net sur les écrans HiDPI.
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
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
  const range = Math.max(1, max - opts.min);
  const stepX = cssW / (STATS_WINDOW - 1);
  const startX = cssW - (len - 1) * stepX;

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
