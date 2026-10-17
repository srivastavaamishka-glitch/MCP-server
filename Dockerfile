FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY demo ./demo
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
# MCP runner (stdio by default):  docker run -i --rm anything-to-mcp --spec <url> [--read-only]
# Web generator:  docker run -p 3000:3000 --entrypoint node anything-to-mcp dist/web.js
ENTRYPOINT ["node", "dist/cli.js"]
