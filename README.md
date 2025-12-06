# 🏥 GoCare

**AI-powered clinical risk assessment in seconds.**

> Enter patient symptoms → Get instant risk analysis from Gemini, OpenAI, or mock engine → Make informed decisions faster.

[![Live Demo](https://img.shields.io/badge/Live-Demo-brightgreen)](https://gocare-l1f8.onrender.com/)
[![Go](https://img.shields.io/badge/Backend-Go%2FGin-00ADD8)](https://go.dev/)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED)](https://www.docker.com/)

---

## 🎯 Try It Now

| | |
|---|---|
| **Live Demo** | https://gocare-l1f8.onrender.com/ |

---

## 💡 What It Does

1. **Patient inputs symptoms** — name, weight, height, conditions, medications, chief complaint
2. **AI analyzes risk** — powered by Gemini, OpenAI, or deterministic mock
3. **Instant assessment** — risk level, recommendations, and next steps

No login required. Works immediately.

---

## 🚀 Why GoCare Stands Out

| Feature | Why It Matters |
|---------|----------------|
| **🔌 Plug-and-play LLMs** | Switch between Gemini, OpenAI, or mock with one env var. Hot-swappable, no code changes. |
| **🛡️ Zero secrets in browser** | API keys stay server-side. Backend proxies all LLM calls securely. |
| **♻️ Automatic fallback** | If LLM fails, gracefully degrades to mock engine—demos never break. |
| **⚡ One-command deploy** | `docker-compose up --build` and you're live. Render blueprint included. |
| **🩺 Production-ready endpoints** | Health (`/healthz`), readiness (`/readyz`), config discovery (`/api/config`). |
| **📦 Monorepo simplicity** | Frontend + backend in one repo. Clone, run, done. |

---

## 🤖 LLM Integration (The Cool Part)

GoCare supports **three diagnostic engines**:

| Model | Endpoint | Requires |
|-------|----------|----------|
| **Mock** | `/api/diagnostics/mock` | Nothing (built-in) |
| **Gemini** | `/api/diagnostics/gemini` | `GEMINI_API_KEY` |
| **OpenAI** | `/api/diagnostics/openai` | `OPENAI_API_KEY` |

### How it works:
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│  Go Backend │────▶│  LLM API    │
│  (no keys)  │     │ (holds keys)│     │ (Gemini/OAI)│
└─────────────┘     └─────────────┘     └─────────────┘
```

- Set `DEFAULT_MODEL=gemini|openai|mock` to control the default
- Frontend auto-discovers available models via `/api/config`
- If an LLM call fails → falls back to mock (demos keep running)

---

## ⚡ Quickstart

### Option A: Docker (recommended)
```bash
docker-compose up --build
```

### Option B: Go directly
```bash
PORT=8080 go run ./cmd/server
```

### Verify it's running:
```bash
curl http://localhost:8080/healthz   # → {"status":"ok"}
curl http://localhost:8080/readyz    # → {"status":"ok"}
```

### Test a diagnosis:
```bash
curl -X POST http://localhost:8080/api/diagnostics/mock \
  -H "Content-Type: application/json" \
  -d '{"name":"Alex","weight":80,"height":180,"conditions":[],"medications":"Vitamin D","complaint":"chest pain"}'
```

---

## 🔧 Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `8080` | Server port |
| `DEFAULT_MODEL` | `mock` | Default diagnostic engine |
| `GEMINI_API_KEY` | — | Enables Gemini endpoint |
| `OPENAI_API_KEY` | — | Enables OpenAI endpoint |
| `ENABLE_DB` | `false` | Enable PostgreSQL |
| `DATABASE_URL` | — | Postgres connection string |
| `GIN_MODE` | `release` | Gin framework mode |

---

## 🏗️ Architecture

```
├── cmd/server/main.go   # Gin backend (1300+ lines of production Go)
├── index.html           # Clinical UI
├── app.js               # Frontend logic (1100+ lines)
├── config.js            # Client-side config
├── docker-compose.yml   # One-command local stack
├── render.yaml          # Render deploy blueprint
└── API.md               # Full API documentation
```

**Stack:** Go/Gin • Vanilla JS • PostgreSQL (optional) • Docker • Render

---

## 🧪 Testing

```bash
make test    # Run Go tests
make fmt     # Format code
```

---

## 🚢 Deploy to Render

1. Push to GitHub
2. Connect repo in Render Dashboard
3. Render reads `render.yaml` automatically
4. Set env vars: `GEMINI_API_KEY`, `OPENAI_API_KEY` (optional)
5. Done — live in minutes

---

## 📚 API Reference

See [`API.md`](./API.md) for complete endpoint documentation, request/response schemas, and examples.

**Key endpoints:**
- `GET /healthz` — Liveness probe
- `GET /readyz` — Readiness probe (DB check if enabled)
- `GET /api/config` — Available models and defaults
- `POST /api/diagnostics/{mock,gemini,openai}` — Run diagnosis

---

## 📄 License

Built for hackathon. MIT License.

---

<p align="center">
  <b>GoCare</b> — Because faster clinical insights save lives.
</p>
