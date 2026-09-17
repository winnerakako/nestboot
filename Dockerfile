# syntax=docker/dockerfile:1

# One image, both roles. ROLE at runtime decides whether this container serves
# HTTP or executes workflows — the same bytes either way, so a worker can never
# drift from the web process it shares a database with.

FROM node:22.22.3-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: a deploy that silently resolves a different dependency tree
# than the one that was tested is not the build you reviewed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM deps AS production-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm prune --prod

FROM base AS runtime
# postgresql-client for the backup workflow's pg_dump; tini so SIGTERM reaches
# Node rather than being swallowed by PID 1, which is what lets the app drain.
RUN apk add --no-cache postgresql17-client tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Never root. A container that is compromised should not also be privileged.
USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/main.js"]
