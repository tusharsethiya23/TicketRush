# Debian slim, not Alpine: bcrypt ships prebuilt binaries for glibc.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
