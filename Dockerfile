# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Native module toolchain (better-sqlite3)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable

# If you use pnpm (likely), prefer pnpm. Otherwise npm.
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi

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

# Fly sets PORT; your app already respects process.env.PORT ?? 3333
EXPOSE 3333

CMD ["node", "dist/index.js"]
