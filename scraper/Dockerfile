# Container for the nightly price scraper. Designed for Cloud Run Jobs:
# Cloud Scheduler triggers `gcloud run jobs execute fandf-price-scraper`
# at 03:00 IL; the container spins up, runs scrape-landing-prices.mjs,
# writes the LANDING_PRICES tab on the dashboard-comments sheet, exits.
#
# Build context expected at the fandf-hub root (one level above this
# Dockerfile) so it can COPY the scraper script + lib helper from
# their existing paths without duplication.
FROM node:22-slim

# System Chromium — saves the ~150 MB puppeteer-bundled download in the
# image AND the network egress on every cold start. Plus Hebrew + emoji
# fonts so rendered prices look the same as a real browser. ca-certs for
# HTTPS to googleapis + landing pages.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tell puppeteer to skip its own Chromium download at install AND to use
# the system binary at runtime. Both ENVs read by puppeteer 21+.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install runtime deps. Subset of the hub's full package.json — only
# what the scraper actually imports. Keeps the image lean (~250 MB
# vs. the hub's ~1 GB).
COPY scraper/package.json scraper/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Source files. The .ts file is consumed directly by Node 22's
# --experimental-strip-types — no compile step.
COPY lib/priceExtractor.ts ./lib/priceExtractor.ts
COPY scripts/scrape-landing-prices.mjs ./scripts/scrape-landing-prices.mjs

# Cloud Run Jobs run this command once per execution, then exit.
# `--no-warnings` silences the type-stripping experimental warning that
# would otherwise spam every log line. The job's stdout/stderr stream
# to Cloud Logging.
CMD ["node", "--no-warnings", "--experimental-strip-types", "scripts/scrape-landing-prices.mjs"]
