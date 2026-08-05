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

RUN addgroup -S sre && adduser -S -G sre sre

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY edge ./edge

# Owned by the user that writes it. A sale that cannot be written is a sale refused at the lane,
# so the permissions on this directory are a trading matter rather than a tidiness one.
RUN mkdir -p /var/lib/sre-edge && chown sre:sre /var/lib/sre-edge
VOLUME ["/var/lib/sre-edge"]

USER sre

# No HEALTHCHECK that depends on the cloud. "Healthy" for this container means the process is up
# and its disk is writable — a shop whose line is down is trading perfectly well, and a health
# check that says otherwise gets the container restarted in the middle of a queue.
CMD ["node", "--experimental-strip-types", "edge/store-edge/src/start.ts"]
