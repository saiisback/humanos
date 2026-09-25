import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AgentConfig } from "./config.js";
export function createProtectedApp(
  config: AgentConfig,
  router: Hono,
  transport: typeof fetch = fetch,
): Hono {
  const app = new Hono();
  app.use(
    "/agents/humanos/*",
    cors({
      origin: config.webOrigin,
      credentials: true,
      exposeHeaders: [
        "stream-next-offset",
        "stream-up-to-date",
        "stream-cursor",
      ],
      allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.use("/agents/humanos/*", async (c, next) => {
    const cookie = c.req.header("cookie");
    if (!cookie)
      return c.json(
        { error: { code: "UNAUTHENTICATED", message: "Sign in to HumanOS." } },
        401,
      );
    const match = /^\/agents\/humanos\/([^/]+)(?:\/|$)/.exec(c.req.path);
    if (!match?.[1])
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Mission is required." } },
        400,
      );
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Invalid mission ID." } },
        400,
      );
    }
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id))
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Invalid mission ID." } },
        400,
      );
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== config.webOrigin)
        return c.json(
          { error: { code: "FORBIDDEN", message: "Origin is not allowed." } },
          403,
        );
      if (c.req.path.endsWith("/abort")) {
        const body = await c.req.raw.clone().text();
        if (body.trim() && body.trim() !== "{}")
          return c.json(
            {
              error: {
                code: "INVALID_REQUEST",
                message: "Abort accepts no request data.",
              },
            },
            400,
          );
      }
      if (!c.req.path.endsWith("/abort")) {
        let body: unknown;
        try {
          body = await c.req.raw.clone().json();
        } catch {
          return c.json(
            {
              error: {
                code: "INVALID_REQUEST",
                message: "JSON prompt required.",
              },
            },
            400,
          );
        }
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          "initialData" in body ||
          !("kind" in body) ||
          body.kind !== "user" ||
          !("body" in body) ||
          typeof body.body !== "string" ||
          body.body.length > 10000 ||
          Object.keys(body).some((k) => !["kind", "body"].includes(k))
        )
          return c.json(
            {
              error: {
                code: "INVALID_REQUEST",
                message: "Only a user text prompt is accepted.",
              },
            },
            400,
          );
      }
    }
    try {
      const response = await transport(
        new URL(
          `/api/internal/conversations/${encodeURIComponent(id)}`,
          config.apiUrl,
        ),
        {
          headers: { cookie },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Conversation is unavailable.",
            },
          },
          response.status === 401
            ? 401
            : response.status === 404
              ? 404
              : response.status === 403
                ? 403
                : 503,
        );
      const data = (await response.json()) as { mission?: { id?: string } };
      if (data.mission?.id !== id)
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Conversation ownership mismatch.",
            },
          },
          403,
        );
    } catch {
      return c.json(
        {
          error: {
            code: "INTEGRATION_UNAVAILABLE",
            message: "Ownership service unavailable.",
          },
        },
        503,
      );
    }
    await next();
  });
  app.route("/agents/humanos", router);
  return app;
}
