import { toCanvas } from "html-to-image";
import { ALLUR_PATH } from "@/shared/ui/Logo";

export interface ExportMeta {
  title: string;
  subtitle?: string;
  meta: [string, string][];
  to?: string;
  note?: string;
  mode?: string;
}

const PAGE_W = 2339;
const PAGE_H = 1654;
const M = 70;
const BRAND = "#e3241b";
const INK = "#1d1515";
const MUTED = "#7d6e6c";
const PAPER = "#f4eeed";

async function capture(node: HTMLElement): Promise<HTMLCanvasElement> {
  await document.fonts.ready;
  return toCanvas(node, {
    pixelRatio: 2,
    backgroundColor: PAPER,
    cacheBust: false,
    filter: (el) => !(el instanceof HTMLElement && el.dataset.exportSkip !== undefined),
  });
}

function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, color = BRAND) {
  const k = h / 111.1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(ALLUR_PATH), "evenodd");
  ctx.restore();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

const DISPLAY = '"Outfit Variable", system-ui, sans-serif';
const SANS = '"Manrope Variable", system-ui, sans-serif';

function header(ctx: CanvasRenderingContext2D, m: ExportMeta, first: boolean): number {
  drawLogo(ctx, M, M, first ? 58 : 40);
  ctx.textBaseline = "alphabetic";
  if (!first) {
    ctx.fillStyle = INK;
    ctx.font = `500 30px ${DISPLAY}`;
    ctx.fillText(m.title, M + 160, M + 32);
    ctx.fillStyle = MUTED;
    ctx.font = `500 22px ${SANS}`;
    ctx.textAlign = "right";
    ctx.fillText(m.meta.map(([, v]) => v).slice(0, 1).join(""), PAGE_W - M, M + 32);
    ctx.textAlign = "left";
    ctx.fillStyle = "#eadfdd";
    ctx.fillRect(M, M + 62, PAGE_W - 2 * M, 2);
    return M + 84;
  }
  ctx.fillStyle = MUTED;
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText("ЦИФРОВОЙ ДВОЙНИК ЗАВОДА · ОТЧЁТ", M + 210, M + 22);
  ctx.fillStyle = INK;
  ctx.font = `300 54px ${DISPLAY}`;
  ctx.fillText(m.title, M + 210, M + 80);
  ctx.textAlign = "right";
  let y = M + 18;
  for (const [k, v] of m.meta) {
    ctx.font = `600 21px ${SANS}`;
    ctx.fillStyle = INK;
    ctx.fillText(v, PAGE_W - M, y);
    const vw = ctx.measureText(v).width;
    ctx.font = `500 21px ${SANS}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`${k}:`, PAGE_W - M - vw - 8, y);
    y += 30;
  }
  ctx.textAlign = "left";
  let bottom = Math.max(M + 110, y);
  if (m.mode) {
    ctx.font = `700 21px ${SANS}`;
    const w = ctx.measureText(m.mode).width + 40;
    ctx.fillStyle = INK;
    roundRect(ctx, M, bottom + 4, w, 40, 20);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(m.mode, M + 20, bottom + 31);
    bottom += 56;
  }
  if (m.to || m.note) {
    ctx.font = `500 24px ${SANS}`;
    const text = [m.to ? `Кому: ${m.to}.` : "", m.note ?? ""].filter(Boolean).join(" ");
    const lines = wrap(ctx, text, PAGE_W - 2 * M - 60);
    const h = 34 + lines.length * 34;
    ctx.fillStyle = "#ffe9e6";
    roundRect(ctx, M, bottom + 8, PAGE_W - 2 * M, h, 18);
    ctx.fill();
    ctx.fillStyle = BRAND;
    ctx.fillRect(M, bottom + 8, 8, h);
    ctx.fillStyle = INK;
    lines.forEach((ln, i) => ctx.fillText(ln, M + 34, bottom + 48 + i * 34));
    bottom += h + 16;
  }
  ctx.fillStyle = "#eadfdd";
  ctx.fillRect(M, bottom + 14, PAGE_W - 2 * M, 2);
  return bottom + 34;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export async function exportPng(node: HTMLElement, m: ExportMeta, filename: string): Promise<void> {
  const shot = await capture(node);
  const head = document.createElement("canvas");
  const probe = head.getContext("2d") as CanvasRenderingContext2D;
  head.width = PAGE_W;
  head.height = PAGE_H;
  const hh = header(probe, m, true);
  const k = (PAGE_W - 2 * M) / shot.width;
  const out = document.createElement("canvas");
  out.width = PAGE_W;
  out.height = Math.round(hh + shot.height * k + 70);
  const ctx = out.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  header(ctx, m, true);
  ctx.drawImage(shot, M, hh, PAGE_W - 2 * M, shot.height * k);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  if (!blob) throw new Error("Не удалось собрать картинку");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
