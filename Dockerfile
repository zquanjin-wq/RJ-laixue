# ---- Stage 1: Base ----
FROM node:22-alpine AS base

RUN sed -i 's|https://dl-cdn.alpinelinux.org|https://mirrors.tencent.com|g' /etc/apk/repositories \
  && apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# ---- Stage 2: Dependencies ----
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/

RUN pnpm install --frozen-lockfile

# ---- Stage 3: Builder ----
FROM base AS builder

# Next.js inlines NEXT_PUBLIC_* values during `pnpm build`; runtime env_file
# values alone cannot make public feature entries appear in the browser.
ARG NEXT_PUBLIC_ENABLE_PPTX_IMPORT=false
ARG NEXT_PUBLIC_ENABLE_DURABLE_GENERATION=false
ENV NEXT_PUBLIC_ENABLE_PPTX_IMPORT=$NEXT_PUBLIC_ENABLE_PPTX_IMPORT
ENV NEXT_PUBLIC_ENABLE_DURABLE_GENERATION=$NEXT_PUBLIC_ENABLE_DURABLE_GENERATION

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
COPY --from=deps /app/public/vendor ./public/vendor

RUN pnpm --dir packages/@openmaic/renderer build \
  && DATABASE_URL=postgres://laixue:placeholder@127.0.0.1:5432/laixue SUPABASE_URL=https://example.invalid SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder pnpm build

# ---- One-off administration tools ----
FROM builder AS tools

# ---- Stage 4: Runner ----
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN sed -i 's|https://dl-cdn.alpinelinux.org|https://mirrors.tencent.com|g' /etc/apk/repositories \
  && apk add --no-cache libc6-compat

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs db ./db
COPY --chown=nextjs:nodejs scripts/migrate-database.mjs ./scripts/migrate-database.mjs
COPY --chown=nextjs:nodejs scripts/bootstrap-admin.mjs ./scripts/bootstrap-admin.mjs
COPY --chown=nextjs:nodejs scripts/run-course-revoice-worker.mjs ./scripts/run-course-revoice-worker.mjs
COPY --chown=nextjs:nodejs scripts/run-course-video-export-worker.mjs ./scripts/run-course-video-export-worker.mjs
COPY --chown=nextjs:nodejs scripts/run-classroom-generation-worker.mjs ./scripts/run-classroom-generation-worker.mjs

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
