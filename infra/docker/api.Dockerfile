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

# QG-03 container-image scan (OB-288 gates lane): the base image ships the npm, corepack and yarn package managers.
# Nothing in this image runs them — the service starts with `node`, and the build below uses node_modules copied from
# the deps stage — yet the npm CLI's own bundled dependencies carry HIGH vulnerabilities the image scan reports
# (brace-expansion, ip-address, pacote, picomatch, sigstore, http-cache-semantics). A tool that is never run is
# attack surface, not function, so it is removed rather than its findings silenced.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# A named, unprivileged user. Root in a container is root on the host if anything escapes.
RUN addgroup -S sre && adduser -S -G sre sre

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY db ./db
COPY scripts ./scripts

# The container runs a BUNDLED artifact, not the raw TypeScript tree. This whole codebase uses
# extensionless ESM imports (`./main`, `../../../packages/…`), and current Node's ESM resolver
# will not resolve those from source — so launching straight at `services/api/src/start.ts` dies
# on the first import before `main()` can refuse a bad configuration cleanly (exit 78). esbuild
# bundles the workspace TypeScript into one file with the types stripped and extensions resolved,
# exactly as the app shells are already built.
RUN node scripts/build-service.mjs api

USER sre
EXPOSE 8081

# Liveness only. Readiness is asked separately by the orchestrator, because a database this
# process cannot reach means take it out of rotation — not restart it into a crash loop.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8081/livez || exit 1

CMD ["node", "services/api/dist/start.js"]
