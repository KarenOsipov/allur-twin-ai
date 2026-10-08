import type { AreaState, EqStatus } from "@/shared/api/types";

const nf = new Intl.NumberFormat("ru-RU");
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const num = (v: number | null | undefined) => (v == null ? "—" : nf.format(Math.round(v)));
export const num1 = (v: number | null | undefined) => (v == null ? "—" : nf1.format(v));
export const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v)}%`;

export function kzt(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `${nf1.format(v / 1_000_000_000)} млрд ₸`;
  if (a >= 1_000_000) return `${nf1.format(v / 1_000_000)} млн ₸`;
  if (a >= 10_000) return `${nf.format(Math.round(v / 1000))} тыс ₸`;
  return `${nf.format(Math.round(v))} ₸`;
}

const parse = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00` : s);

export const dayLabel = (s: string) => parse(s).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
export const dayLong = (s: string) => parse(s).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
export const time = (s: string | null | undefined) =>
  s ? parse(s).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";
export const dateTime = (s: string) =>
  `${parse(s).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${time(s)}`;

export const minutesBetween = (a: string, b: string) => Math.max(0, Math.round((parse(b).getTime() - parse(a).getTime()) / 60000));

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const AREA_STATE: Record<AreaState, string> = {
  run: "Работает",
  starved: "Ждёт кузов",
  blocked: "Буфер полон",
  down: "Стоит",
  off: "Не работает",
};

export const EQ_STATUS: Record<EqStatus, string> = {
  run: "Работает",
  idle: "Ожидает",
  down: "Отказ",
  maint: "Обслуживание",
  off: "Выключено",
};

export const STATE_COLOR: Record<string, string> = {
  run: "var(--color-run)",
  idle: "var(--color-wait)",
  starved: "var(--color-wait)",
  blocked: "var(--color-blocked)",
  down: "var(--color-down)",
  maint: "var(--color-maint)",
  off: "var(--color-line-strong)",
};

export const SEVERITY_LABEL = { critical: "Авария", warning: "Отклонение", info: "Информация" } as const;
