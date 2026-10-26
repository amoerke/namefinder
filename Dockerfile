# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY web web
RUN npm run build -w web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    STATIC_DIR=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# Nur Produktions-Abhängigkeiten des Servers
RUN npm ci --omit=dev --workspace server --include-workspace-root=false \
    && npm cache clean --force
COPY server/src server/src
COPY shared shared
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
WORKDIR /app/server
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/api/session || exit 1
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/index.ts"]
