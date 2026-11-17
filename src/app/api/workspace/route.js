import { listWorkspaceUsers, listProfiles, getWorkspaceUser, getUserBudget, listWorkspaceKeys, listWorkspaceRequests } from "@/lib/workspace.js";
import { getProviderConnections } from "@/lib/localDb";
import { requireWorkspaceSession, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export const dynamic = "force-dynamic";
export async function GET(request) {
  try {
    const session = await requireWorkspaceSession(request);
    if (session.role === "member") {
      const [user, budget, keys, requests] = await Promise.all([getWorkspaceUser(session.userId), getUserBudget(session.userId), listWorkspaceKeys(session.userId), listWorkspaceRequests(session.userId)]);
      return workspaceResponse({ role: "member", user, budget, keys, requests });
    }
    const [users, profiles, requests, accounts] = await Promise.all([listWorkspaceUsers(), listProfiles(), listWorkspaceRequests(), getProviderConnections()]);
    const connections = accounts.map(c => ({ id: c.id, provider: c.provider, name: c.name || c.email || c.provider, isActive: c.isActive, status: c.testStatus || "unknown" }));
    return workspaceResponse({ role: "admin", users, profiles, requests, connections });
  } catch (error) { return workspaceError(error); }
}
