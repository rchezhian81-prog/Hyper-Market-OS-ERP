# The store edge — the box in the back office that lets the shop keep trading.
#
# Deliberately the same shape as `api.Dockerfile`: multi-stage, non-root, no secrets. Two things
# differ, and both follow from what this container is for.
#
#   • **It exposes no port.** The edge is not a service anybody calls over a network; it is a
#     process that owns a disk and drains a queue. Nothing should be able to reach it from outside
#     the machine, and the way to be sure of that is to publish nothing.
#   • **Its data directory is a volume, and the root filesystem is read-only.** The one thing this
#     container must be able to write is the one thing it must never lose.

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

RUN addgroup -S sre && adduser -S -G sre sre

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY edge ./edge
COPY scripts ./scripts
# The app shells, so this container can serve screens to the public proxy (ADR-0018). The built bundles
# (`apps/*/web/*.bundle.js`) are produced on the box by infra/deploy/release.sh before `compose up --build`.
COPY apps ./apps

# The container runs a BUNDLED artifact, not the raw TypeScript tree. This codebase uses
# extensionless ESM imports, which current Node's ESM resolver will not resolve from source — so
# launching straight at `edge/store-edge/src/start.ts` dies on the first import and the box never
# comes up. esbuild bundles the workspace TypeScript into one file, exactly as the API is built.
RUN node scripts/build-service.mjs edge

# Owned by the user that writes it. A sale that cannot be written is a sale refused at the lane,
# so the permissions on this directory are a trading matter rather than a tidiness one.
RUN mkdir -p /var/lib/sre-edge && chown sre:sre /var/lib/sre-edge
# OB-87 · verifier r19 OB87-1: the bill-number witness, OUTSIDE the data folder and on its own volume (compose mounts
# `edge-witness` here and sets EDGE_WITNESS_DIR). Made and owned here, so a fresh named volume starts writable by `sre`
# under the read-only root; without it every start looked like a possible restore (a new "ZZ" prefix each boot).
RUN mkdir -p /var/lib/sre-edge-witness && chown sre:sre /var/lib/sre-edge-witness
VOLUME ["/var/lib/sre-edge", "/var/lib/sre-edge-witness"]

USER sre

# No HEALTHCHECK that depends on the cloud. "Healthy" for this container means the process is up
# and its disk is writable — a shop whose line is down is trading perfectly well, and a health
# check that says otherwise gets the container restarted in the middle of a queue.
CMD ["node", "edge/store-edge/dist/start.js"]
