import { revealWorkspaceKey, revokeWorkspaceKey, WorkspaceError } from "@/lib/workspace.js";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";
import { requireWorkspaceSession, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function POST(request, { params }) {
  try {
    const session = await requireWorkspaceSession(request), key = await getApiKeyById((await params).id);
    if (!key?.userId || (session.role === "member" && key.userId !== session.userId)) throw new WorkspaceError("Key not found", 404);
    return workspaceResponse(await revealWorkspaceKey(key.userId, key.id, session.userId || "owner"));
  } catch (error) { return workspaceError(error); }
}

export async function DELETE(request, { params }) {
  try {
    const session = await requireWorkspaceSession(request), key = await getApiKeyById((await params).id);
    if (!key?.userId || (session.role === "member" && key.userId !== session.userId)) throw new WorkspaceError("Key not found", 404);
    await revokeWorkspaceKey(key.userId, key.id, session.userId || "owner");
    return workspaceResponse({ success: true });
  } catch (error) { return workspaceError(error); }
}
