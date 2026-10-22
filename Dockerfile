# Self-hosted web version with the built-in provider relay.
#   docker build -t adt-bot . && docker run -p 8787:8787 adt-bot
FROM node:24-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
# Not `npm ci`: newer npm (11.19+) refuses a lock without the optional Windows-signing packages of
# electron-winstaller, which npm on macOS leaves out. `npm install` keeps every locked version.
RUN npm install --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine
# --build-arg BROWSER=1 adds Chromium, so always-on routines get a real browser (server/browser.mjs).
ARG BROWSER=0
RUN if [ "$BROWSER" = "1" ]; then apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji; fi
WORKDIR /app
COPY --from=build /app/dist ./dist
# From the build stage: it includes server/headless/, built by `npm run build`.
COPY --from=build /app/server ./server
# Chromium's own sandbox needs user namespaces. If the browser can't start in your container, allow
# them, or run with -e ADT_BROWSER_NO_SANDBOX=1 (the container is then its only sandbox).
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
# Uncomment to let the relay reach model servers on your LAN/VPN or the Docker host
# (use http://host.docker.internal:11434/v1 for Ollama on the host):
# ENV ADTBOT_PROXY_PRIVATE=1
EXPOSE 8787
# deploy/docker-compose.yml keeps the server's data in a volume at /data (ADT_DATA_DIR).
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "server/index.mjs"]
