import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession.js";
import { checkLock, recordFail, recordSuccess } from "@/lib/auth/loginLimiter.js";
import { changeWorkspacePassword, WorkspaceError } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function POST(request) {
  try {
    const session = await requireWorkspaceSession(request);
    if (session.role !== "member") throw new WorkspaceError("Sign in as a member to change your own password", 403);
    const input = await workspaceJson(request);
    if (Object.keys(input).some(key => !["currentPassword", "newPassword", "confirmPassword"].includes(key))) throw new WorkspaceError("Unexpected password-change fields");
    if (input.newPassword !== input.confirmPassword) throw new WorkspaceError("New passwords do not match");
    const cookieStore = await cookies();
    const bucket = `password-change:${session.userId}`;
    const lock = checkLock(bucket);
    if (lock.locked) return Response.json({ error: `Too many password-change attempts. Try again in ${lock.retryAfter}s.` }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(lock.retryAfter) } });
    // Count before bcrypt yields so parallel guesses cannot bypass the lockout.
    recordFail(bucket);
    await changeWorkspacePassword(session.userId, input.currentPassword, input.newPassword, session.authVersion);
    recordSuccess(bucket);
    clearDashboardAuthCookie(cookieStore);
    return workspaceResponse({ success: true });
  } catch (error) { return workspaceError(error); }
}
