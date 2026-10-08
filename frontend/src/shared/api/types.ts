export type Role = "admin" | "director" | "supervisor" | "worker";
export type Permission = "view" | "operate" | "shift" | "report" | "manage_data" | "manage_users";
export type Status = "ok" | "warning" | "critical";
export type AreaState = "run" | "starved" | "blocked" | "down" | "off";
export type EqStatus = "run" | "idle" | "down" | "maint" | "off";

export interface StaffMember {
  id: number;
  name: string;
  position: string;
  role: Role;
  role_name: string;
  area: string | null;
  login: string | null;
  demo_pin: string | null;
}

export interface StaffFull extends StaffMember {
  status: "active" | "pending" | "rejected";
  request_note: string | null;
  active: boolean;
  locked_until: string | null;
  last_login: string | null;
  created_at: string;
}

export interface LoginOut extends StaffMember {
  token: string;
  expires_at: number;
  supabase_auth_synced?: boolean;
}

export interface UsersOut {
  demo: boolean;
  registration: boolean;
  areas: { code: string; name: string }[];
  users: StaffMember[];
}

export interface Me {
  id: number;
  role: Role;
  name: string;
  position: string;
  area: string | null;
  expires_at: number;
  permissions: Permission[];
}

export interface Targets {
  oee_pct: number;
  defect_pct: number;
  critical_downtime_min_per_day: number;
  month_output: number;
  shift_plan: number;
}

export interface PlantArea {
  code: string;
  name: string;
  kind: "store" | "process" | "inspection";
  line: string | null;
  cycle_s: number;
  buffer_after: number;
  x: number;
}

export interface PlantEquipment {
  code: string;
  name: string;
  kind: string;
  area: string;
  critical: boolean;
  mtbf_h: number;
  modes: string[];
}

export interface Plant {
  name: string;
  takt_s: number;
  targets: Targets;
  shifts: { number: number; start: string; end: string }[];
  areas: PlantArea[];
  equipment: PlantEquipment[];
  models: { code: string; name: string; month_plan: number }[];
  economics: Economics;
}

export interface Economics {
  margin_per_car_kzt: number;
  rework_cost_kzt: number;
  labor_rate_kzt_h: number;
  overtime_rate_kzt_h: number;
  line_staff: number;
  economy: Record<string, number>;
}

export interface Body {
  vin: string;
  model: string;
  color: string;
  hex: string;
  defect: boolean;
}

export interface FloorArea {
  code: string;
  name: string;
  kind: "store" | "process" | "inspection";
  state?: AreaState;
  progress?: number;
  current?: Body | null;
  output?: number;
  defects?: number;
  oee?: number | null;
  buffer?: Body[];
  buffer_cap?: number;
  time?: { run: number; down: number; starved: number; blocked: number };
  stock?: number;
  delayed?: boolean;
}

export interface FloorEquipment {
  code: string;
  area: string;
  status: EqStatus;
  reason: string | null;
  since: string | null;
  until: string | null;
  critical: boolean;
}

export interface Floor {
  ready: boolean;
  clock: string;
  speed: number;
  paused: boolean;
  working: boolean;
  shift: { number: number | null; start: string | null; end: string | null; progress: number };
  areas: FloorArea[];
  equipment: FloorEquipment[];
  kpi: {
    finished: number;
    plan_to_now: number;
    shift_plan: number;
    forecast_shift: number | null;
    defect_pct: number;
    rework: number;
    down_now: number;
    bottleneck: string | null;
    models: Record<string, number>;
  };
  recent: { vin: string; model: string; at: string }[];
  kits: number;
}

export interface Check {
  key: string;
  label: string;
  value: number;
  target: number;
  op: "≥" | "≤";
  unit: string;
  status: Status;
}

export interface LineKpi {
  area: string;
  line: string;
  name: string;
  plan: number;
  fact: number;
  defects: number;
  defect_pct: number;
  run_hours: number;
  shifts: number;
  oee: number;
  availability: number;
  performance: number;
  quality: number;
}

export interface PeriodKpi {
  start: string;
  end: string;
  days: number;
  output: number;
  plan: number;
  plan_pct: number;
  oee: number;
  defect_pct: number;
  downtime_unplanned_min: number;
  downtime_planned_min: number;
  critical_downtime_breaches: { day: string; equipment: string; minutes: number }[];
  worst_equipment_day: { day: string; equipment: string; minutes: number } | null;
  lines: LineKpi[];
  checks: Check[];
}

export interface DailyPoint {
  day: string;
  output: number;
  plan: number;
  oee: number | null;
  defect_pct: Record<string, number>;
  downtime_min: number;
}

export interface ParetoRow {
  key: string;
  minutes: number;
  count: number;
  planned: boolean;
  share: number;
  cumulative: number;
  equipment: string[];
}

export interface MonthProgress {
  month: string;
  models: { model: string; plan: number; fact: number }[];
  models_plan_total: number;
  target: number;
  fact: number;
}

export interface Overview {
  period: PeriodKpi & { requested_days: number; clipped: boolean; work_days: number };
  previous: Pick<PeriodKpi, "output" | "plan" | "plan_pct" | "oee" | "defect_pct" | "downtime_unplanned_min"> & { available: boolean; work_days: number };
  daily: DailyPoint[];
  pareto_reason: ParetoRow[];
  pareto_equipment: ParetoRow[];
  month: MonthProgress;
  targets: Targets;
}

export interface MonthForecast {
  available: boolean;
  month: string;
  target: number;
  fact_to_date: number;
  expected: number;
  p10: number;
  p90: number;
  probability: number;
  gap: number;
  daily_rate: number;
  daily_sd: number;
  need_daily: number | null;
  capacity_daily: number;
  workdays_left: number;
  workdays_total: number;
  series: { day: string; fact?: number; forecast?: number; low?: number; high?: number }[];
}

export interface EquipmentRisk {
  code: string;
  name: string;
  area: string;
  critical: boolean;
  probability: number;
  level: "high" | "medium" | "low";
  failures_90: number;
  last_failure: string | null;
  days_since_last: number | null;
  next_failure: string | null;
  intervals: number[];
  main_reason: string | null;
  mttr_min: number | null;
  factors: string[];
  expected_loss_kzt: number;
  overdue: boolean;
}

export interface QualityArea {
  area: string;
  name: string;
  level: number;
  last: number;
  slope_week: number;
  forecast_7: number;
  target: number;
  status: Status;
  days_over: number;
  crossing: string | null;
  series: { day: string; pct: number }[];
  causes: { kind: string; strength: number; text: string; equipment?: string }[];
}

export interface Bottleneck {
  shifts: number;
  constraint: string;
  lines: {
    area: string;
    name: string;
    share: number;
    good_capacity_per_shift: number;
    rate_per_hour: number;
    ideal_per_hour: number;
    cycle_s: number;
    takt_s: number;
  }[];
}

export interface Anomaly {
  day: string;
  shift: number;
  score: number;
  output: number;
  drivers: string[];
  events: string[];
}

export interface Recommendation {
  id: string;
  priority: "critical" | "high" | "medium";
  title: string;
  problem: string;
  action: string;
  effect_kzt_month: number;
  area: string | null;
  equipment: string | null;
  link: string | null;
}

export interface Insights {
  forecast: MonthForecast;
  risks: EquipmentRisk[];
  risk_model: { model: string; horizon_days: number; trained_on: number; positives: number; auc: number | null };
  quality: QualityArea[];
  bottleneck: Bottleneck;
  anomalies: Anomaly[];
  recommendations: Recommendation[];
}

export interface Incident {
  id: number;
  created_at: string;
  kind: "equipment" | "quality" | "supply" | "kpi" | "safety" | "other";
  severity: "critical" | "warning" | "info";
  area: string | null;
  equipment: string | null;
  title: string;
  details: string;
  status: "open" | "ack" | "resolved";
  acked_by: string | null;
  resolved_at: string | null;
  downtime_min: number | null;
  cost_kzt: number | null;
  source?: "auto" | "worker" | "manual";
  reported_by?: string | null;
  line_stopped?: boolean;
  resolved_by?: string | null;
  resolution?: string | null;
  simulated?: boolean;
}

export interface IncidentList {
  items: Incident[];
  total: number;
  active: number;
  cost_kzt: number;
  simulated?: boolean;
}

export interface ScenarioInput {
  stops: { equipment: string; at_min: number; minutes: number; shift: number }[];
  cycle_factor: Record<string, number>;
  buffer_override: Record<string, number>;
  defect_pct: Record<string, number>;
  supply_delay: [number, number] | null;
  overtime_min: number;
}

export interface Preset {
  id: string;
  title: string;
  text: string;
  scenario: Partial<ScenarioInput>;
}

export interface SimSummary {
  finished: number;
  finished_min: number;
  finished_max: number;
  defects: number;
  downtime_min: number;
  areas: Record<string, number>;
  bottleneck: string | null;
  timeline: number[];
}

export interface WhatIfResult {
  baseline: SimSummary;
  scenario: SimSummary;
  delta: { cars: number; defects: number; downtime_min: number; effect_kzt_day: number; effect_kzt_month: number };
  runs: number;
  assumptions: { margin_per_car_kzt: number; rework_cost_kzt: number; workdays_month: number };
}

export interface DataCheck {
  level: "critical" | "warning" | "info";
  title: string;
  text: string;
}

export interface DataSummary {
  first_day: string | null;
  last_day: string | null;
  days: number;
  rows: Record<string, number>;
  production_by_source: Record<string, number>;
  imports: { id: number; created_at: string; filename: string; role: string; tables?: { title: string; rows: number }[]; errors?: string[] }[];
}

export interface ImportResult {
  filename: string;
  tables: { kind: string; title: string; rows: number }[];
  rows: number;
  targets: Record<string, number>;
  notes: string[];
  errors: string[];
  review: { level: "warning" | "info"; text: string }[];
  changes: string[];
}

export interface Answer {
  text: string;
  links: { label: string; to: string }[];
  engine: "local" | "llm";
  topic: string;
}

export interface ShiftForecast {
  available: boolean;
  now: string;
  end: string;
  minutes_left: number;
  finished_now: number;
  expected: number;
  low: number;
  high: number;
  plan: number;
  probability: number;
  defects_expected: number;
  downtime_expected_min: number;
  runs: number;
  timeline: { t: string; mean: number; low: number; high: number }[];
}

export type SimEventKind = "failure" | "supply_delay" | "defects" | "slowdown";

export interface SimEventInput {
  kind: SimEventKind;
  at_min: number;
  minutes: number;
  equipment?: string | null;
  area?: string | null;
  value?: number | null;
  reason?: string | null;
}

export interface SimLogEntry {
  t: string;
  kind: "down" | "up" | "already_down" | "supply" | "supply_end" | "defects" | "defects_end" | "slowdown" | "slowdown_end" | "shift_end";
  title: string;
  area: string | null;
  user: boolean;
  equipment?: string;
  severity?: "critical" | "warning" | "info";
}

export interface SandboxSummary {
  cars: { scenario: number; baseline: number; lost: number };
  mean: { scenario: number; baseline: number; lost: number; lost_low: number; lost_high: number; runs: number };
  downtime_min: { scenario: number; baseline: number };
  defects: { scenario: number; baseline: number; extra: number };
  plan: { shifts: number; cars: number };
  money_kzt: number;
  margin_per_car: number;
  verdict: string;
}

export interface SandboxResult {
  id: string;
  horizon: "shift" | "day";
  start: string;
  end: string;
  frame_every_s: number;
  frames: Floor[];
  log: SimLogEntry[];
  series: { scenario: { t: string; cars: number }[]; baseline: { t: string; cars: number }[] };
  summary: SandboxSummary;
  actions: (SimEventInput & { title: string })[];
}

export type JournalCategory = "auth" | "control" | "incident" | "shift" | "simulation" | "scenario" | "data" | "assistant" | "export" | "builder" | "users" | "system";

export interface JournalEntry {
  id: number;
  at: string;
  plant_time: string | null;
  category: JournalCategory;
  category_name: string;
  action: string;
  severity: "info" | "warning" | "critical";
  actor: string;
  title: string;
  details: Record<string, string | number | boolean>;
}

export interface JournalList {
  items: JournalEntry[];
  total: number;
  counts: Record<string, number>;
  actors: string[];
  today: number;
  today_important: number;
  categories: Record<JournalCategory, string>;
}

export interface ShiftSession {
  id: number;
  day: string;
  shift: number;
  supervisor: string;
  started_at: string;
  closed_at: string | null;
  plan: number;
  staff: number | null;
  note: string;
  summary: {
    finished?: number;
    plan?: number;
    plan_to_now?: number;
    defect_pct?: number;
    rework?: number;
    down_min?: number;
    incidents?: number;
    reports?: number;
    cost_kzt?: number;
    closed_by?: string;
    start?: { staff_by_area: Record<string, number>; checklist: string[]; missing: string[] } | null;
  };
}

export interface ShiftPlanSetup {
  plan: number;
  supervisor: string | null;
  staff: Record<string, number>;
}

export interface ShiftSetup {
  shifts: Record<string, ShiftPlanSetup>;
  checklist: string[];
  schedule: { number: number; start: string; end: string; hours: number }[];
  workdays: string[];
  areas: { code: string; name: string; store: boolean }[];
  supervisors: { name: string; position: string }[];
}

export interface ShiftInfo {
  working: boolean;
  day?: string;
  number?: number;
  start?: string;
  end?: string;
  plan?: number;
  session: ShiftSession | null;
  previous: ShiftSession | null;
}

export type ProblemKind = "equipment" | "supply" | "quality" | "safety" | "other";

export interface ProblemInput {
  kind: ProblemKind;
  area?: string | null;
  equipment?: string | null;
  text?: string;
  line_stopped?: boolean;
  minutes?: number;
}

export interface ProblemOut {
  incident: Incident;
  applied: string | null;
  supervisor: string | null;
}

export interface WorkerOverview {
  area: FloorArea & { name: string };
  equipment: (FloorEquipment & { name: string })[];
  clock: string;
  working: boolean;
  shift: Floor["shift"];
  kpi: { finished: number; plan_to_now: number; shift_plan: number };
  supervisor: string | null;
  kinds: Record<ProblemKind, string>;
  areas: { code: string; name: string }[];
}

export interface ImpactOption {
  id: string;
  title: string;
  action: string;
  cars: number;
  defects: number;
  effect_kzt: number;
  cost_kzt: number;
  net_kzt: number;
}

export interface Impact {
  available: boolean;
  cost_per_min_kzt: number;
  takt_min: number;
  plan: number;
  note?: string;
  now?: string;
  end?: string;
  minutes_left?: number;
  minutes?: number;
  line_stops?: boolean;
  lost_cars?: number;
  extra_defects?: number;
  lost_kzt?: number;
  per_min_kzt?: number;
  plan_expected?: number;
  plan_expected_range?: [number, number];
  plan_without?: number;
  plan_probability?: number;
  runway?: {
    downstream?: { area: string; name: string; bodies: number; minutes: number };
    upstream?: { area: string; name: string; free: number | null; minutes: number | null };
  };
  options?: ImpactOption[];
  timeline?: { labels: string[]; as_is: number[]; without: number[] };
  runs?: number;
  summary?: string;
  incident?: Incident;
  problem?: { kind: string; minutes: number; line_stopped: boolean };
}

export interface AdviceItem {
  id: string;
  title: string;
  why: string;
  result: string;
  valuation: string;
  cars_day: number;
  cars_low: number;
  cars_high: number;
  defects_day: number;
  effect_kzt_month: number;
  cost_kzt_month: number;
  capex_kzt: number;
  cost_note: string;
  net_kzt_month: number;
  payback_months: number | null;
  confidence: string;
  area: string | null;
  equipment: string | null;
  scenario: Partial<ScenarioInput> | null;
  worth_it: boolean;
}

export interface AdviceOut {
  status: "ready" | "computing";
  items: AdviceItem[];
  computed_at: string | null;
  stale: boolean;
  error: string | null;
}

export interface PlantEconomy {
  period: { start: string; end: string; days: number; shifts: number; hours: number };
  month: {
    output: number;
    plan: number;
    margin_income_kzt: number;
    payroll_kzt: number;
    overhead_kzt: number;
    losses_kzt: number;
    result_kzt: number;
  };
  plan_pct: number;
  cost_per_car_kzt: number;
  minute_kzt: number;
  minute_cost_kzt: number;
  losses: {
    shortfall_cars: number;
    shortfall_kzt: number;
    downtime_min: number;
    downtime_stops: number;
    downtime_cars: number;
    downtime_kzt: number;
    planned_min: number;
    defects: number;
    defects_excess: number;
    rework_kzt: number;
    rework_excess_kzt: number;
  };
  losses_total_kzt: number;
  areas: { area: string; name: string; down_min: number; stops: number; defects: number; downtime_kzt: number; rework_kzt: number; total_kzt: number }[];
  equipment: { code: string; name: string; area: string; down_min: number; stops: number; reason: string; kzt_month: number }[];
  reasons: { reason: string; down_min: number; stops: number; kzt_month: number }[];
  daily: { day: string; output: number; plan: number; margin_kzt: number; loss_kzt: number }[];
  potential: { id: string; title: string; text: string; kzt_month: number; cost_kzt_month?: number }[];
  assumptions: { key: string; label: string; value: number; default: number }[];
  basis: {
    margin_per_car_kzt: number;
    rework_cost_kzt: number;
    labor_rate_kzt_h: number;
    overtime_rate_kzt_h: number;
    line_staff: number;
    workdays_month: number;
    shift_hours: number;
    takt_s: number;
  };
}

export interface ParamArea {
  code: string;
  name: string;
  kind: string;
  base: { cycle_s: number; buffer: number; defect_pct: number };
  value: { cycle_s: number; buffer: number; defect_pct: number };
  changed: string[];
  has_buffer: boolean;
  has_defects: boolean;
}

export interface ParamEquipment {
  code: string;
  name: string;
  kind: string;
  area: string;
  critical: boolean;
  base: { mtbf_h: number; mttr_min: number };
  value: { mtbf_h: number; mttr_min: number };
  changed: string[];
}

export interface LineParams {
  areas: ParamArea[];
  equipment: ParamEquipment[];
  supply: { base: { every_min: number; size: number }; value: { every_min: number; size: number } };
  changed: boolean;
  changes?: { what: string; before: number; after: number }[];
}

export interface LayoutMeta {
  id: number;
  name: string;
  nodes: number;
  equipment: number;
  author: string;
  updated_at: string;
  floor?: boolean;
}

export interface FloorNodeMap {
  area: string;
  role: "area" | "buffer";
}

export interface FloorLayout {
  id: number | null;
  name?: string;
  data?: { nodes: unknown[]; edges: unknown[] };
  updated_at?: string;
  author?: string;
  map?: Record<string, FloorNodeMap>;
  standard?: boolean;
  changes?: { what: string; before: number; after: number }[];
  notes?: string[];
}

export interface ChatMessage {
  id: number;
  channel: string;
  at: string;
  author_id: number | null;
  author: string;
  position: string;
  role: Role | "system";
  kind: "text" | "system" | "alert";
  text: string;
  ref: { incident?: number; photo?: { id: number; w: number | null; h: number | null } } | null;
  reply_to: { id: number; author: string; text: string } | null;
  edited_at: string | null;
  deleted: boolean;
}

export interface ChatPeer {
  id: number;
  name: string;
  position: string;
  role: Role;
  area: string | null;
  online: boolean;
}

export interface ChatChannel {
  id: string;
  kind: "channel" | "dm";
  name: string;
  hint: string;
  area?: string;
  peer?: ChatPeer;
  last: ChatMessage | null;
  unread: number;
  read_id: number;
  peer_read_id?: number;
}

export interface DbStatus {
  configured: boolean;
  mode: "primary" | "local";
  label: string;
  active: string;
  primary_ok: boolean | null;
  since: string;
  last_mirror: string | null;
  last_error: string | null;
  outage: boolean;
  needs_decision: boolean;
  local_kind: string;
  counts?: Record<string, number>;
  demo_mode?: boolean;
  supabase_auth?: boolean;
  supabase_service?: boolean;
  supabase_url?: string | null;
}

export interface SystemConfig {
  version: string;
  demo: boolean;
  environment: string;
  supabase: {
    enabled: boolean;
    url: string | null;
    anon_key: string | null;
    is_primary: boolean;
    primary_ok: boolean | null;
    mode: string;
    configured: boolean;
  };
}
