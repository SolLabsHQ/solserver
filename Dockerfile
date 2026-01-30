# ---- Build stage ----
FROM node:20-slim AS build
ARG SQLITE_VEC_VERSION=0.1.7-alpha.2
ARG SQLITE_VEC_ARCH=linux-x64
WORKDIR /app

# Native module toolchain (better-sqlite3)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install deps
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable

# If you use pnpm (likely), prefer pnpm. Otherwise npm.
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi

# Fetch sqlite-vec loadable extension for runtime (linux-x64 in Fly)
RUN mkdir -p /app/extensions \
  && curl -fsSL "https://registry.npmjs.org/sqlite-vec-${SQLITE_VEC_ARCH}/-/sqlite-vec-${SQLITE_VEC_ARCH}-${SQLITE_VEC_VERSION}.tgz" -o /tmp/sqlite-vec.tgz \
  && mkdir -p /tmp/sqlite-vec \
  && tar -xzf /tmp/sqlite-vec.tgz -C /tmp/sqlite-vec \
  && cp /tmp/sqlite-vec/package/vec0.so /app/extensions/vec0.so \
  && rm -rf /tmp/sqlite-vec /tmp/sqlite-vec.tgz

# Copy source + build
COPY . .
RUN if [ -f pnpm-lock.yaml ]; then pnpm rebuild better-sqlite3 && pnpm run build && pnpm prune --prod; else npm rebuild better-sqlite3 && npm run build && npm prune --omit=dev; fi

# ---- Runtime stage ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Copy only what we need (already pruned to prod deps)
COPY --from=build /app/package.json /app/pnpm-lock.yaml* /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/extensions ./extensions

# Fly sets PORT; your app already respects process.env.PORT ?? 3333
EXPOSE 3333

CMD ["bash", "scripts/run-web-worker.sh"]
