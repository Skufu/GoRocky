# GoRocky

Static clinical UI + Gin backend with a mock diagnostic endpoint, Docker/Compose, and Render deploy config.

## Frontend
- Static files: `index.html`, `styles.css`, `app.js`, `config.js`.
- Configure API base: set `window.__APP_CONFIG.apiBaseUrl` in `config.js` (defaults to `window.location.origin`).
- The client POSTs to `/api/diagnostics/mock`; errors log in the terminal panel and fall back to a local mock if the backend fails.

## Backend
- Gin server (`cmd/server/main.go`) with:
  - `GET /healthz` (DB ping)
  - `POST /api/diagnostics/mock` (mock risk output)
  - CORS enabled, 1MB body limit, release mode by default.
- Env vars: `PORT` (default 8080), `DATABASE_URL` (required), `GIN_MODE` (release), optional `GEMINI_API_KEY`, `OPENAI_API_KEY`.

## Local dev
```
DATABASE_URL=postgres://gorocky:gorocky@localhost:5432/gorocky?sslmode=disable PORT=8080 go run ./cmd/server
```
or
```
docker-compose up --build
```

Health check:
```
curl http://localhost:8080/healthz
```

Mock diagnostics:
```
curl -X POST http://localhost:8080/api/diagnostics/mock \
  -H "Content-Type: application/json" \
  -d '{"name":"Alex","weight":80,"height":180,"conditions":[],"medications":"Vitamin D","complaint":"ED"}'
```

## Tests and tooling
```
make test
make fmt
```

## Migrations (placeholder)
- Migration files live in `./migrations`.
- Requires the `migrate/migrate` Docker image on PATH; set `DB_URL` or `DATABASE_URL`.
```
make db-migrate-up
make db-migrate-down
```

## Deploy (Render)
- Backend: Render Blueprint reads `render.yaml` (Docker runtime). Set env vars in the dashboard: `DATABASE_URL`, `PORT=8080`, `GIN_MODE=release`, optional API keys.
- Frontend: host static files (Render Static Site, Netlify, Vercel). Set `apiBaseUrl` in `config.js` to the backend URL.

## Docker
```
docker build -t gorocky:local .
docker run -p 8080:8080 -e DATABASE_URL=... gorocky:local
```

