# Playwright's own image: Node plus Chromium and every system library it needs.
# The tag must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY *.js ./

CMD ["node", "server.js"]
