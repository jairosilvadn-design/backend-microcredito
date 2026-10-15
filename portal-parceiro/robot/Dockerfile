# Imagem oficial do Playwright já traz Chromium + dependências de sistema.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
CMD ["node", "dist/index.js"]
