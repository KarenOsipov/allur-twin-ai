import { clsx } from "clsx";
import type { ReactNode } from "react";

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-full bg-sunken p-1">
      {options.map((o) => (
        <button
          type="button"
          key={String(o.value)}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-8 rounded-full px-3.5 text-[0.8125rem] font-semibold transition-[background,color,box-shadow] duration-200",
            value === o.value ? "bg-panel text-ink shadow-[0_2px_8px_-2px_rgb(19_24_38/0.18)]" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
