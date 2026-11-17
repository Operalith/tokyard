import { createWorkspaceUser, listWorkspaceUsers } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function GET(request) {
  try { await requireWorkspaceSession(request, true); return workspaceResponse({ users: await listWorkspaceUsers() }); }
  catch (error) { return workspaceError(error); }
}
export async function POST(request) {
  try { await requireWorkspaceSession(request, true); return workspaceResponse({ user: await createWorkspaceUser(await workspaceJson(request)) }, 201); }
  catch (error) { return workspaceError(error); }
}
