# API Reference

Base URL defaults to `http://localhost:8080`. All endpoints accept and return JSON. CORS is open (`*`). Requests over ~1MB are rejected.

## Endpoints

- `GET /healthz` — Liveness check. Always returns `200` with `{"status":"ok"}` when the server is up.
- `GET /readyz` — Readiness/DB check.
  - DB disabled: `200 {"status":"ok","db":"disabled"}`
  - DB healthy: `200 {"status":"ok","db":"ok"}`
  - DB unhealthy/timeout (2s): `503 {"status":"degraded","db":"unhealthy: <details>"}`
- `POST /api/diagnostics/mock` — Runs the mock safety/diagnostic engine and returns a structured risk assessment.

## Requests

`POST /api/diagnostics/mock`

Headers:
- `Content-Type: application/json`

Body fields:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Patient name/identifier. |
| `weight` | number | In kg. |
| `height` | number | In cm. |
| `age` | integer | Years. |
| `bmi` | number | Precomputed BMI (not recalculated server-side). |
| `bpSystolic` | number | Systolic BP. |
| `bpDiastolic` | number | Diastolic BP. |
| `smoking` | string | e.g., `"never"`, `"former"`, `"current"`. |
| `alcohol` | string | e.g., `"none"`, `"moderate"`. |
| `exercise` | string | e.g., `"regular"`, `"sedentary"`. |
| `conditions` | string[] | Lowercased matches used for rules (e.g., `"kidney disease"`, `"pregnant"`). |
| `medications` | string | Free-text list; parsed for class tokens (PDE5i, nitrates, alpha-blockers, CYP3A4 inhibitors). |
| `medicationDetails` | string | Optional supporting text. |
| `allergies` | string | Free-text list; parsed for drug classes. |
| `complaint` | string | Primary complaint (e.g., `"ED"`). |

## Responses

Success `200 OK` (example):
```
{
  "riskScore": 70,
  "riskLevel": "HIGH",
  "issues": ["Interaction: nitrates + PDE5i"],
  "interactions": [
    {"pair":"Nitrates + PDE5i","severity":"HIGH","note":"Risk of profound hypotension; avoid co-administration."}
  ],
  "contraindications": [
    {"conditionOrAllergy":"Nitrate therapy","severity":"HIGH","note":"Concurrent nitrate use contraindicates PDE5 inhibitors due to hypotension risk."}
  ],
  "dosingConcerns": [
    {"factor":"Age >65","severity":"MEDIUM","recommendation":"Initiate at lowest dose; titrate cautiously."}
  ],
  "plan": {"medication":"tadalafil","dosage":"2.5-5mg once daily","duration":"as needed","rationale":"Use lowest effective dose and avoid nitrate overlap."},
  "alternatives": [
    {"option":"Lifestyle/psychosexual counseling","confidence":0.52}
  ],
  "confidenceScore": 0.82,
  "recommendationConfidence": {"plan":0.8},
  "source": "mock"
}
```

Error shapes:
- `400 {"error":"invalid payload"}` — JSON bind/shape error.
- `503 {"status":"degraded","db":"unhealthy: <details>"}` — only from `readyz` when DB unhealthy.
- `413` if body exceeds ~1MB.

## Examples

Health/readiness:
```
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz
```

Mock diagnostics:
```
curl -X POST http://localhost:8080/api/diagnostics/mock \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alex",
    "weight": 80,
    "height": 180,
    "age": 45,
    "bmi": 24.7,
    "bpSystolic": 135,
    "bpDiastolic": 85,
    "smoking": "never",
    "alcohol": "moderate",
    "exercise": "regular",
    "conditions": ["hypertension"],
    "medications": "tadalafil, lisinopril",
    "medicationDetails": "evening dose",
    "allergies": "none",
    "complaint": "ED"
  }'
```

## Notes
- No authentication is required for these routes.
- The frontend (`app.js`) falls back to a local mock if the backend call fails; backend responses should be valid JSON matching the schema above.
- Responses are generated via a deterministic mock rule engine (no external model calls). `source` is `"mock"` to reflect this.
