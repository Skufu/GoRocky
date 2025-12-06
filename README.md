# GoCare

Static clinical UI + Gin backend with a mock diagnostic endpoint, Docker/Compose, and Render deploy config.

- Full API reference: see `API.md` (request/response schema, status codes, examples).

## Frontend
- Static files: `index.html`, `styles.css`, `app.js`, `config.js`.
- Configure API base: set `window.__APP_CONFIG.apiBaseUrl` in `config.js` (defaults to `window.location.origin`).
- Model defaults (config-driven): set `defaultModel` to `mock|gemini|openai`, toggle availability via `models` flags, and optionally inject keys via `modelKeys.gemini`/`modelKeys.openai` (map from `GEMINI_API_KEY` / `OPENAI_API_KEY` at deploy).
- The client POSTs to `/api/diagnostics/mock`; errors log in the terminal panel and fall back to a local mock if the backend fails.

## Backend
- Gin server (`cmd/server/main.go`) with:
  - `GET /healthz` (liveness)
  - `GET /readyz` (DB ping when enabled)
  - `POST /api/diagnostics/mock` (mock risk output)
  - CORS enabled, 1MB body limit, release mode by default.
- Env vars: `PORT` (default 8080), `ENABLE_DB` (default false), `DATABASE_URL` (required only when `ENABLE_DB=true`), `GIN_MODE` (release), optional `GEMINI_API_KEY`, `OPENAI_API_KEY`.

## API
- Base URL defaults to `http://localhost:8080`.
- No auth; JSON only; CORS allows `*`; ~1MB request limit.
- Endpoints: `GET /healthz`, `GET /readyz`, `POST /api/diagnostics/mock`.
- Details, field list, and examples live in `API.md`.

## Local dev
```
DATABASE_URL=postgres://gorocky:gorocky@localhost:5432/gorocky?sslmode=disable PORT=8080 go run ./cmd/server
```
or
```
docker-compose up --build
```

Health / readiness:
```
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
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
- Backend: Render Blueprint reads `render.yaml` (Docker runtime). Set env vars in the dashboard: `PORT=8080`, `GIN_MODE=release`, `ENABLE_DB` (true/false). When `ENABLE_DB=true`, also set `DATABASE_URL`; optional API keys.
- Frontend: host static files (Render Static Site, Netlify, Vercel). Set `apiBaseUrl` in `config.js` to the backend URL.

## Docker
```
docker build -t gorocky:local .
docker run -p 8080:8080 -e DATABASE_URL=... gorocky:local
```

