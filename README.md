# 🏥 GoCare — Built End-to-End in One Day

**AI clinical risk triage that runs anywhere.**

> Intake symptoms → route to Gemini/OpenAI/mock → return an explainable risk readout in seconds.

[![Live Demo](https://img.shields.io/badge/Live-Demo-brightgreen)](https://gocare-l1f8.onrender.com/)
[![Go](https://img.shields.io/badge/Backend-Go%2FGin-00ADD8)](https://go.dev/)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED)](https://www.docker.com/)

---

## 🎯 Try It Now

| | |
|---|---|
| **Live Demo** | https://gocare-l1f8.onrender.com/ |

---

## ⚡ What We Shipped Under Hackathon Pressure

- Full Go/Gin backend (~1300 LOC) and vanilla JS frontend (~1100 LOC) assembled in a day
- Swap-in LLM engines (Gemini, OpenAI, mock) without touching the UI
- Safe-by-default: keys stay server-side, mock engine on standby to keep demos moving
- Health/readiness/config endpoints for quick checks—solid for demos, not claiming hospital-grade prod
- One-command local and Render deploy so judges can see it live immediately

---

## 💡 How It Works

1. **Collect symptoms** — name, vitals, conditions, medications, chief complaint.
2. **Route to an engine** — Gemini, OpenAI, or deterministic mock (controlled by `DEFAULT_MODEL`).
3. **Return a risk readout** — risk tier, recommendations, and next steps.

No login. Opens in the browser and responds fast enough for live judging.

---

## 🚀 Why This Approach

| Decision | Reason (with minutes to spare) |
|----------|--------------------------------|
| **🔌 Hot-swappable LLMs** | One env var flips engines; lets us demo even if a provider rate-limits. |
| **🛡️ Zero secrets in browser** | Backend proxy keeps API keys server-side. |
| **♻️ Automatic fallback** | Any LLM hiccup drops to mock so the flow never stalls. |
| **⚡ One-command deploy** | `docker-compose up --build` locally or Render blueprint for the cloud. |
| **🩺 Demo-ready probes** | `/healthz`, `/readyz`, `/api/config` to prove the stack is alive. |
| **📦 Single repo** | Backend + frontend together to avoid integration overhead. |

---

## 🤖 LLM Integration

GoCare supports **three diagnostic engines**:

| Model | Endpoint | Requires |
|-------|----------|----------|
| **Mock** | `/api/diagnostics/mock` | Nothing (built-in) |
| **Gemini** | `/api/diagnostics/gemini` | `GEMINI_API_KEY` |
| **OpenAI** | `/api/diagnostics/openai` | `OPENAI_API_KEY` |

### Flow
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│  Go Backend │────▶│  LLM API    │
│  (no keys)  │     │ (holds keys)│     │ (Gemini/OAI)│
└─────────────┘     └─────────────┘     └─────────────┘
```

- Set `DEFAULT_MODEL=gemini|openai|mock`
- Frontend auto-discovers available models via `/api/config`
- If an LLM call fails, we fall back to mock to keep the flow live

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
├── cmd/server/main.go   # Gin backend (~1300 LOC)
├── index.html           # Clinical UI
├── app.js               # Frontend logic (~1100 LOC)
├── config.js            # Client-side config
├── docker-compose.yml   # One-command local stack
├── render.yaml          # Render deploy blueprint
└── API.md               # Full API documentation
```

**Stack:** Go/Gin • Vanilla JS • PostgreSQL (optional) • Docker • Render

---

## 🚧 What We Deliberately Scoped

- No auth or PHI storage; this is a demo-safe flow
- Database optional; mocks keep the demo self-contained
- LLM prompts are basic but explainable; easy to iterate post-judging
- UI is minimal for speed; mobile-friendly enough for live testing

These are conscious trade-offs to land a full end-to-end demo quickly.

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

Built for a hackathon. MIT License.

---

<p align="center">
  <b>GoCare</b> — Because faster clinical insights save lives.
</p>
