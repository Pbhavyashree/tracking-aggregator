FROM node:22-alpine AS builder

WORKDIR /build
COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

RUN addgroup -g 10001 app && adduser -u 10001 -G app -D -H app

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist ./dist

USER app
EXPOSE 3000

# Hits liveness, which deliberately does not touch a carrier — otherwise a
# carrier outage would make the platform restart every healthy container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main"]
