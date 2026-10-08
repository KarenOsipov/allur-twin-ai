import { clsx } from "clsx";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "deep";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white shadow-[0_8px_20px_-10px_rgb(227_36_27/0.8)] hover:bg-brand-2 disabled:bg-line-strong disabled:shadow-none",
  deep: "bg-deep text-white hover:bg-deep-3",
  secondary: "border border-line-strong bg-panel text-ink hover:border-ink-3",
  ghost: "text-ink-2 hover:bg-sunken hover:text-ink",
  danger: "bg-down-soft text-down hover:bg-[#fbd5d5]",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-[background,color,border,transform,box-shadow] duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "h-8 px-3.5 text-[0.8125rem]" : "h-10 px-5 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={clsx("grid size-9 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:opacity-50", className)}
    >
      {children}
    </button>
  );
}
