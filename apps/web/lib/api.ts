export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = data as { error?: { message?: string } };
    throw new Error(
      error.error?.message ??
        `Request failed (${response.status}). Please retry.`,
    );
  }
  return data as T;
}
