# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Install deps
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable

# If you use pnpm (likely), prefer pnpm. Otherwise npm.
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi

# Copy source + build
COPY . .
RUN if [ -f pnpm-lock.yaml ]; then pnpm run build; else npm run build; fi

# ---- Runtime stage ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Install only production deps
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable \
  && if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prod; else npm ci --omit=dev; fi

# Copy built output
COPY --from=build /app/dist ./dist

# Fly sets PORT; your app already respects process.env.PORT ?? 3333
EXPOSE 3333

CMD ["node", "dist/index.js"]
