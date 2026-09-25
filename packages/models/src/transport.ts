export interface ModelConfig {
  apiKey: string;
  provider?: "direct" | "opencode";
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  log?: (event: Readonly<Record<string, string>>) => void;
}
export class ModelUnavailableError extends Error {
  constructor(
    public readonly code:
      | "MODEL_UNAVAILABLE"
      | "MODEL_AUTH_FAILED"
      | "MODEL_CREDITS_REQUIRED"
      | "MODEL_RATE_LIMITED"
      | "MODEL_TIMEOUT" = "MODEL_UNAVAILABLE",
  ) {
    super("Model integration unavailable");
    this.name = "ModelUnavailableError";
  }
}
export function validateConfig(config: ModelConfig) {
  if (typeof window !== "undefined") throw new ModelUnavailableError();
  if (
    !Number.isInteger(config.retries ?? 1) ||
    (config.retries ?? 1) < 0 ||
    (config.retries ?? 1) > 2
  )
    throw new TypeError("retries must be 0..2");
  if (
    !Number.isFinite(config.timeoutMs ?? 15000) ||
    (config.timeoutMs ?? 15000) < 1 ||
    (config.timeoutMs ?? 15000) > 60000
  )
    throw new TypeError("timeoutMs must be 1..60000");
}
export async function requestJson(
  config: ModelConfig,
  url: string,
  body: unknown,
): Promise<unknown> {
  if (!config.apiKey?.trim()) throw new ModelUnavailableError();
  let lastError = new ModelUnavailableError();
  for (let attempt = 0; attempt <= (config.retries ?? 1); attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await (config.fetch ?? fetch)(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok) {
            lastError = new ModelUnavailableError(
              response.status === 401 || response.status === 403
                ? "MODEL_AUTH_FAILED"
                : response.status === 402
                  ? "MODEL_CREDITS_REQUIRED"
                  : response.status === 429
                    ? "MODEL_RATE_LIMITED"
                    : "MODEL_UNAVAILABLE",
            );
            return {
              retry: response.status === 429 || response.status >= 500,
              data: null,
            };
          }
          const text = await response.text();
          if (text.length > 1_000_000) throw new Error();
          return { retry: false, data: JSON.parse(text) as unknown };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ModelUnavailableError("MODEL_TIMEOUT"));
          }, config.timeoutMs ?? 15000);
        }),
      ]);
      if (result.data !== null) return result.data;
      if (!result.retry) throw lastError;
    } catch (error) {
      if (controller.signal.aborted)
        throw new ModelUnavailableError("MODEL_TIMEOUT");
      if (error instanceof ModelUnavailableError) throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt < (config.retries ?? 1))
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  throw lastError;
}
