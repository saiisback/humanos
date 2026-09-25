FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @humanos/api build && pnpm --filter @humanos/agent build && pnpm --filter @humanos/web build
ENV HOST=0.0.0.0
CMD ["pnpm", "--filter", "@humanos/api", "exec", "tsx", "src/server.ts"]
