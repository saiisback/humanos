import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
/** Flue 2.1 pins Pi .83, whose old catalog lacks V4.1's current model ID. */
export function humanOSDeepSeekProvider() {
  return createProvider({
    id: "deepseek",
    auth: {
      apiKey: {
        name: "DeepSeek API key",
        resolve: async () => {
          const apiKey = process.env.DEEPSEEK_API_KEY;
          if (!apiKey) throw new Error("DEEPSEEK_API_KEY required");
          return { auth: { apiKey } };
        },
      },
    },
    models: [
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        api: "openai-completions",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek",
        },
      },
    ],
    api: openAICompletionsApi(),
  });
}
