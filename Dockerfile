# Self-hosted web version with the built-in provider relay.
#   docker build -t adt-bot . && docker run -p 8787:8787 adt-bot
FROM node:24-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
# Uncomment to let the relay reach model servers on your LAN/VPN or the Docker host
# (use http://host.docker.internal:11434/v1 for Ollama on the host):
# ENV ADTBOT_PROXY_PRIVATE=1
EXPOSE 8787
USER node
CMD ["node", "server/index.mjs"]
