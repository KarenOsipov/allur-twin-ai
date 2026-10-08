import { Clock, PackageX, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { useFloorControl, useMe, usePlant } from "@/shared/api/queries";
import type { Floor } from "@/shared/api/types";
import { AREA_STATE, EQ_STATUS, STATE_COLOR, num, num1 } from "@/shared/lib/format";
import { useSim } from "@/shared/sim/store";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { Dot, Meter } from "@/shared/ui/Status";

export function AreaDrawer({
  code,
  floor,
  onClose,
  onEquipment,
}: {
  code: string | null;
  floor: Floor;
  onClose: () => void;
  onEquipment: (code: string) => void;
}) {
  const plant = usePlant();
  const me = useMe();
  const ctl = useFloorControl();
  const inSim = !!useSim().result;
  const spec = plant.data?.areas.find((a) => a.code === code);
  const a = floor.areas.find((x) => x.code === code);
  const equipment = (plant.data?.equipment ?? []).filter((e) => e.area === code);
  const canOperate = me.data?.permissions.includes("operate");

  return (
    <Drawer open={!!code} onClose={onClose} title={spec?.name ?? a?.name ?? ""}>
      {a && spec && (
        <div className="flex flex-col gap-6 p-5">
          {a.kind === "store" ? (
            <StoreBody
              incoming={a.code === "WH_IN"}
              stock={a.stock ?? 0}
              delayed={!!a.delayed}
              canDelay={!!canOperate && !inSim}
              busy={ctl.supply.isPending}
              onDelay={() => ctl.supply.mutate(30)}
            />
          ) : (
            <>
              <section className="rounded-[16px] border border-line p-4">
                <div className="flex items-center gap-2">
                  <Dot color={STATE_COLOR[a.state ?? "off"]} pulse={a.state === "down"} />
                  <span className="font-medium">{AREA_STATE[a.state ?? "off"]}</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3">
                  <Stat label="Выпуск за смену" value={num(a.output)} />
                  <Stat label={a.kind === "inspection" ? "Отклонено" : "Брак"} value={num(a.defects ?? 0)} />
                  <Stat label="OEE" value={a.oee == null ? "—" : `${Math.round(a.oee)}%`} />
                </dl>
                <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-ink-3">
                  <Clock className="size-4" aria-hidden /> Цикл {num1(spec.cycle_s / 60)} мин
                  {a.buffer_cap ? ` · буфер после участка ${a.buffer?.length ?? 0} из ${a.buffer_cap}` : ""}
                </p>
              </section>
              {a.time && <TimeSplit t={a.time} />}
            </>
          )}

          {equipment.length > 0 && (
            <section>
              <h3 className="text-[0.9375rem]">Оборудование участка · {equipment.length}</h3>
              <ul className="mt-3 flex flex-col gap-1.5">
                {equipment.map((e) => {
                  const st = floor.equipment.find((x) => x.code === e.code);
                  const status = st?.status ?? "off";
                  return (
                    <li key={e.code}>
                      <button
                        type="button"
                        onClick={() => onEquipment(e.code)}
                        className="flex w-full items-center gap-3 rounded-[12px] bg-sunken px-3 py-2.5 text-left text-sm transition-colors hover:bg-brand-soft/60"
                      >
                        <Dot color={STATE_COLOR[status]} pulse={status === "down"} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">{e.code}</span>
                          <span className="block truncate text-xs text-ink-3">{e.name}</span>
                        </span>
                        <span className="shrink-0 text-xs text-ink-2">{EQ_STATUS[status]}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {a.kind !== "store" && (
            <Link
              to="/app/sim"
              onClick={onClose}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-2"
            >
              <Sparkles className="size-4" aria-hidden /> Смоделировать событие на участке
            </Link>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="display num mt-0.5 text-[1.6rem] leading-none font-light">{value}</dd>
    </div>
  );
}

const SPLIT = [
  { key: "run", label: "Работал", color: STATE_COLOR.run },
  { key: "starved", label: "Ждал кузов", color: STATE_COLOR.starved },
  { key: "blocked", label: "Буфер полон", color: STATE_COLOR.blocked },
  { key: "down", label: "Стоял", color: STATE_COLOR.down },
] as const;

function TimeSplit({ t }: { t: { run: number; down: number; starved: number; blocked: number } }) {
  const total = t.run + t.down + t.starved + t.blocked || 1;
  return (
    <section>
      <h3 className="text-[0.9375rem]">Куда ушло время смены</h3>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-sunken" aria-hidden>
        {SPLIT.map((s) => (
          <span key={s.key} style={{ width: `${(t[s.key] / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {SPLIT.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <Dot color={s.color} />
            <span className="flex-1 text-ink-2">{s.label}</span>
            <span className="num font-semibold">{Math.round((t[s.key] / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StoreBody({
  incoming,
  stock,
  delayed,
  canDelay,
  busy,
  onDelay,
}: {
  incoming: boolean;
  stock: number;
  delayed: boolean;
  canDelay: boolean;
  busy: boolean;
  onDelay: () => void;
}) {
  const low = incoming && stock < 6;
  return (
    <>
      <section className="rounded-[16px] border border-line p-4">
        <p className="text-sm text-ink-2">{incoming ? "Комплекты кузовов и деталей, ждущие запуска на линию" : "Автомобили, сошедшие с линии за смену"}</p>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="display num text-[2.6rem] leading-none font-light">{num(stock)}</span>
          <span className="text-sm text-ink-3">{incoming ? "комплектов" : "авто"}</span>
        </div>
        {incoming && (
          <>
            <Meter className="mt-3" value={Math.min(stock, 40)} max={40} tone={low ? "down" : "run"} />
            <p className="mt-2 text-sm" style={{ color: delayed || low ? "var(--color-down)" : "var(--color-ink-3)" }}>
              {delayed ? "Поставка задержана — склад расходуется без пополнения." : low ? "Запас на исходе: линия скоро встанет без комплектов." : "Запаса хватает, поставки идут по графику."}
            </p>
          </>
        )}
      </section>
      {incoming && (
        <div className="flex flex-wrap gap-2">
          <Link
            to="/app/sim"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-2"
          >
            <Sparkles className="size-4" aria-hidden /> Что будет при срыве поставки
          </Link>
          {canDelay && !delayed && (
            <Button variant="danger" icon={<PackageX className="size-4" />} loading={busy} onClick={onDelay}>
              Задержать поставку на 30 мин
            </Button>
          )}
        </div>
      )}
    </>
  );
}
