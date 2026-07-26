# The document server: bun for the server itself, Chromium for the tile
# pre-render. Build context is the repo root, not server/, because solution.md
# lives one level up and index.ts resolves it that way.
FROM oven/bun:1

USER root

WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile

# Chromium is installed through the project's own playwright, so the browser
# build always matches the pinned client library — a mismatch here fails at
# render time, not at build time. --with-deps pulls the system libraries it
# needs, which is the fiddly part to get right by hand.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bunx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server ./server
COPY solution.md ./solution.md

WORKDIR /app/server
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "index.ts"]
