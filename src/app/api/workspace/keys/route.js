import { createWorkspaceKey, listWorkspaceKeys, WorkspaceError } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function GET(request) {
  try {
    const session = await requireWorkspaceSession(request);
    const userId = new URL(request.url).searchParams.get("userId") || session.userId;
    if (!userId || (session.role === "member" && userId !== session.userId)) throw new WorkspaceError("User access denied", 403);
    return workspaceResponse({ keys: await listWorkspaceKeys(userId) });
  } catch (error) { return workspaceError(error); }
}
export async function POST(request) {
  try {
    const session = await requireWorkspaceSession(request), body = await workspaceJson(request);
    const userId = session.role === "admin" ? body.userId : session.userId;
    if (session.role === "member" && body.userId && body.userId !== session.userId) throw new WorkspaceError("User access denied", 403);
    return workspaceResponse(await createWorkspaceKey(userId, body.name, session.userId || "owner"), 201);
  } catch (error) { return workspaceError(error); }
}
