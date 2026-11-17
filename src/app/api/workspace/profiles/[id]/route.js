import { saveProfile } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function PATCH(request, { params }) {
  try { await requireWorkspaceSession(request, true); return workspaceResponse({ profile: await saveProfile(await workspaceJson(request), (await params).id) }); }
  catch (error) { return workspaceError(error); }
}
