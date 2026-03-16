# Kadmoo Crawler Service

External production-grade crawler service for the Kadmoo SEO platform. Designed to run on DigitalOcean (or any VPS) independently from the main Next.js app on Vercel.

## Architecture

- **Fastify** HTTP server with API key auth
- **BullMQ + Redis** for job queue and concurrency control
- **Crawlee** (CheerioCrawler + PlaywrightCrawler fallback) for crawling
- **S3-compatible storage** for raw crawl artifacts
- **Webhook + polling** hybrid for status updates to the main app

## Quick Start (Development)

```bash
cp .env.example .env
# Edit .env with your values (Redis URL, API key, etc.)
npm install
npx playwright install chromium
npm run dev
```

## Quick Start (Docker)

```bash
cp .env.example .env
docker compose up --build
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/crawl` | Create a new crawl job |
| GET | `/crawl/:id/status` | Get job status and progress |
| GET | `/crawl/:id/results` | Get crawl results |
| GET | `/health` | Health check + queue stats |

## Deployment (DigitalOcean)

1. Create a Droplet (4 vCPU, 8GB RAM recommended)
2. Install Docker and Docker Compose
3. Clone this repo
4. Copy `.env.example` to `.env` and configure
5. Run `docker compose up -d`
6. Set up DNS (e.g., `crawler.kadmoo.com`)
7. Set up HTTPS with Caddy or nginx reverse proxy

## Environment Variables

See `.env.example` for all available configuration options.
