export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, body?: unknown, options?: { idempotencyKey?: string }): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`/api${path}`, {
      signal: controller.signal,
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
            body: JSON.stringify(body),
          }),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      data = null;
    }
    if (!response.ok) {
      const error = data as {
        error?: { code?: string; message?: string };
      } | null;
      throw new ApiError(
        response.status,
        error?.error?.code ?? "HTTP_ERROR",
        error?.error?.message ??
          `Request failed (${response.status}). Please retry.`,
      );
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted)
      throw new ApiError(
        408,
        "REQUEST_TIMEOUT",
        "The request timed out. Refresh the task to check its status before retrying; it may still be processing.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
