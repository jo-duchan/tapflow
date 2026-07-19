# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# git is required by lefthook/prepare postinstall scripts that run during pnpm install.
RUN apk add --no-cache git

# Install pnpm
RUN npm install -g pnpm@9.15.1

# Copy workspace configuration and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all packages for building and workspace resolution
COPY packages ./packages
COPY playground/package.json ./playground/
COPY docs/package.json ./docs/

# Install dependencies across the entire monorepo
RUN pnpm install --frozen-lockfile

# Build required dependencies and the relay package itself.
# Dashboard is built so its static assets are placed in relay/public.
RUN pnpm --filter @tapflowio/agent-core build
RUN pnpm --filter @tapflowio/dashboard build
RUN pnpm --filter @tapflowio/relay build

# Extract the relay package and its production dependencies to an isolated folder
RUN pnpm deploy --filter @tapflowio/relay --prod /app/out

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Ensure the working directory is owned by the non-root 'node' user
RUN chown node:node /app

# Switch to the non-root user provided by node:alpine
USER node

# Copy the deployed application from the builder
COPY --from=builder --chown=node:node /app/out ./

# Create data directory as the node user for volume mount
RUN mkdir -p /app/.tapflow/data
VOLUME ["/app/.tapflow/data"]

# Set environment to production
ENV NODE_ENV=production

# The default port for relay
EXPOSE 4000

# Entry point for the relay server
CMD ["node", "dist/server.js"]
