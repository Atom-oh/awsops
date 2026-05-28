# ADR-030 dev ECS Fargate — multi-stage build for the AWSops Next.js dashboard.
#
# Stage 1: install deps + build Next.js standalone output.
# Stage 2: minimal runtime image copying the standalone server + static assets.
#
# The standalone bundle (.next/standalone) is a self-contained Node server.
# Build with:  docker buildx build --platform linux/arm64 -t awsops-dev:latest .

# --- Stage 1: build --------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app

# Install deps with cached layer when package.json/package-lock.json unchanged.
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline --no-audit

# Build (NEXT_TELEMETRY_DISABLED keeps the build hermetic).
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Stage 2: runtime ------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user mirroring Next.js convention.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output ships its own minimal node_modules tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

# Standalone entrypoint lives at /app/server.js.
CMD ["node", "server.js"]
