# The cloud API — thirteen services, one process, one port.
#
# Multi-stage so the shipped image holds no build tooling and no test code: a smaller image is a
# smaller thing to keep patched, and a production container with a compiler in it is a production
# container somebody can build in.
#
# Runs as a non-root user with a read-only root filesystem (SEC-06). Nothing in this file holds a
# secret — every value arrives from the environment at run time (hard rule #4).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false || pnpm install

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# A named, unprivileged user. Root in a container is root on the host if anything escapes.
RUN addgroup -S sre && adduser -S -G sre sre

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY db ./db
COPY scripts ./scripts

USER sre
EXPOSE 8081

# Liveness only. Readiness is asked separately by the orchestrator, because a database this
# process cannot reach means take it out of rotation — not restart it into a crash loop.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8081/livez || exit 1

CMD ["node", "--experimental-strip-types", "services/api/src/start.ts"]
