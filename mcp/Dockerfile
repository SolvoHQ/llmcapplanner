# MCP stdio server for llmcapplanner.
# Build context must be this directory (the mcp/ subdir).
FROM node:20-slim

WORKDIR /app

# Install deps against the lockfile first for cacheable layers.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source + the dated pricing/rate-limit snapshot, then build.
COPY tsconfig.json ./
COPY src ./src
COPY snapshot.json README.md LICENSE ./
RUN npm run build

# index.ts loads snapshot.json from one level up from dist/, i.e. /app/snapshot.json.
ENTRYPOINT ["node", "dist/index.js"]
