import type { EqType, EquipmentSpec, Kind, NodeParams } from "./model";

export type ProcKey =
  | "kit_store"
  | "logistics"
  | "press"
  | "jig"
  | "robot_cell"
  | "weld_line"
  | "geometry"
  | "pretreat"
  | "sealer"
  | "paint_booth"
  | "oven"
  | "paint_qc"
  | "overhead"
  | "floor_conv"
  | "buffer"
  | "splitter"
  | "trim"
  | "marriage"
  | "final"
  | "fluids"
  | "alignment"
  | "water_test"
  | "test_track"
  | "qc_gate"
  | "rework"
  | "fg_store";

export interface ZoneInfo {
  name: string;
  code: string;
  color: string;
}

export const ZONES: ZoneInfo[] = [
  { name: "Логистика", code: "LOG", color: "#5f7d95" },
  { name: "Сварка", code: "BIW", color: "#8a6f4d" },
  { name: "Окраска", code: "PNT", color: "#4f7f78" },
  { name: "Сборка", code: "ASM", color: "#6b6f9a" },
  { name: "Контроль", code: "QC", color: "#7f8a4d" },
  { name: "Отгрузка", code: "SHP", color: "#7d6a86" },
];

const EXTRA_COLORS = ["#8a5d5d", "#5d7f8a", "#7a7a52", "#6d5d8a", "#5d8a6a", "#8a7a5d"];

export function zoneColor(name: string | undefined): string {
  if (!name) return "#7d8389";
  const z = ZONES.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (z) return z.color;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
}

export function zoneCode(name: string | undefined): string {
  if (!name) return "";
  const z = ZONES.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  return z ? z.code : name.trim().slice(0, 3).toUpperCase();
}

export interface ProcInfo {
  kind: Kind;
  label: string;
  zone: string;
  desc: string;
  steps: string[];
  prefix: string;
  eq: { type: EqType; n: number; critical?: boolean }[];
  params: Partial<NodeParams>;
}

export const PROCS: Record<ProcKey, ProcInfo> = {
  kit_store: {
    kind: "source",
    label: "Склад комплектующих",
    zone: "Логистика",
    desc: "Приёмка CKD/SKD-комплектов от поставщика, хранение в стеллажах, комплектация и подача на линию по сигналу канбан.",
    steps: ["Приёмка контейнеров и сверка по спецификации", "Хранение в стеллажах по адресам", "Комплектация тележек под модель", "Выдача на линию по канбану"],
    prefix: "СК",
    eq: [],
    params: { rate_per_hour: 20, stock_cap: 80, stock_init: 40, workers: 6, shifts: 2 },
  },
  logistics: {
    kind: "transport",
    label: "Участок логистики",
    zone: "Логистика",
    desc: "Внутрицеховая доставка комплектов тягачами, AGV или погрузчиками от склада к постам. Задаётся временем рейса и вместимостью тележек.",
    steps: ["Загрузка тележки на складе", "Рейс по маршруту", "Выгрузка у поста", "Возврат пустой тары"],
    prefix: "ЛГ",
    eq: [],
    params: { capacity: 6, travel_s: 240, workers: 2 },
  },
  press: {
    kind: "station",
    label: "Пресс / штамповка",
    zone: "Сварка",
    desc: "Вырубка и вытяжка панелей кузова из листа на прессовой линии. Длинная переналадка штампов, высокая производительность.",
    steps: ["Подача заготовки", "Вытяжка", "Обрезка и пробивка", "Укладка панелей в тару"],
    prefix: "ПР",
    eq: [{ type: "press", n: 3 }],
    params: { cycle_s: 60, parallel: 1, variability: 4, defect_pct: 0.6, workers: 3 },
  },
  jig: {
    kind: "station",
    label: "Кондуктор",
    zone: "Сварка",
    desc: "Сварочный кондуктор фиксирует панели основания и боковин в заданной геометрии для прихватки. От его точности зависят зазоры и перепады кузова.",
    steps: ["Укладка панелей", "Зажим пневмоприжимами", "Прихватка точками", "Разжим и съём"],
    prefix: "КД",
    eq: [{ type: "jig", n: 2 }],
    params: { cycle_s: 210, parallel: 1, variability: 5, defect_pct: 0.8, workers: 2 },
  },
  robot_cell: {
    kind: "station",
    label: "Робот-ячейка сварки",
    zone: "Сварка",
    desc: "Ячейка с роботами ABB/KUKA в защитном ограждении: точечная контактная и дуговая сварка, нанесение клея-герметика. Цикл стабилен, простои — по отказам роботов и клещей.",
    steps: ["Загрузка кузова на стол", "Сварка точек по программе", "Контроль электродов", "Выгрузка"],
    prefix: "РБ",
    eq: [{ type: "robot", n: 4 }],
    params: { cycle_s: 190, parallel: 1, variability: 3, defect_pct: 0.9, workers: 1 },
  },
  weld_line: {
    kind: "station",
    label: "Сварочная линия",
    zone: "Сварка",
    desc: "Сборка-сварка кузова в белом (BIW): установка боковин и крыши, доварка ручными клещами. Ручные посты, нужна численность персонала.",
    steps: ["Установка боковин", "Установка крыши", "Доварка клещами", "Установка навесных: двери, капот, багажник"],
    prefix: "СВ",
    eq: [{ type: "jig", n: 1 }, { type: "tool", n: 3 }, { type: "conveyor", n: 1 }],
    params: { cycle_s: 220, parallel: 2, variability: 7, defect_pct: 1.2, workers: 8 },
  },
  geometry: {
    kind: "inspection",
    label: "Контроль геометрии кузова",
    zone: "Сварка",
    desc: "Измерение контрольных точек кузова на КИМ или оптическом посту. Кузова с отклонениями уходят на доработку.",
    steps: ["Базирование кузова", "Сканирование точек", "Сравнение с CAD", "Решение: годен / доработка"],
    prefix: "ГК",
    eq: [{ type: "tester", n: 1, critical: false }],
    params: { cycle_s: 150, parallel: 1, variability: 4, defect_pct: 0, detect_pct: 90, workers: 1 },
  },
  pretreat: {
    kind: "station",
    label: "Подготовка / фосфатирование",
    zone: "Окраска",
    desc: "Обезжиривание, промывка, фосфатирование и катафорезное грунтование (КТЛ) погружением в ванны. Защищает кузов от коррозии.",
    steps: ["Обезжиривание", "Промывка деминерализованной водой", "Фосфатирование", "КТЛ-грунт", "Ополаскивание"],
    prefix: "ПП",
    eq: [{ type: "tank", n: 4 }, { type: "conveyor", n: 1 }],
    params: { cycle_s: 160, parallel: 3, variability: 2, defect_pct: 0.5, workers: 2 },
  },
  sealer: {
    kind: "station",
    label: "Герметизация швов",
    zone: "Окраска",
    desc: "Нанесение герметика на сварные швы и антигравийного покрытия днища. Ручные посты и роботы-дозаторы.",
    steps: ["Герметик швов", "Антигравий днища", "Шумоизоляционные мастики", "Визуальный контроль"],
    prefix: "ГМ",
    eq: [{ type: "robot", n: 2 }, { type: "tool", n: 2 }],
    params: { cycle_s: 200, parallel: 2, variability: 6, defect_pct: 0.7, workers: 4 },
  },
  paint_booth: {
    kind: "station",
    label: "Окрасочная камера",
    zone: "Окраска",
    desc: "Нанесение грунта, базового слоя и лака роботами-распылителями в камере с подготовленным воздухом. Главный источник дефектов ЛКП: сор, потёки, шагрень.",
    steps: ["Обеспыливание", "Грунт-наполнитель", "База", "Лак", "Флэш-зона"],
    prefix: "ОК",
    eq: [{ type: "booth", n: 2 }, { type: "robot", n: 2 }],
    params: { cycle_s: 230, parallel: 2, variability: 5, defect_pct: 3.5, workers: 3 },
  },
  oven: {
    kind: "station",
    label: "Печь сушки",
    zone: "Окраска",
    desc: "Полимеризация покрытия при 140–180 °C на проходном конвейере. Цикл задаётся длиной печи и скоростью конвейера.",
    steps: ["Разогрев", "Выдержка при температуре", "Охлаждение"],
    prefix: "ПЧ",
    eq: [{ type: "oven", n: 1 }, { type: "conveyor", n: 1 }],
    params: { cycle_s: 180, parallel: 4, variability: 1, defect_pct: 0.3, workers: 0 },
  },
  paint_qc: {
    kind: "inspection",
    label: "Контроль ЛКП",
    zone: "Окраска",
    desc: "Осмотр покрытия в световом туннеле, замер толщины слоя. Дефекты ЛКП уходят на полировку или перекраску.",
    steps: ["Осмотр в световом туннеле", "Замер толщины", "Маркировка дефектов"],
    prefix: "КЛ",
    eq: [{ type: "tester", n: 1, critical: false }],
    params: { cycle_s: 140, parallel: 1, variability: 4, defect_pct: 0, detect_pct: 92, workers: 2 },
  },
  overhead: {
    kind: "transport",
    label: "Подвесной конвейер",
    zone: "Логистика",
    desc: "Перенос кузовов между цехами на подвесках по монорельсу. Освобождает пол и сам служит буфером.",
    steps: ["Навеска кузова", "Транспортировка по монорельсу", "Снятие на приёмном посту"],
    prefix: "ПК",
    eq: [],
    params: { capacity: 14, travel_s: 300 },
  },
  floor_conv: {
    kind: "transport",
    label: "Напольный конвейер",
    zone: "Сборка",
    desc: "Пластинчатый или тележечный напольный конвейер, по которому кузов движется вдоль постов сборки.",
    steps: ["Приём кузова", "Движение с постоянной скоростью", "Передача на следующий участок"],
    prefix: "НК",
    eq: [],
    params: { capacity: 8, travel_s: 120 },
  },
  buffer: {
    kind: "buffer",
    label: "Буфер",
    zone: "",
    desc: "Накопитель между участками. Гасит разницу в темпе и короткие простои: пока буфер не пуст, следующий участок работает.",
    steps: ["Приём изделия", "Хранение в очереди", "Выдача по запросу"],
    prefix: "БФ",
    eq: [],
    params: { capacity: 8 },
  },
  splitter: {
    kind: "splitter",
    label: "Распределитель потока",
    zone: "",
    desc: "Стрелка или поворотный стол: делит поток кузовов между параллельными линиями — по очереди, по долям или в свободную.",
    steps: ["Идентификация кузова", "Выбор направления", "Передача на линию"],
    prefix: "РП",
    eq: [],
    params: { capacity: 4, split_mode: "rr", shares: {} },
  },
  trim: {
    kind: "station",
    label: "Пост сборки",
    zone: "Сборка",
    desc: "Пост движущейся линии: жгуты проводов, шумоизоляция, панель приборов, стёкла, обивки. Ручные операции, такт определяется численностью.",
    steps: ["Жгуты и проводка", "Шумоизоляция", "Панель приборов", "Вклейка стёкол", "Обивки"],
    prefix: "ПС",
    eq: [{ type: "tool", n: 3 }, { type: "lift", n: 1 }],
    params: { cycle_s: 200, parallel: 4, variability: 8, defect_pct: 1, workers: 12 },
  },
  marriage: {
    kind: "assembly",
    label: "Стыковка кузова и шасси",
    zone: "Сборка",
    desc: "«Свадьба»: кузов на подвесе опускается на силовой агрегат с подвеской и крепится снизу. Нужны два входящих потока — кузов и шасси.",
    steps: ["Подача шасси на тележке", "Опускание кузова", "Затяжка креплений", "Контроль момента"],
    prefix: "СТ",
    eq: [{ type: "lift", n: 1 }, { type: "tool", n: 2 }],
    params: { cycle_s: 190, parallel: 1, variability: 5, defect_pct: 0.8, workers: 4 },
  },
  final: {
    kind: "station",
    label: "Финальная сборка",
    zone: "Сборка",
    desc: "Колёса, сиденья, бамперы, двери после снятия, аккумулятор. Затяжка критичных соединений гайковёртами с протоколом момента.",
    steps: ["Колёса", "Сиденья", "Бамперы и навесные", "Двери", "Аккумулятор"],
    prefix: "ФС",
    eq: [{ type: "tool", n: 3 }, { type: "lift", n: 1 }],
    params: { cycle_s: 210, parallel: 3, variability: 7, defect_pct: 1.1, workers: 10 },
  },
  fluids: {
    kind: "station",
    label: "Заливка жидкостей",
    zone: "Сборка",
    desc: "Вакуумирование систем и заливка тормозной жидкости, антифриза, хладагента кондиционера, омывателя и топлива.",
    steps: ["Вакуумная проверка", "Тормозная жидкость", "Антифриз", "Хладагент", "Топливо"],
    prefix: "ЗЖ",
    eq: [{ type: "tank", n: 3 }],
    params: { cycle_s: 170, parallel: 1, variability: 3, defect_pct: 0.4, workers: 2 },
  },
  alignment: {
    kind: "inspection",
    label: "Стенд развал-схождения",
    zone: "Контроль",
    desc: "Регулировка углов установки колёс, проверка тормозов и фар на роликовом стенде.",
    steps: ["Развал-схождение", "Тормоза на роликах", "Свет фар", "Скоростной тест"],
    prefix: "РС",
    eq: [{ type: "tester", n: 2, critical: false }],
    params: { cycle_s: 160, parallel: 2, variability: 4, defect_pct: 0, detect_pct: 85, workers: 3 },
  },
  water_test: {
    kind: "inspection",
    label: "Камера дождевания",
    zone: "Контроль",
    desc: "Проверка герметичности кузова душированием под давлением и осмотр салона на протечки.",
    steps: ["Душирование 4–6 минут", "Обдув", "Осмотр салона"],
    prefix: "ДЖ",
    eq: [{ type: "booth", n: 1, critical: false }],
    params: { cycle_s: 300, parallel: 2, variability: 2, defect_pct: 0, detect_pct: 95, workers: 2 },
  },
  test_track: {
    kind: "inspection",
    label: "Тест-трек",
    zone: "Контроль",
    desc: "Ходовые испытания: разгон, торможение, неровности, поиск стуков и шумов.",
    steps: ["Разгон", "Торможение", "Неровности", "Поиск шумов"],
    prefix: "ТТ",
    eq: [],
    params: { cycle_s: 420, parallel: 3, variability: 10, defect_pct: 0, detect_pct: 80, workers: 3 },
  },
  qc_gate: {
    kind: "inspection",
    label: "Контроль качества (ОТК)",
    zone: "Контроль",
    desc: "Финальный аудит автомобиля по чек-листу: внешний вид, функции, документы. Решение о выпуске.",
    steps: ["Внешний осмотр", "Проверка функций", "Электроника и ошибки", "Оформление паспорта"],
    prefix: "ОТ",
    eq: [{ type: "tester", n: 1, critical: false }],
    params: { cycle_s: 150, parallel: 1, variability: 5, defect_pct: 0, detect_pct: 92, workers: 2 },
  },
  rework: {
    kind: "station",
    label: "Доработка",
    zone: "Контроль",
    desc: "Устранение дефектов, найденных контролем. Подключите выход «брак» контроля сюда, а выход доработки — обратно на контроль.",
    steps: ["Диагностика дефекта", "Ремонт", "Возврат на контроль"],
    prefix: "ДР",
    eq: [{ type: "tool", n: 1, critical: false }],
    params: { cycle_s: 600, parallel: 2, variability: 20, defect_pct: 0, rework: true, workers: 3 },
  },
  fg_store: {
    kind: "sink",
    label: "Склад ГП",
    zone: "Отгрузка",
    desc: "Приёмка готовых автомобилей, парковка на площадке готовой продукции и отгрузка автовозами дилерам.",
    steps: ["Приёмка от ОТК", "Парковка", "Отгрузка"],
    prefix: "ГП",
    eq: [],
    params: { workers: 2 },
  },
};

export const PROC_GROUPS: { title: string; items: ProcKey[] }[] = [
  { title: "Логистика", items: ["kit_store", "logistics", "overhead", "floor_conv", "buffer", "splitter"] },
  { title: "Сварка", items: ["press", "jig", "robot_cell", "weld_line", "geometry"] },
  { title: "Окраска", items: ["pretreat", "sealer", "paint_booth", "oven", "paint_qc"] },
  { title: "Сборка", items: ["trim", "marriage", "final", "fluids"] },
  { title: "Контроль и отгрузка", items: ["alignment", "water_test", "test_track", "qc_gate", "rework", "fg_store"] },
];

export const KIND_PROC: Record<Kind, ProcKey> = {
  source: "kit_store",
  station: "weld_line",
  assembly: "marriage",
  inspection: "qc_gate",
  buffer: "buffer",
  splitter: "splitter",
  transport: "floor_conv",
  sink: "fg_store",
};

export function procEquipment(key: ProcKey, prefix?: string): EquipmentSpec[] {
  const p = PROCS[key];
  const pre = prefix ?? p.prefix;
  const out: EquipmentSpec[] = [];
  let i = 0;
  for (const g of p.eq) {
    for (let k = 0; k < g.n; k++) {
      i += 1;
      out.push({
        code: `${pre}-${String(i).padStart(2, "0")}`,
        critical: g.critical ?? !(g.type === "tool" && k > 0),
        mtbf_h: 90 + ((i * 37) % 140),
        mttr_min: 20 + ((i * 13) % 35),
        type: g.type,
      });
    }
  }
  return out;
}

const GUESS: [RegExp, ProcKey][] = [
  [/окрас|краск|покрас/i, "paint_booth"],
  [/сушк|печь/i, "oven"],
  [/фосфат|подготов/i, "pretreat"],
  [/герметик/i, "sealer"],
  [/сборк|монтаж/i, "final"],
  [/заливк|жидкост/i, "fluids"],
  [/доработ|ремонт/i, "rework"],
  [/развал|схожд/i, "alignment"],
  [/дожд|протечк/i, "water_test"],
  [/трек|обкат/i, "test_track"],
  [/свар/i, "weld_line"],
];

export function procOf(data: { proc?: string; kind: Kind; name?: string; area?: string }): ProcKey {
  if (data.proc && data.proc in PROCS) return data.proc as ProcKey;
  const base = KIND_PROC[data.kind];
  const text = `${data.name ?? ""} ${data.area ?? ""}`;
  for (const [re, key] of GUESS) if (re.test(text) && PROCS[key].kind === data.kind) return key;
  if (data.kind === "station" && data.area === "PAINT") return "paint_booth" in PROCS && PROCS.paint_booth.kind === "station" ? "paint_booth" : base;
  return base;
}
