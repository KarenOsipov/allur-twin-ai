import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { LoginPage } from "@/features/auth/LoginPage";
import { AppShell } from "@/features/shell/AppShell";
import { can, homeOf, session, useSession } from "@/shared/auth/session";

function RequireSession() {
  const s = useSession();
  const location = useLocation();
  if (!s) return <Navigate to="/login" replace state={session.wasLoggedOut() ? null : { from: location.pathname }} />;
  return <Outlet />;
}

function RequireView() {
  const s = useSession();
  if (!can(s, "view")) return <Navigate to={homeOf(s)} replace />;
  return <Outlet />;
}

function RequireAdmin() {
  const s = useSession();
  if (!can(s, "manage_data")) return <Navigate to="/app" replace />;
  return <Outlet />;
}

const page = (load: () => Promise<Record<string, unknown>>, name: string) => async () => ({ Component: (await load())[name] as React.ComponentType });

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireSession />,
    children: [
      { path: "/work", lazy: page(() => import("@/features/worker/WorkerPage"), "WorkerPage") },
      {
        element: <RequireView />,
        children: [
          {
            path: "/app",
            element: <AppShell />,
            children: [
              { index: true, lazy: page(() => import("@/features/floor/FloorPage"), "FloorPage") },
              { path: "shift", lazy: page(() => import("@/features/shift/ShiftPage"), "ShiftPage") },
              { path: "kpi", lazy: page(() => import("@/features/kpi/KpiPage"), "KpiPage") },
              { path: "quality", lazy: page(() => import("@/features/quality/QualityPage"), "QualityPage") },
              { path: "forecast", lazy: page(() => import("@/features/forecast/ForecastPage"), "ForecastPage") },
              { path: "sim", lazy: page(() => import("@/features/sim/SimPage"), "SimPage") },
              { path: "scenarios", element: <Navigate to="/app/sim" replace /> },
              { path: "ai", lazy: page(() => import("@/features/assistant/AiPage"), "AiPage") },
              { path: "economics", lazy: page(() => import("@/features/economics/EconomicsPage"), "EconomicsPage") },
              { path: "journal", lazy: page(() => import("@/features/journal/JournalPage"), "JournalPage") },
              { path: "builder", lazy: page(() => import("@/features/builder/BuilderPage"), "BuilderPage") },
              { path: "incidents", lazy: page(() => import("@/features/incidents/IncidentsPage"), "IncidentsPage") },
              { path: "data", lazy: page(() => import("@/features/data/DataPage"), "DataPage") },
              {
                element: <RequireAdmin />,
                children: [{ path: "staff", lazy: page(() => import("@/features/staff/StaffPage"), "StaffPage") }],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/app" replace /> },
]);
