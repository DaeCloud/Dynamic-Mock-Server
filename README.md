# Dynamic-Mock-Server
Complete working project that provides a control endpoint to register new endpoints and serves them dynamically. Includes JSON persistence (survives restarts) and per-IP rate limiting configurable via environment variable.

Build & run with Docker (recommended):

```bash
# build
docker build -t dynamic-mock-server .

# run with default rate limit (10s)
docker run -p 8080:8080 -e RATE_LIMIT_SECONDS=10 -v "$PWD/data.json:/app/data.json" dynamic-mock-server
