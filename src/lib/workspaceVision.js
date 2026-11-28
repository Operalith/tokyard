import { IMAGE_SIGNATURES } from "open-sse/config/mediaConfig.js";
import { WorkspaceError } from "./workspace.js";

const IMAGE_LIMIT = 4 * 1024 * 1024;
// OpenAI Images and vision: direct GPT-4o, detail=low, regardless of dimensions.
export const LOW_DETAIL_TOKENS = 85;
const fields = ["model", "messages", "max_tokens", "max_completion_tokens", "stream", "stream_options", "n"];
const only = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));

export function validateVision(body, path, info) {
  const reject = () => { throw new WorkspaceError("Unsupported metered image request: use one inline low-detail PNG or JPEG with openai/gpt-4o on Chat Completions", 403); };
  if (!["/v1/chat/completions", "/api/v1/chat/completions"].includes(path) || body.model !== "openai/gpt-4o" || info.provider !== "openai" || info.model !== "gpt-4o" || !only(body, fields) || !Array.isArray(body.messages)) reject();
  if (body.stream_options !== undefined && (!only(body.stream_options, ["include_usage"]) || typeof body.stream_options.include_usage !== "boolean")) reject();
  let imagePart;
  for (const message of body.messages) {
    if (!only(message, ["role", "content"]) || !["system", "developer", "user", "assistant"].includes(message.role)) reject();
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content) || message.role !== "user") reject();
    for (const part of message.content) {
      if (only(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string") continue;
      if (imagePart || !only(part, ["type", "image_url"]) || part.type !== "image_url" || !only(part.image_url, ["url", "detail"]) || ![undefined, "low"].includes(part.image_url.detail) || typeof part.image_url.url !== "string") reject();
      imagePart = part;
    }
  }
  const url = imagePart?.image_url.url;
  if (!url) reject();
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || match[2].length % 4) throw new WorkspaceError("Expected a base64 PNG or JPEG data URL", 400);
  if (Buffer.byteLength(match[2], "base64") > IMAGE_LIMIT) throw new WorkspaceError("Image exceeds 4 MiB", 413);
  const bytes = Buffer.from(match[2], "base64");
  const { sig } = IMAGE_SIGNATURES.find(s => s.mime === match[1]);
  if (bytes.toString("base64") !== match[2] || !sig.every((b, i) => bytes[i] === b)) throw new WorkspaceError("Invalid image encoding or MIME signature", 400);
  imagePart.image_url.detail = "low";
  return { url, imagePart };
}
