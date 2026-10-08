import { clsx } from "clsx";
import { AtSign, Eye, EyeOff, KeyRound, Lock, Plus, UserCheck, UserPen, UserX } from "lucide-react";
import { type FormEvent, useState } from "react";
import { initials } from "@/features/auth/LoginPage";
import { usePlant, useUserActions, useUsers } from "@/shared/api/queries";
import type { Role, StaffFull } from "@/shared/api/types";
import { useSession } from "@/shared/auth/session";
import { dateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { Field, Input, Select } from "@/shared/ui/Field";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { toast } from "@/shared/ui/Toaster";

const ROLES: { value: Role; label: string; text: string }[] = [
  { value: "worker", label: "Рабочий", text: "Видит свой участок и сообщает о проблеме" },
  { value: "supervisor", label: "Начальник смены", text: "Принимает смену, ведёт инциденты, экспресс-анализ" },
  { value: "director", label: "Руководитель", text: "Все показатели, анализ, экономика, отчёты" },
  { value: "admin", label: "Администратор", text: "Всё, плюс сотрудники, параметры линии и данные" },
];

export function StaffPage() {
  const users = useUsers();
  const [edit, setEdit] = useState<StaffFull | "new" | null>(null);
  const requests = (users.data ?? []).filter((u) => u.status === "pending");
  const staff = (users.data ?? []).filter((u) => u.status !== "pending");
  return (
    <div className="grid gap-4">
      {requests.length > 0 && <Requests list={requests} />}
      <Panel
        title="Сотрудники"
        hint="Вход — по PIN-коду или по логину и паролю. В базе хранится только хэш: восстановить пароль нельзя, только задать новый. После 5 неверных попыток вход блокируется на 5 минут."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>
            Добавить сотрудника
          </Button>
        }
        bodyClass="px-0 pb-2"
      >
        {users.isError && (
          <div className="px-6">
            <ErrorNote error={users.error} />
          </div>
        )}
        {!users.data && !users.isError && (
          <div className="px-6">
            <Skeleton className="h-64" />
          </div>
        )}
        <ul>
          {staff.map((u) => (
            <li key={u.id} className={clsx("flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-6 py-3", !u.active && "opacity-55")}>
              <span className="display grid size-10 shrink-0 place-items-center rounded-full bg-sunken text-sm font-medium" aria-hidden>
                {initials(u.name)}
              </span>
              <div className="min-w-[12rem] flex-1">
                <div className="font-semibold">{u.name}</div>
                <div className="text-[0.8125rem] text-ink-3">
                  {u.position} · {u.role_name}
                  {u.login && <span className="num"> · логин {u.login}</span>}
                </div>
              </div>
              <div className="text-xs text-ink-3">
                {!u.active ? "отключён" : u.locked_until && new Date(u.locked_until) > new Date() ? (
                  <span className="inline-flex items-center gap-1 text-down">
                    <Lock className="size-3.5" aria-hidden /> заблокирован
                  </span>
                ) : u.last_login ? (
                  `входил ${dateTime(u.last_login)}`
                ) : (
                  "ещё не входил"
                )}
              </div>
              <Button size="sm" variant="ghost" icon={<UserPen className="size-4" />} onClick={() => setEdit(u)}>
                Изменить
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
      <Drawer open={edit != null} onClose={() => setEdit(null)} title={edit === "new" ? "Новый сотрудник" : "Сотрудник"} width="max-w-[480px]">
        {edit != null && <UserForm key={edit === "new" ? "new" : edit.id} user={edit === "new" ? null : edit} onDone={() => setEdit(null)} />}
      </Drawer>
    </div>
  );
}

function Requests({ list }: { list: StaffFull[] }) {
  return (
    <Panel title={`Заявки на доступ · ${list.length}`} hint="Сотрудник войдёт сразу после подтверждения. Роль и участок можно поправить." className="ring-2 ring-blocked/40">
      <ul className="flex flex-col gap-3">
        {list.map((u) => (
          <RequestRow key={u.id} u={u} />
        ))}
      </ul>
    </Panel>
  );
}

function RequestRow({ u }: { u: StaffFull }) {
  const plant = usePlant();
  const act = useUserActions();
  const [role, setRole] = useState<Role>(u.role);
  const [area, setArea] = useState(u.area ?? "PAINT");
  const fail = (e: Error) => toast({ title: "Не получилось", body: e.message, tone: "down" });
  return (
    <li className="rounded-[18px] border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold">{u.name}</div>
          <div className="text-[0.8125rem] text-ink-3">
            {u.position} · логин <span className="num">{u.login}</span> · {dateTime(u.created_at)}
          </div>
          {u.request_note && <p className="mt-1.5 rounded-[12px] bg-sunken px-3 py-2 text-sm text-ink-2">«{u.request_note}»</p>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Роль">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          {role === "worker" && (
            <Field label="Участок">
              <Select value={area} onChange={(e) => setArea(e.target.value)}>
                {(plant.data?.areas ?? []).map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Button
            variant="primary"
            icon={<UserCheck className="size-4" />}
            loading={act.approve.isPending}
            onClick={() =>
              act.approve.mutate(
                { id: u.id, role, area: role === "worker" ? area : null },
                { onSuccess: () => toast({ title: "Доступ подтверждён", body: `${u.name} может войти с логином ${u.login}.`, tone: "run" }), onError: fail },
              )
            }
          >
            Подтвердить
          </Button>
          <Button
            variant="ghost"
            icon={<UserX className="size-4" />}
            loading={act.reject.isPending}
            onClick={() => act.reject.mutate(u.id, { onSuccess: () => toast({ title: "Заявка отклонена", body: u.name, tone: "run" }), onError: fail })}
          >
            Отклонить
          </Button>
        </div>
      </div>
    </li>
  );
}

function UserForm({ user, onDone }: { user: StaffFull | null; onDone: () => void }) {
  const me = useSession();
  const plant = usePlant();
  const act = useUserActions();
  const [name, setName] = useState(user?.name ?? "");
  const [position, setPosition] = useState(user?.position ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "worker");
  const [area, setArea] = useState(user?.area ?? "PAINT");
  const [login, setLogin] = useState(user?.login ?? "");
  const [pin, setPin] = useState("");
  const [show, setShow] = useState(false);
  const [active, setActive] = useState(user?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const self = user?.id === me?.id;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!user && pin.length < 4) return setError("Задайте PIN (от 4 цифр) или пароль (от 6 символов)");
    if (pin && !/^\d+$/.test(pin) && pin.length < 6) return setError("Пароль — минимум 6 символов. Или задайте PIN из цифр.");
    const lg = login.trim().toLowerCase();
    const body = {
      name: name.trim(),
      position: position.trim(),
      role,
      area: role === "worker" ? area : null,
      ...(lg && lg !== user?.login ? { login: lg } : {}),
      ...(pin ? { pin } : {}),
    };
    const ok = () => {
      toast({ title: user ? "Сохранено" : "Сотрудник добавлен", body: pin ? "Передайте логин и пароль сотруднику лично." : undefined, tone: "run" });
      onDone();
    };
    const fail = (err: Error) => setError(err.message);
    if (user) act.update.mutate({ id: user.id, ...body, active }, { onSuccess: ok, onError: fail });
    else act.create.mutate({ ...body, pin }, { onSuccess: ok, onError: fail });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5">
      <Field label="ФИО">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required minLength={2} />
      </Field>
      <Field label="Должность" hint="Печатается в документах, которые сотрудник выгружает">
        <Input value={position} onChange={(e) => setPosition(e.target.value)} maxLength={80} required minLength={2} />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[0.8125rem] font-semibold text-ink-2">Роль</legend>
        {ROLES.map((r) => (
          <label
            key={r.value}
            className={clsx("flex cursor-pointer items-start gap-3 rounded-[14px] border-2 px-3.5 py-2.5", role === r.value ? "border-brand bg-brand-soft/50" : "border-transparent bg-sunken", self && "pointer-events-none opacity-60")}
          >
            <input type="radio" name="role" className="sr-only" checked={role === r.value} onChange={() => setRole(r.value)} disabled={self} />
            <span>
              <span className="block text-sm font-bold">{r.label}</span>
              <span className="block text-xs text-ink-3">{r.text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {role === "worker" && (
        <Field label="Участок">
          <Select value={area} onChange={(e) => setArea(e.target.value)}>
            {(plant.data?.areas ?? []).map((a) => (
              <option key={a.code} value={a.code}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Логин" hint={user ? "Латиница, цифры, точка, дефис — от 3 символов" : "Можно не заполнять — придумаем по имени"}>
        <span className="relative block">
          <AtSign className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={login} onChange={(e) => setLogin(e.target.value.replace(/\s/g, "").slice(0, 40))} autoComplete="off" autoCapitalize="none" spellCheck={false} className="pl-9" />
        </span>
      </Field>
      <Field label={user ? "Новый PIN или пароль (если нужно сменить)" : "PIN или пароль"} hint="PIN — 4–12 цифр, удобно на телефоне в цеху. Пароль — от 6 символов. У двух сотрудников не может быть одинакового.">
        <span className="relative block">
          <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input type={show ? "text" : "password"} autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.slice(0, 64))} className="pr-11 pl-9" />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Скрыть" : "Показать"} className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-panel hover:text-ink">
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </span>
      </Field>
      {user && !self && (
        <label className="flex items-center gap-3 text-sm font-semibold">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
          Может входить в систему
        </label>
      )}
      {error && <ErrorNote error={new Error(error)} />}
      <Button type="submit" variant="primary" className="h-11" loading={act.create.isPending || act.update.isPending}>
        {user ? "Сохранить" : "Добавить сотрудника"}
      </Button>
    </form>
  );
}
