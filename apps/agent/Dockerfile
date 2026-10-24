FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tini ffmpeg

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
# Utilidades de operación (migración de estado a Postgres); no las usa el arranque.
COPY scripts ./scripts

RUN mkdir -p /app/data /app/credentials

# Inyectamos el git commit como ENV en build time. Dokploy expone GIT_COMMIT
# como build arg (o lo pasamos manual). Si está vacío, queda "unknown".
ARG GIT_COMMIT=unknown
ARG BUILD_AT
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILD_AT=${BUILD_AT}
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
