import { clsx } from "clsx";
import { CheckCircle2, ChevronDown, Delete, Eye, EyeOff, KeyRound, LogIn, UserRound } from "lucide-react";
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { request } from "@/shared/api/client";
import { useStaff } from "@/shared/api/queries";
import type { LoginOut, Role, StaffMember } from "@/shared/api/types";
import { homeOf, session, useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/Button";
import { AllurLogo, Logo } from "@/shared/ui/Logo";
import { Sheet } from "@/shared/ui/Sheet";

type Mode = "pin" | "password";
const MODE_KEY = "allur.login.mode";

const AVATAR: Record<Role, string> = {
  director: "bg-deep text-white",
  admin: "bg-ink-2 text-white",
  supervisor: "bg-brand text-white",
  worker: "bg-sunken text-ink ring-1 ring-line-strong",
};

export const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "password" ? "password" : "pin";
  } catch {
    return "pin";
  }
}

export function LoginPage() {
  const current = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setModeState] = useState<Mode>(savedMode);
  const [fill, setFill] = useState<{ login: string; pin: string; n: number } | null>(null);
  const staff = useStaff();
  const [register, setRegister] = useState(false);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
    }
  };

  const from = (location.state as { from?: string } | null)?.from;
  if (current) {
    const home = homeOf(current);
    return <Navigate to={from && from.startsWith(home) ? from : home} replace />;
  }

  const done = (out: LoginOut) => {
    session.set({ token: out.token, expiresAt: out.expires_at, id: out.id, name: out.name, position: out.position, role: out.role, area: out.area });
    navigate(homeOf(session.get()), { replace: true });
  };

  const demo = (staff.data?.users ?? []).filter((u) => u.demo_pin);

  return (
    <div className="min-h-dvh p-3 sm:p-5">
      <div aria-hidden className="ambient" />
      <div className="mx-auto grid min-h-[calc(100dvh-1.5rem)] max-w-[1400px] gap-4 sm:min-h-[calc(100dvh-2.5rem)] lg:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
        <section
          className="panel-deep rise relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12"
          style={{
            backgroundImage:
              "radial-gradient(70% 60% at 100% 0%, rgb(255 51 36 / 0.34), transparent 70%), radial-gradient(60% 50% at 0% 100%, rgb(255 51 36 / 0.18), transparent 70%)",
          }}
        >
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80">
            <span className="size-1.5 rounded-full bg-run" /> Костанай · сборочный завод
          </span>
          <div className="flex flex-col items-start gap-5">
            <AllurLogo height={96} className="text-allur" />
            <span className="display text-[1.6rem] font-light tracking-[-0.01em] text-white/90">Цифровой двойник завода</span>
          </div>
          <div className="max-w-[34rem]">
            <p className="display text-[2rem] leading-tight font-light tracking-[-0.02em]">
              Рабочий сообщает о поломке с телефона — начальник смены за минуту видит, во что она обойдётся.
            </p>
            <ul className="mt-8 flex flex-wrap gap-2">
              {["Живая линия", "Сообщения с участков", "Анализ потерь за минуту", "Отчёты в фирменном стиле"].map((t) => (
                <li key={t} className="rounded-full border border-white/15 px-3.5 py-1.5 text-sm font-semibold text-white/90">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="panel rise flex justify-center px-5 py-8 sm:px-10 sm:py-10" style={{ "--i": 1 } as CSSProperties}>
          <div className="flex w-full max-w-[400px] flex-col lg:my-auto">
            <div className="mb-8 lg:hidden">
              <Logo />
            </div>
            <h1 className="text-[2.4rem] leading-tight font-light tracking-[-0.025em]">Вход</h1>
            <p className="mt-1 text-sm text-ink-3">{mode === "pin" ? "Введите свой PIN-код." : "Введите логин и пароль."}</p>

            <div role="tablist" aria-label="Способ входа" className="mt-6 grid grid-cols-2 rounded-full bg-sunken p-1">
              {(
                [
                  ["pin", "PIN-код", KeyRound],
                  ["password", "Логин и пароль", UserRound],
                ] as const
              ).map(([m, label, Icon]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx(
                    "flex h-10 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-[background,color,box-shadow] duration-200",
                    mode === m ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink",
                  )}
                >
                  <Icon className="size-4" aria-hidden /> {label}
                </button>
              ))}
            </div>

            <div className="mt-6" role="tabpanel">
              {mode === "pin" ? <PinForm key={`p${fill?.n ?? 0}`} initial={fill?.pin ?? ""} onDone={done} /> : <PasswordForm key={`l${fill?.n ?? 0}`} initialLogin={fill?.login ?? ""} initialPassword={fill?.pin ?? ""} onDone={done} />}
            </div>

            {staff.data?.registration !== false && (
              <p className="mt-5 text-center text-sm text-ink-3">
                Нет доступа?{" "}
                <button type="button" onClick={() => setRegister(true)} className="font-semibold text-accent underline-offset-4 hover:underline">
                  Подать заявку
                </button>
              </p>
            )}
            {staff.isError && <p className="mt-6 text-sm text-down">Сервер недоступен. Проверьте, что система запущена.</p>}
            {demo.length > 0 && <DemoAccounts users={demo} onPick={(u) => setFill({ login: u.login ?? "", pin: u.demo_pin ?? "", n: Date.now() })} />}
          </div>
        </section>
      </div>
      <Sheet open={register} onClose={() => setRegister(false)} title="Заявка на доступ">
        <RegisterForm
          areas={staff.data?.areas ?? []}
          onDone={(login) => {
            setRegister(false);
            setMode("password");
            setFill({ login, pin: "", n: Date.now() });
          }}
        />
      </Sheet>
    </div>
  );
}

const REQ_ROLES: { value: Role; label: string; text: string }[] = [
  { value: "worker", label: "Рабочий", text: "свой участок, сообщения о проблемах, чат" },
  { value: "supervisor", label: "Начальник смены", text: "смена, инциденты, анализ, управление линией" },
  { value: "director", label: "Руководитель", text: "все показатели, экономика, документы" },
];

function RegisterForm({ areas, onDone }: { areas: { code: string; name: string }[]; onDone: (login: string) => void }) {
  const [f, setF] = useState({ name: "", position: "", role: "worker" as Role, area: "PAINT", login: "", password: "", repeat: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setError(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.name.trim().split(/\s+/).length < 2) return setError("Укажите фамилию и имя");
    if (f.position.trim().length < 2) return setError("Укажите должность");
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/i.test(f.login.trim())) return setError("Логин — от 3 символов: латинские буквы, цифры, точка, дефис");
    if (/^\d+$/.test(f.password) ? f.password.length < 4 : f.password.length < 6) return setError("Пароль — от 6 символов (или PIN от 4 цифр)");
    if (f.password !== f.repeat) return setError("Пароли не совпадают");
    setBusy(true);
    try {
      await request("/auth/register", {
        method: "POST",
        body: { name: f.name.trim(), position: f.position.trim(), role: f.role, area: f.role === "worker" ? f.area : null, login: f.login.trim().toLowerCase(), password: f.password, note: f.note.trim() },
      });
      setSent(f.login.trim().toLowerCase());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-run-soft text-run">
          <CheckCircle2 className="size-7" />
        </span>
        <p className="text-lg font-semibold">Заявка отправлена</p>
        <p className="max-w-sm text-sm text-ink-2">Администратор проверит её и назначит роль. После подтверждения войдите с логином <b>{sent}</b> и своим паролем.</p>
        <Button variant="primary" className="mt-2 h-11 w-full" onClick={() => onDone(sent)}>
          Понятно
        </Button>
      </div>
    );
  const field = "h-11 w-full rounded-[12px] border border-line-strong bg-sunken px-3.5 text-sm focus:border-accent focus:bg-panel focus:outline-none";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
      <p className="text-sm text-ink-3">Заявку проверит администратор: подтвердит роль и участок. До этого войти нельзя.</p>
      <label className="block">
        <span className="mb-1 block text-[0.8125rem] font-semibold text-ink-2">Фамилия и имя</span>
        <input value={f.name} onChange={(e) => set("name")(e.target.value)} maxLength={80} autoComplete="name" className={field} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[0.8125rem] font-semibold text-ink-2">Должность</span>
        <input value={f.position} onChange={(e) => set("position")(e.target.value)} maxLength={80} placeholder="Например: оператор окраски" className={field} />
      </label>
      <fieldset>
        <legend className="mb-1.5 text-[0.8125rem] font-semibold text-ink-2">Какой доступ нужен</legend>
        <div className="flex flex-col gap-1.5">
          {REQ_ROLES.map((r) => (
            <label key={r.value} className={clsx("flex cursor-pointer items-start gap-3 rounded-[14px] border-2 px-3.5 py-2.5", f.role === r.value ? "border-brand bg-brand-soft/50" : "border-transparent bg-sunken")}>
              <input type="radio" name="req-role" className="sr-only" checked={f.role === r.value} onChange={() => set("role")(r.value)} />
              <span>
                <span className="block text-sm font-bold">{r.label}</span>
                <span className="block text-xs text-ink-3">{r.text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {f.role === "worker" && (
        <fieldset>
          <legend className="mb-1.5 block text-[0.8125rem] font-semibold text-ink-2">Участок</legend>
          <div role="radiogroup" className="grid grid-cols-2 gap-1.5">
            {areas.map((a) => (
              <button
                key={a.code}
                type="button"
                role="radio"
                aria-checked={f.area === a.code}
                onClick={() => set("area")(a.code)}
                className={clsx(
                  "min-h-10 rounded-[12px] border-2 px-3 py-1.5 text-left text-sm font-semibold transition-colors",
                  f.area === a.code ? "border-brand bg-brand-soft/50 text-ink" : "border-transparent bg-sunken text-ink-2 hover:border-line-strong",
                )}
              >
                {a.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[0.8125rem] font-semibold text-ink-2">Логин</span>
          <input value={f.login} onChange={(e) => set("login")(e.target.value.replace(/\s/g, ""))} maxLength={40} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="латиницей, например ivan.k" className={field} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[0.8125rem] font-semibold text-ink-2">Пароль</span>
          <input type="password" value={f.password} onChange={(e) => set("password")(e.target.value)} maxLength={64} autoComplete="new-password" className={field} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[0.8125rem] font-semibold text-ink-2">Повторите пароль</span>
          <input type="password" value={f.repeat} onChange={(e) => set("repeat")(e.target.value)} maxLength={64} autoComplete="new-password" className={field} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[0.8125rem] font-semibold text-ink-2">Комментарий для администратора (необязательно)</span>
        <input value={f.note} onChange={(e) => set("note")(e.target.value)} maxLength={500} placeholder="Например: перевели с участка сварки" className={field} />
      </label>
      {error && (
        <p role="alert" className="text-sm font-medium text-down">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="h-12" loading={busy}>
        Отправить заявку
      </Button>
    </form>
  );
}

function PinForm({ initial, onDone }: { initial: string; onDone: (o: LoginOut) => void }) {
  const [pin, setPin] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const press = (d: string) => {
    setError(null);
    setPin((p) => (p.length < 12 ? p + d : p));
    input.current?.focus();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (pin.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await request<LoginOut>("/auth/login", { method: "POST", body: { pin } }));
    } catch (err) {
      setError((err as Error).message);
      setPin("");
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col">
      <label className="block">
        <span className="sr-only">PIN-код</span>
        <input
          ref={input}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, "").slice(0, 12));
            setError(null);
          }}
          aria-invalid={!!error}
          aria-describedby="pin-help"
          className="sr-only"
        />
        <span
          aria-hidden
          onClick={() => input.current?.focus()}
          className={clsx(
            "flex h-16 cursor-text items-center justify-center gap-3 rounded-[18px] border-2 bg-sunken transition-colors",
            error ? "animate-[shake_.3s] border-down" : "border-transparent focus-within:border-accent",
          )}
        >
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <span key={i} className={clsx("size-3.5 rounded-full transition-[background,transform] duration-150", i < pin.length ? "scale-110 bg-ink" : "bg-line-strong")} />
          ))}
        </span>
      </label>
      <p id="pin-help" role={error ? "alert" : undefined} className={clsx("mt-2 min-h-5 text-center text-sm", error ? "font-medium text-down" : "text-ink-3")}>
        {error ?? "4–12 цифр — PIN у каждого сотрудника свой"}
      </p>

      <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Цифровая клавиатура">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Key key={d} onClick={() => press(d)}>
            {d}
          </Key>
        ))}
        <Key label="Стереть" onClick={() => setPin((p) => p.slice(0, -1))}>
          <Delete className="size-5" />
        </Key>
        <Key onClick={() => press("0")}>0</Key>
        <Button type="submit" variant="primary" loading={busy} disabled={pin.length < 4} className="h-14 rounded-[16px] text-base disabled:opacity-40" icon={<LogIn className="size-5" />}>
          Войти
        </Button>
      </div>
    </form>
  );
}

function Key({ children, onClick, label }: { children: ReactNode; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="display num grid h-14 place-items-center rounded-[16px] bg-sunken text-[1.4rem] font-light transition-[background,transform] duration-100 hover:bg-floor active:scale-95"
    >
      {children}
    </button>
  );
}

function PasswordForm({ initialLogin, initialPassword, onDone }: { initialLogin: string; initialPassword: string; onDone: (o: LoginOut) => void }) {
  const [login, setLogin] = useState(initialLogin);
  const [password, setPassword] = useState(initialPassword);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (initialLogin ? second : first).current?.focus();
  }, [initialLogin]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!login.trim()) return setError("Введите логин"), first.current?.focus();
    if (!password) return setError("Введите пароль"), second.current?.focus();
    setBusy(true);
    setError(null);
    try {
      onDone(await request<LoginOut>("/auth/login", { method: "POST", body: { login: login.trim(), pin: password } }));
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
      second.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const field = "h-12 w-full rounded-[14px] border border-line-strong bg-sunken px-4 text-[0.95rem] text-ink transition-colors hover:border-ink-3 focus:border-accent focus:bg-panel focus:outline-none";
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <label className="block">
        <span className="mb-1.5 block text-[0.8125rem] font-semibold text-ink-2">Логин</span>
        <input
          ref={first}
          value={login}
          onChange={(e) => {
            setLogin(e.target.value);
            setError(null);
          }}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          className={field}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[0.8125rem] font-semibold text-ink-2">Пароль или PIN</span>
        <span className="relative block">
          <input
            ref={second}
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            autoComplete="current-password"
            maxLength={64}
            aria-invalid={!!error}
            aria-describedby="pw-help"
            className={clsx(field, "pr-12", error && "border-down")}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Скрыть пароль" : "Показать пароль"}
            className="absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-panel hover:text-ink"
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </span>
      </label>
      <p id="pw-help" role={error ? "alert" : undefined} className={clsx("-mt-1 min-h-5 text-sm", error ? "font-medium text-down" : "text-ink-3")}>
        {error ?? "Логин и пароль выдаёт администратор"}
      </p>
      <Button type="submit" variant="primary" loading={busy} className="h-12 text-base" icon={<LogIn className="size-5" />}>
        Войти
      </Button>
    </form>
  );
}

function DemoAccounts({ users, onPick }: { users: StaffMember[]; onPick: (u: StaffMember) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-8 rounded-[18px] bg-sunken/70 p-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex h-10 w-full items-center justify-between rounded-[14px] px-3 text-sm font-semibold text-ink-2 hover:bg-panel/60">
        Демо-доступы — нажмите, чтобы подставить
        <ChevronDown className={clsx("size-4 text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {users.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => onPick(u)} className="flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-1.5 text-left hover:bg-panel">
                <span className={clsx("display grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium", AVATAR[u.role])} aria-hidden>
                  {initials(u.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-bold">{u.name}</span>
                  <span className="block truncate text-xs text-ink-3">{u.position}</span>
                </span>
                <span className="num shrink-0 text-right text-xs leading-tight text-ink-3">
                  <span className="block font-semibold text-ink-2">{u.demo_pin}</span>
                  <span className="block">{u.login}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
