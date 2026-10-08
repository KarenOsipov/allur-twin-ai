import { session } from "@/shared/auth/session";
import { sim } from "@/shared/sim/store";

export const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

type Query = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

async function send(path: string, init: { method?: string; body?: unknown; query?: Query }): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = session.get()?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const sandbox = sim.sandboxId();
  if (sandbox && !path.startsWith("/sandbox")) headers["X-Sandbox"] = sandbox;
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, init.query), { method: init.method ?? "GET", headers, body });
  } catch {
    throw new ApiError(0, "network", "Сервер недоступен. Проверьте, что бэкенд запущен.");
  }
  if (res.status === 401 && token) session.clear();
  if (res.status === 404 && sandbox && !path.startsWith("/sandbox")) sim.exit();
  if (!res.ok) {
    let parsed: ErrorBody | null = null;
    try {
      parsed = (await res.json()) as ErrorBody;
    } catch {
    }
    throw new ApiError(res.status, parsed?.error.code ?? "http", parsed?.error.message ?? `Ошибка ${res.status}`, parsed?.error.details);
  }
  return res;
}

export async function request<T>(path: string, init: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getBlob(path: string): Promise<Blob> {
  return (await send(path, {})).blob();
}

export async function download(path: string, filename: string, query?: Query): Promise<void> {
  const res = await send(path, { query });
  const disposition = res.headers.get("content-disposition") ?? "";
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"]+)"/.exec(disposition)?.[1];
  filename = plain || (utf && decodeURIComponent(utf)) || filename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
