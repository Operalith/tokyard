import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getProviderConnections } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { requireWorkspaceSession, workspaceResponse, workspaceError } from "@/lib/workspaceHttp.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    await requireWorkspaceSession(request, true);
    const connections = (await getProviderConnections()).filter(c => c.isActive !== false && c.provider !== "systemone");
    if (!connections.length) return workspaceResponse({ groups: [] });
    const providers = new Map(connections.map(c => {
      const alias = (c.providerSpecificData?.prefix || getProviderAlias(c.provider) || c.provider).trim();
      return [alias, { name: AI_PROVIDERS[c.provider]?.name || c.name || alias, alias, models: [] }];
    }));
    for (const model of await buildModelsList(["llm"])) {
      if (model.owned_by === "combo" || model.id.length > 256) continue;
      const group = providers.get(model.owned_by);
      if (group && model.id.startsWith(`${group.alias}/`)) group.models.push(model.id);
    }
    const groups = [...providers.values()].filter(g => g.models.length);
    for (const group of groups) group.models.sort((a, b) => a.localeCompare(b));
    groups.sort((a, b) => a.name.localeCompare(b.name));
    return workspaceResponse({ groups });
  } catch (error) { return workspaceError(error); }
}
