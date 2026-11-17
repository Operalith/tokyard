import { updateWorkspaceUser } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function PATCH(request, { params }) {
  try { await requireWorkspaceSession(request, true); return workspaceResponse({ user: await updateWorkspaceUser((await params).id, await workspaceJson(request)) }); }
  catch (error) { return workspaceError(error); }
}
