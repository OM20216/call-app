# Call app (Node + SQLite) — any Docker host
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# install deps first so the layer is cached
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite file lives on a mounted disk so data survives restarts/deploys.
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
