import { saveProfile, listProfiles } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function GET(request) {
  try { await requireWorkspaceSession(request, true); return workspaceResponse({ profiles: await listProfiles() }); }
  catch (error) { return workspaceError(error); }
}
export async function POST(request) {
  try { await requireWorkspaceSession(request, true); return workspaceResponse({ profile: await saveProfile(await workspaceJson(request)) }, 201); }
  catch (error) { return workspaceError(error); }
}
