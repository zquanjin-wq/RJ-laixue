# ---- Stage 1: Base ----
FROM node:20-alpine AS base

RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# ---- Stage 2: Dependencies ----
FROM base AS deps

# Native build tools for sharp, @napi-rs/canvas
RUN apk add --no-cache python3 build-base g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/

RUN pnpm install --frozen-lockfile

# ---- Stage 3: Builder ----
FROM base AS builder

# NEXT_PUBLIC_* values are compiled into the browser bundle by Next.js. Never
# pass server secrets as Docker build arguments.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE
ARG NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK
ARG NEXT_PUBLIC_DSL_ASSET_GUARD_MODE
ARG NEXT_PUBLIC_ENABLE_PPTX_IMPORT
ARG NEXT_PUBLIC_LEGACY_AUTOSAVE
ARG NEXT_PUBLIC_MAIC_EDITOR_ENABLED
ARG NEXT_PUBLIC_RUNTIME_SHADOW
ARG NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK
ARG NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ
ARG NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE=$NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE
ENV NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK=$NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK
ENV NEXT_PUBLIC_DSL_ASSET_GUARD_MODE=$NEXT_PUBLIC_DSL_ASSET_GUARD_MODE
ENV NEXT_PUBLIC_ENABLE_PPTX_IMPORT=$NEXT_PUBLIC_ENABLE_PPTX_IMPORT
ENV NEXT_PUBLIC_LEGACY_AUTOSAVE=$NEXT_PUBLIC_LEGACY_AUTOSAVE
ENV NEXT_PUBLIC_MAIC_EDITOR_ENABLED=$NEXT_PUBLIC_MAIC_EDITOR_ENABLED
ENV NEXT_PUBLIC_RUNTIME_SHADOW=$NEXT_PUBLIC_RUNTIME_SHADOW
ENV NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=$NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK
ENV NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ=$NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ
ENV NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI=$NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI
# Keep the Next.js type-check build within the upgraded 8 GB production CVM,
# while leaving enough memory for Dokploy itself.
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
COPY --from=deps /app/public/vendor ./public/vendor

RUN pnpm build

# ---- Stage 4: Runner ----
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache libc6-compat cairo pango jpeg giflib librsvg

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
