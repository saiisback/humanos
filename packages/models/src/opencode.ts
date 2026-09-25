/** Official OpenCode Zen routes; keys are used only by server-side callers. */
export const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_DEEPSEEK_MODEL = "deepseek-v4.1-flash";
export const OPENCODE_JEV_MODEL = "jev-1.13";
export const OPENCODE_CHAT_ENDPOINT = `${OPENCODE_BASE_URL}/chat/completions`;
export const OPENCODE_SYSTEMONE_ENDPOINT = `${OPENCODE_BASE_URL}/systemone`;
export const WORKFLOW_JEV_MODEL = OPENCODE_JEV_MODEL;
export const CONTENT_MODEL = OPENCODE_DEEPSEEK_MODEL;

export function secureModelEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new TypeError(
      "Model endpoint must be HTTPS without credentials or fragment",
    );
  return url.href;
}
