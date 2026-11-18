import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";

/**
 * Adjust max_tokens based on request context
 * @param {object} body - Request body
 * @param {number} [ceiling=DEFAULT_MAX_TOKENS] - Upper bound for max_tokens.
 *   Callers with model context (e.g. openai-to-claude) pass the model's real
 *   maxOutput so high-output models (Opus 4.8 = 128000) aren't pre-clamped to
 *   the conservative 64000 default before the model-aware step sees them.
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, ceiling = DEFAULT_MAX_TOKENS) {
  let maxTokens = body.max_tokens || DEFAULT_MAX_TOKENS;

  // Auto-increase for tool calling to prevent truncated arguments (min never above max)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement)
  // Claude API requires strictly greater, so add buffer instead of using the
  // ceiling which could equal budget_tokens when budget_tokens >= ceiling
  if (body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }

  // Never exceed the ceiling
  if (maxTokens > ceiling) maxTokens = ceiling;

  return maxTokens;
}

/**
 * Hard output ceiling for metered requests, applied to the final upstream body:
 * translators raise max_tokens for tools/thinking, so a pre-translation cap does not hold.
 * Only lowers fields already present; a provider that dropped its cap stays uncapped.
 */
export function capOutputTokens(body, cap) {
  if (!body || typeof body !== "object" || !Number.isSafeInteger(cap) || cap < 1) return body;
  for (const target of [body, body.request]) {
    if (!target || typeof target !== "object") continue;
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      if (typeof target[field] === "number" && target[field] > cap) target[field] = cap;
    }
    const config = target.generationConfig;
    if (config && typeof config === "object") {
      if (typeof config.maxOutputTokens === "number" && config.maxOutputTokens > cap) config.maxOutputTokens = cap;
      const budget = config.thinkingConfig?.thinkingBudget;
      if (typeof budget === "number" && (budget < 0 || budget > cap)) config.thinkingConfig.thinkingBudget = cap;
    }
  }
  // Claude requires budget_tokens (min 1024) < max_tokens; drop thinking when the cap leaves no room.
  const thinking = body.thinking;
  if (typeof thinking?.budget_tokens === "number" && typeof body.max_tokens === "number" && thinking.budget_tokens >= body.max_tokens) {
    const budget = Math.max(1024, body.max_tokens - 1024);
    if (budget < body.max_tokens) thinking.budget_tokens = budget;
    else delete body.thinking;
  }
  return body;
}

