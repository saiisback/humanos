export interface ModelConfig {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  log?: (event: Readonly<Record<string, string>>) => void;
}
export class ModelUnavailableError extends Error {
  constructor() {
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
          if (!response.ok)
            return {
              retry: response.status === 429 || response.status >= 500,
              data: null,
            };
          const text = await response.text();
          if (text.length > 1_000_000) throw new Error();
          return { retry: false, data: JSON.parse(text) as unknown };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ModelUnavailableError());
          }, config.timeoutMs ?? 15000);
        }),
      ]);
      if (result.data !== null) return result.data;
      if (!result.retry) throw new ModelUnavailableError();
    } catch (error) {
      if (error instanceof ModelUnavailableError || controller.signal.aborted)
        throw new ModelUnavailableError();
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt < (config.retries ?? 1))
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  throw new ModelUnavailableError();
}
