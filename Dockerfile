FROM node:20-slim AS builder

WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/relay/package.json packages/relay/
COPY packages/dashboard/package.json packages/dashboard/

RUN pnpm install --frozen-lockfile --filter @tapflow/relay --filter @tapflow/dashboard --filter @tapflow/agent-core

COPY packages/agent-core packages/agent-core
COPY packages/dashboard packages/dashboard
COPY packages/relay packages/relay

RUN pnpm --filter @tapflow/agent-core build
RUN pnpm --filter @tapflow/dashboard build
RUN pnpm --filter @tapflow/relay build

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/packages/relay/dist ./dist
COPY --from=builder /app/packages/relay/public ./public
COPY --from=builder /app/packages/relay/package.json ./

RUN npm install --omit=dev

VOLUME ["/app/.tapflow-data"]
EXPOSE 4000

CMD ["node", "dist/server.js"]
