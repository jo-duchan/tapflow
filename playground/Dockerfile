FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

WORKDIR /app

# Workspace manifests first (layer cache: changes rarely)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/relay/package.json packages/relay/
COPY packages/ios-agent/package.json packages/ios-agent/
COPY packages/android-agent/package.json packages/android-agent/
COPY packages/cli/package.json packages/cli/
COPY packages/cli/bin packages/cli/bin
COPY packages/mcp-server/package.json packages/mcp-server/
COPY playground/package.json playground/
COPY docs/package.json docs/

RUN git init && pnpm install --frozen-lockfile

# Source files for build (agent-core → dashboard → relay only)
COPY packages/agent-core packages/agent-core
COPY packages/dashboard packages/dashboard
COPY packages/relay packages/relay
COPY playground/server.js playground/

RUN pnpm --filter @tapflowio/agent-core build && \
    pnpm --filter @tapflowio/dashboard build && \
    pnpm --filter @tapflowio/relay build

EXPOSE 4000
ENV TAPFLOW_DATA_DIR=/data

CMD ["node", "playground/server.js"]
