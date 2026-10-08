import { Sparkles, Wrench, Zap } from "lucide-react";
import { Link } from "react-router";
import { useFloorControl, useInsights, useMe, usePlant } from "@/shared/api/queries";
import type { Floor } from "@/shared/api/types";
import { EQ_STATUS, STATE_COLOR, dayLong, kzt, time } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { useSim } from "@/shared/sim/store";
import { Dot, Meter } from "@/shared/ui/Status";

export function EquipmentDrawer({ code, floor, onClose }: { code: string | null; floor: Floor; onClose: () => void }) {
  const plant = usePlant();
  const insights = useInsights();
  const me = useMe();
  const ctl = useFloorControl();
  const simState = useSim();
  const spec = plant.data?.equipment.find((e) => e.code === code);
  const state = floor.equipment.find((e) => e.code === code);
  const risk = insights.data?.risks.find((r) => r.code === code);
  const area = plant.data?.areas.find((a) => a.code === spec?.area);
  const canOperate = me.data?.permissions.includes("operate");
  const down = state?.status === "down" || state?.status === "maint";

  const inSim = !!simState.result;
  return (
    <Drawer open={!!code} onClose={onClose} title={code ?? ""}>
      {spec && state && (
        <div className="flex flex-col gap-6 p-5">
          <div>
            <p className="text-ink-2">{spec.name}</p>
            <p className="mt-0.5 text-sm text-ink-3">
              {area?.name} · {spec.critical ? "критичное: отказ останавливает участок" : "некритичное: отказ замедляет участок"}
            </p>
          </div>

          <section className="rounded-[16px] border border-line p-4">
            <div className="flex items-center gap-2">
              <Dot color={STATE_COLOR[state.status]} pulse={down} />
              <span className="font-medium">{EQ_STATUS[state.status]}</span>
              {state.reason && <span className="text-ink-2">— {state.reason.toLowerCase()}</span>}
            </div>
            {down && state.until && <p className="mt-1 text-sm text-ink-2">Восстановление ожидается к {time(state.until)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to={`/app/sim?eq=${encodeURIComponent(spec.code)}`}
                onClick={onClose}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brand px-3.5 text-[0.8125rem] font-semibold text-white hover:bg-brand-2"
              >
                <Sparkles className="size-4" aria-hidden /> Что будет, если сломается
              </Link>
            {canOperate && !inSim && (
              <>
                {down ? (
                  <Button size="sm" variant="primary" icon={<Wrench className="size-4" />} onClick={() => ctl.repair.mutate(spec.code)}>
                    Завершить ремонт
                  </Button>
                ) : (
                  <Button size="sm" variant="danger" icon={<Zap className="size-4" />} onClick={() => ctl.fail.mutate({ equipment: spec.code, minutes: 40 })}>
                    Остановить в живом цехе на 40 мин
                  </Button>
                )}
              </>
            )}
            </div>
          </section>

          {risk && (
            <section>
              <h3 className="text-[0.9375rem]">Риск отказа за 7 дней</h3>
              <div className="mt-3 flex items-baseline gap-3">
                <span className="num text-[2rem] leading-none font-semibold">{Math.round(risk.probability * 100)}%</span>
                <span className="text-sm text-ink-2">{risk.level === "high" ? "высокий" : risk.level === "medium" ? "средний" : "низкий"}</span>
              </div>
              <Meter className="mt-3" value={risk.probability} max={1} tone={risk.level === "high" ? "down" : risk.level === "medium" ? "blocked" : "run"} />
              <ul className="mt-4 flex flex-col gap-2 text-sm">
                {risk.factors.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                    {f}
                  </li>
                ))}
              </ul>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-ink-3">Отказов за 90 дней</dt>
                  <dd className="num font-medium">{risk.failures_90}</dd>
                </div>
                <div>
                  <dt className="text-ink-3">Последний</dt>
                  <dd className="font-medium">{risk.last_failure ? dayLong(risk.last_failure) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-ink-3">Главная причина</dt>
                  <dd className="font-medium">{risk.main_reason ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-ink-3">Среднее восстановление</dt>
                  <dd className="num font-medium">{risk.mttr_min ? `${Math.round(risk.mttr_min)} мин` : "—"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-ink-3">Ожидаемые потери за неделю</dt>
                  <dd className="num font-medium">{kzt(risk.expected_loss_kzt)}</dd>
                </div>
              </dl>
              {risk.intervals.length > 1 && (
                <div className="mt-5">
                  <h4 className="text-sm font-medium">Дней между отказами</h4>
                  <div className="mt-2 flex items-end gap-1.5" aria-label={`Интервалы: ${risk.intervals.join(", ")}`}>
                    {risk.intervals.map((d, i) => (
                      <div key={i} className="flex flex-1 flex-col items-center gap-1">
                        <div
                          className="w-full max-w-7 rounded-t-[3px] bg-ink"
                          style={{ height: `${(d / Math.max(...risk.intervals)) * 72 + 4}px`, opacity: 0.35 + (0.65 * (i + 1)) / risk.intervals.length }}
                        />
                        <span className="num text-2xs text-ink-3">{d}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
