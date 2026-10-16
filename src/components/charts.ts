import { QuotaLevel } from "../quota/format";

/** Colors for generated images, which can't use Raycast's dynamic theme colors. */
export interface ChartPalette {
  text: string;
  muted: string;
  track: string;
  neutral: string;
  levels: Record<QuotaLevel, string>;
}

export const CHART_PALETTES: Record<"light" | "dark", ChartPalette> = {
  dark: {
    text: "#F4F4F5",
    muted: "#A1A1AA",
    track: "rgba(255,255,255,0.10)",
    neutral: "#71717A",
    levels: { ok: "#4ADE80", low: "#FACC15", critical: "#FB923C", exhausted: "#F87171" },
  },
  light: {
    text: "#18181B",
    muted: "#71717A",
    track: "rgba(0,0,0,0.08)",
    neutral: "#A1A1AA",
    levels: { ok: "#16A34A", low: "#CA8A04", critical: "#EA580C", exhausted: "#DC2626" },
  },
};

const FONT = "'Segoe UI Variable Text','Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif";

export interface HeroOptions {
  /** Remaining quota, 0–100. */
  remaining: number;
  remainingLabel: string;
  level: QuotaLevel;
  usedLabel: string;
  /** Share of the window's time that has passed, 0–1, when duration and reset are known. */
  elapsed?: number;
  elapsedLabel?: string;
  footer?: string;
  palette: ChartPalette;
}

/** A ring showing remaining quota beside bars comparing usage with elapsed window time. */
export function quotaHeroSvg(options: HeroOptions): string {
  const { palette } = options;
  const color = palette.levels[options.level];
  const width = 520;
  const height = 168;
  const ring = ringPath(84, 84, 62, options.remaining / 100);
  const bars = [
    { label: "Used", value: options.usedLabel, fraction: 1 - options.remaining / 100, color },
    ...(options.elapsed !== undefined && options.elapsedLabel
      ? [{ label: "Window elapsed", value: options.elapsedLabel, fraction: options.elapsed, color: palette.neutral }]
      : []),
  ];
  const barX = 192;
  const barWidth = width - barX - 8;

  // An empty ring would read as neutral, so a used-up window tints its track with the status color.
  const ringTrack = options.remaining <= 0 ? `stroke="${color}" stroke-opacity="0.3"` : `stroke="${palette.track}"`;

  return svg(width, height, [
    `<circle cx="84" cy="84" r="62" fill="none" ${ringTrack} stroke-width="14"/>`,
    ring && `<path d="${ring}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>`,
    text(84, 90, options.remainingLabel, { size: 30, weight: 650, fill: palette.text, anchor: "middle" }),
    text(84, 112, "left", { size: 13, fill: palette.muted, anchor: "middle" }),
    ...bars.flatMap((bar, index) => {
      const y = 34 + index * 52;
      return [
        text(barX, y, bar.label, { size: 13, fill: palette.muted }),
        text(barX + barWidth, y, bar.value, { size: 13, weight: 600, fill: palette.text, anchor: "end" }),
        `<rect x="${barX}" y="${y + 10}" width="${barWidth}" height="10" rx="5" fill="${palette.track}"/>`,
        bar.fraction > 0
          ? `<rect x="${barX}" y="${y + 10}" width="${Math.max(10, barWidth * clamp01(bar.fraction))}" height="10" rx="5" fill="${bar.color}"/>`
          : "",
      ];
    }),
    // "Now" tick on the Used bar: usage left of it is slower than time, right of it is faster.
    options.elapsed !== undefined &&
      `<rect class="now" x="${(barX + barWidth * clamp01(options.elapsed) - 1).toFixed(1)}" y="40" width="2" height="18" rx="1" fill="${palette.text}"/>`,
    options.footer && text(barX, 34 + bars.length * 52 + 4, options.footer, { size: 13, fill: palette.muted }),
  ]);
}

export function svgDataUri(markup: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(markup, "utf8").toString("base64")}`;
}

function svg(width: number, height: number, children: (string | undefined | false)[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">${children.filter(Boolean).join("")}</svg>`;
}

function text(
  x: number,
  y: number,
  content: string,
  style: { size: number; fill: string; weight?: number; anchor?: "start" | "middle" | "end" },
): string {
  return `<text x="${x}" y="${y}" font-size="${style.size}" font-weight="${style.weight ?? 400}" fill="${style.fill}" text-anchor="${style.anchor ?? "start"}">${escapeXml(content)}</text>`;
}

/** Arc from 12 o'clock clockwise; a full circle when complete, nothing when empty. */
function ringPath(cx: number, cy: number, r: number, fraction: number): string | undefined {
  const value = clamp01(fraction);
  if (value <= 0) {
    return undefined;
  }
  if (value >= 1) {
    return `M ${cx} ${cy - r} a ${r} ${r} 0 1 1 0 ${2 * r} a ${r} ${r} 0 1 1 0 ${-2 * r}`;
  }
  const angle = value * 2 * Math.PI;
  const x = cx + r * Math.sin(angle);
  const y = cy - r * Math.cos(angle);
  return `M ${cx} ${cy - r} A ${r} ${r} 0 ${value > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
