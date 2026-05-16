# ─── Build Stage ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npx prisma generate
RUN npm run build

# Prune devDependencies for production
RUN npm prune --omit=dev

# ─── Production Stage ────────────────────────────────────
FROM node:22-alpine AS runner

# Security: don't run as root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what's needed for production
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/prisma.config.ts ./
COPY --from=builder --chown=appuser:appgroup /app/templates ./templates

# Create uploads directory
RUN mkdir -p /app/uploads && chown appuser:appgroup /app/uploads

ENV NODE_ENV=production

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3000}/${API_PREFIX:-api}/health" || exit 1

# Use node directly (not sh -c) so SIGTERM reaches the process for graceful shutdown
CMD ["node", "dist/src/main.js"]
