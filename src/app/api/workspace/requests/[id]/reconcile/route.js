import { settleWorkspaceTokens, WorkspaceError } from "@/lib/workspace.js";
import { requireWorkspaceSession, workspaceJson, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export async function POST(request, { params }) {
  try {
    await requireWorkspaceSession(request, true);
    const body = await workspaceJson(request);
    if (typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.length > 2000) throw new WorkspaceError("A reconciliation reason is required");
    return workspaceResponse({ request: await settleWorkspaceTokens((await params).id, body.actualTokens, "manual", body.reason.trim(), "owner") });
  } catch (error) { return workspaceError(error); }
}
