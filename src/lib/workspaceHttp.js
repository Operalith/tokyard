import { DASHBOARD_AUTH_COOKIE, getDashboardAuthSession } from "./auth/dashboardSession.js";
import { WorkspaceError } from "./workspace.js";

export async function requireWorkspaceSession(request, admin = false) {
  const cookie = request.cookies?.get?.(DASHBOARD_AUTH_COOKIE)?.value || (request.headers.get("cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${DASHBOARD_AUTH_COOKIE}=`))?.slice(DASHBOARD_AUTH_COOKIE.length + 1);
  const session = await getDashboardAuthSession(cookie);
  if (!session) throw new WorkspaceError("Sign in to continue", 401);
  if (admin && session.role !== "admin") throw new WorkspaceError("Administrator access required", 403);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    let sameOrigin = !origin;
    if (origin) {
      try {
        const source = new URL(origin), target = new URL(request.url);
        // Next's internal URL can use localhost behind a public Host header.
        target.host = request.headers.get("host") || target.host;
        if (process.env.AUTH_COOKIE_SECURE === "true") target.protocol = "https:";
        sameOrigin = source.origin === target.origin;
      } catch { sameOrigin = false; }
    }
    if (request.headers.get("sec-fetch-site") === "cross-site" || !sameOrigin) throw new WorkspaceError("Cross-origin request refused", 403);
  }
  return session;
}

export async function workspaceJson(request) {
  let data;
  try { data = await request.json(); } catch { throw new WorkspaceError("Invalid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new WorkspaceError("Expected a JSON object");
  return data;
}

export function workspaceResponse(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function workspaceError(error) {
  if (error instanceof WorkspaceError) return workspaceResponse({ error: error.message }, error.status);
  console.error("[TokYard] Workspace operation failed", error?.message);
  return workspaceResponse({ error: "Workspace operation failed" }, 500);
}
