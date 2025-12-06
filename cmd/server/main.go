package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

type HealthChecker interface {
	Ping(ctx context.Context) error
}

type Config struct {
	Port         string
	DatabaseURL  string
	GeminiAPIKey string
	OpenAIAPIKey string
	EnableDB     bool
}

type PatientData struct {
	Name              string   `json:"name"`
	Weight            float64  `json:"weight"`
	Height            float64  `json:"height"`
	Age               int      `json:"age"`
	BMI               float64  `json:"bmi"`
	BPSystolic        float64  `json:"bpSystolic"`
	BPDiastolic       float64  `json:"bpDiastolic"`
	Smoking           string   `json:"smoking"`
	Alcohol           string   `json:"alcohol"`
	Exercise          string   `json:"exercise"`
	Conditions        []string `json:"conditions"`
	Medications       string   `json:"medications"`
	MedicationDetails string   `json:"medicationDetails"`
	Allergies         string   `json:"allergies"`
	Complaint         string   `json:"complaint"`
}

type Plan struct {
	Medication string `json:"medication"`
	Dosage     string `json:"dosage"`
	Duration   string `json:"duration"`
	Rationale  string `json:"rationale"`
}

type DiagnosticResult struct {
	RiskScore                int                      `json:"riskScore"`
	RiskLevel                string                   `json:"riskLevel"`
	Issues                   []string                 `json:"issues"`
	Interactions             []Interaction            `json:"interactions"`
	Contraindications        []Contraindication       `json:"contraindications"`
	DosingConcerns           []DosingConcern          `json:"dosingConcerns"`
	Plan                     Plan                     `json:"plan"`
	Alternatives             []Alternative            `json:"alternatives"`
	ConfidenceScore          float64                  `json:"confidenceScore"`
	RecommendationConfidence RecommendationConfidence `json:"recommendationConfidence"`
	Source                   string                   `json:"source"`
}

type Interaction struct {
	Pair     string `json:"pair"`
	Severity string `json:"severity"`
	Note     string `json:"note"`
}

type Contraindication struct {
	ConditionOrAllergy string `json:"conditionOrAllergy"`
	Severity           string `json:"severity"`
	Note               string `json:"note"`
}

type DosingConcern struct {
	Factor         string `json:"factor"`
	Severity       string `json:"severity"`
	Recommendation string `json:"recommendation"`
}

type Alternative struct {
	Option     string  `json:"option"`
	Confidence float64 `json:"confidence"`
}

type RecommendationConfidence struct {
	Plan float64 `json:"plan"`
}

type validationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

const systemPrompt = `
You are GoRocky Clinical AI, a high-precision medical decision support engine.
Analyze the patient intake data and provide a structured JSON treatment plan.

Patient intake fields: name, age, weight, height, BMI, blood pressure, lifestyle (smoking, alcohol, exercise), conditions, medications (with details), allergies, complaint.

*** CRITICAL MEDICAL RULES (STRICT ENFORCEMENT) ***
1. [CONTRAINDICATION - HIGH] Nitrates (Nitroglycerin, Isosorbide) + PDE5 inhibitors (Sildenafil, Tadalafil, Vardenafil, Avanafil) -> Risk of profound hypotension. Do NOT co-administer.
2. [CONTRAINDICATION - HIGH] PDE5 inhibitor allergy or nitrate allergy -> Avoid prescribing PDE5 inhibitors.
3. [INTERACTION - MEDIUM] Alpha-blockers (Tamsulosin, Terazosin, Doxazosin, Alfuzosin) + PDE5 inhibitors -> Separate dosing, start low.
4. [INTERACTION - MEDIUM] Strong CYP3A4 inhibitors (Ketoconazole, Itraconazole, Ritonavir, Cobicistat, Clarithromycin) + PDE5 inhibitors -> Use lowest dose / avoid high doses.
5. [DOSING - MEDIUM] Renal impairment (Kidney Disease) -> Start with lower PDE5 inhibitor dose (2.5mg/5mg daily max).
6. [DOSING - MEDIUM] Age > 65 -> Start with lower dose.
7. [CONTRAINDICATION - MEDIUM] Pregnancy -> Avoid PDE5 inhibitor use (safety not established).
8. [CAUTION] Heart disease or uncontrolled hypertension -> Assess hemodynamic risk; prefer low dose or alternative.

*** REQUIRED OUTPUT FORMAT (JSON ONLY) ***
Return valid JSON (no markdown) matching:
{
  "riskScore": number (0-100),
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "issues": ["List of contraindications/interactions/dosing warnings"],
  "interactions": [{"pair": "Drug A + Drug B/Class", "severity": "HIGH"|"MEDIUM"|"LOW", "note": "clinical rationale"}],
  "contraindications": [{"conditionOrAllergy": "string", "severity": "HIGH"|"MEDIUM"|"LOW", "note": "clinical rationale"}],
  "dosingConcerns": [{"factor": "age|renal|hepatic|other", "severity": "HIGH"|"MEDIUM"|"LOW", "recommendation": "actionable guidance"}],
  "plan": {
    "medication": "Drug Name" | "None",
    "dosage": "e.g. 2.5mg Daily",
    "duration": "e.g. 30 Days",
    "rationale": "Concise clinical reasoning"
  },
  "alternatives": ["Alternative 1", "Alternative 2"],
  "confidenceScore": number (0.0 to 1.0),
  "source": "model" | "rules" | "rules+model"
}
`

var (
	pde5iClass        = []string{"sildenafil", "tadalafil", "vardenafil", "avanafil"}
	nitrateClass      = []string{"nitroglycerin", "isosorbide", "isosorbide dinitrate", "isosorbide mononitrate"}
	alphaBlockerClass = []string{"tamsulosin", "doxazosin", "terazosin", "alfuzosin"}
	cyp3a4Class       = []string{"ketoconazole", "itraconazole", "ritonavir", "cobicistat", "clarithromycin"}
	ruleDB            = []Rule{
		{ID: "nitrates+pde5i", Type: "interaction", Severity: "HIGH", Match: RuleMatch{DrugClassA: "nitrates", DrugClassB: "pde5i"}, Note: "Risk of profound hypotension; avoid co-administration."},
		{ID: "alpha+pde5i", Type: "interaction", Severity: "MEDIUM", Match: RuleMatch{DrugClassA: "alphaBlockers", DrugClassB: "pde5i"}, Note: "Additive hypotension; separate dosing and start low."},
		{ID: "cyp3a4+pde5i", Type: "interaction", Severity: "MEDIUM", Match: RuleMatch{DrugClassA: "cyp3a4Inhibitors", DrugClassB: "pde5i"}, Note: "Higher PDE5i levels; use lowest dose and monitor."},
		{ID: "pregnancy+pde5i", Type: "contra", Severity: "MEDIUM", Match: RuleMatch{Condition: "pregnant", RequiresDrugClass: "pde5i"}, Note: "Safety in pregnancy not established; avoid PDE5 inhibitors."},
		{ID: "renal+pde5i", Type: "dosing", Severity: "MEDIUM", Match: RuleMatch{Condition: "kidney disease"}, Note: "Max 2.5-5mg daily; monitor closely."},
	}
	severityWeight = map[string]int{
		"HIGH":   40,
		"MEDIUM": 20,
		"LOW":    10,
	}
	httpClient = &http.Client{Timeout: 15 * time.Second}
)

type Rule struct {
	ID       string    `json:"id"`
	Type     string    `json:"type"` // interaction|contra|dosing
	Severity string    `json:"severity"`
	Match    RuleMatch `json:"match"`
	Note     string    `json:"note"`
}

type RuleMatch struct {
	DrugClassA        string `json:"drugClassA"`
	DrugClassB        string `json:"drugClassB"`
	Condition         string `json:"condition"`
	RequiresDrugClass string `json:"requiresDrugClass"`
}

func main() {
	gin.SetMode(getEnv("GIN_MODE", "release"))

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	ctx := context.Background()
	var db HealthChecker
	if cfg.EnableDB {
		db, err = connectDB(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("database connection failed: %v", err)
		}
		defer db.(interface{ Close() }).Close()
	}

	staticRoot := detectStaticRoot()
	router := setupRouter(db, staticRoot, cfg)
	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	log.Printf("server listening on :%s", cfg.Port)
	waitForShutdown(server)
}

func loadConfig() (*Config, error) {
	_ = godotenv.Load()

	cfg := &Config{
		Port:         getEnv("PORT", "8080"),
		DatabaseURL:  os.Getenv("DATABASE_URL"),
		GeminiAPIKey: os.Getenv("GEMINI_API_KEY"),
		OpenAIAPIKey: os.Getenv("OPENAI_API_KEY"),
		EnableDB:     strings.EqualFold(getEnv("ENABLE_DB", "false"), "true"),
	}

	if cfg.EnableDB && cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required when ENABLE_DB=true")
	}

	return cfg, nil
}

func connectDB(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}

	return pool, nil
}

func setupRouter(db HealthChecker, staticRoot string, cfg *Config) *gin.Engine {
	router := gin.New()
	router.Use(
		gin.Logger(),
		gin.Recovery(),
		limitBodySize(1<<20), // 1MB max body
		cors.New(cors.Config{
			AllowOrigins: []string{"*"},
			AllowMethods: []string{"GET", "POST", "OPTIONS"},
			AllowHeaders: []string{"Origin", "Content-Type", "Authorization"},
			MaxAge:       12 * time.Hour,
		}),
	)

	// Serve static frontend from repository root under /static and root index.
	router.Static("/static", staticRoot)
	router.StaticFile("/", filepath.Join(staticRoot, "index.html"))
	router.StaticFile("/styles.css", filepath.Join(staticRoot, "styles.css"))
	router.StaticFile("/app.js", filepath.Join(staticRoot, "app.js"))
	router.StaticFile("/config.js", filepath.Join(staticRoot, "config.js"))

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	router.GET("/readyz", func(c *gin.Context) {
		if db == nil {
			c.JSON(http.StatusOK, gin.H{"status": "ok", "db": "disabled"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()

		dbStatus := "ok"
		if err := db.Ping(ctx); err != nil {
			dbStatus = fmt.Sprintf("unhealthy: %v", err)
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"status": "degraded",
				"db":     dbStatus,
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"status": "ok",
			"db":     dbStatus,
		})
	})

	router.POST("/api/diagnostics/mock", func(c *gin.Context) {
		var payload PatientData
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
			return
		}

		if errs := validatePatientData(payload); len(errs) > 0 {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error":  "validation_failed",
				"issues": errs,
			})
			return
		}

		result := mockAnalyze(payload)
		c.JSON(http.StatusOK, result)
	})

	router.POST("/api/diagnostics/gemini", func(c *gin.Context) {
		if cfg.GeminiAPIKey == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "gemini_unavailable", "reason": "missing_api_key"})
			return
		}
		var payload PatientData
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
			return
		}
		if errs := validatePatientData(payload); len(errs) > 0 {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error":  "validation_failed",
				"issues": errs,
			})
			return
		}
		resp, err := proxyGemini(c.Request.Context(), cfg.GeminiAPIKey, payload)
		if err != nil {
			log.Printf("gemini proxy error: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "gemini_proxy_failed", "details": err.Error()})
			return
		}
		c.JSON(http.StatusOK, resp)
	})

	router.POST("/api/diagnostics/openai", func(c *gin.Context) {
		if cfg.OpenAIAPIKey == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "openai_unavailable", "reason": "missing_api_key"})
			return
		}
		var payload PatientData
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
			return
		}
		if errs := validatePatientData(payload); len(errs) > 0 {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error":  "validation_failed",
				"issues": errs,
			})
			return
		}
		resp, err := proxyOpenAI(c.Request.Context(), cfg.OpenAIAPIKey, payload)
		if err != nil {
			log.Printf("openai proxy error: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "openai_proxy_failed", "details": err.Error()})
			return
		}
		c.JSON(http.StatusOK, resp)
	})

	router.GET("/api/config", func(c *gin.Context) {
		// Determine a sensible default model: respect env override, else pick the first available.
		envDefault := strings.ToLower(getEnv("DEFAULT_MODEL", ""))
		modelAvailability := map[string]bool{
			"mock":   true,
			"gemini": cfg.GeminiAPIKey != "",
			"openai": cfg.OpenAIAPIKey != "",
		}

		// Force OpenAI when available; allow explicit env override for non-mock values.
		defaultModel := ""
		if envDefault != "" && envDefault != "mock" && modelAvailability[envDefault] {
			defaultModel = envDefault
		}

		if defaultModel == "" {
			switch {
			case modelAvailability["openai"]:
				defaultModel = "openai"
			case modelAvailability["gemini"]:
				defaultModel = "gemini"
			default:
				defaultModel = "mock"
			}
		}

		cfgResp := map[string]any{
			"defaultModel": defaultModel,
			"models":       modelAvailability,
			"llmProxy":     true,
		}
		c.JSON(http.StatusOK, cfgResp)
	})

	return router
}

func proxyGemini(ctx context.Context, apiKey string, data PatientData) (map[string]any, error) {
	bodyBytes, err := json.Marshal(map[string]any{
		"contents": []map[string]any{
			{"parts": []map[string]string{{"text": fmt.Sprintf("Patient Data: %s", toJSON(data))}}},
		},
		"systemInstruction": map[string]any{
			"parts": []map[string]string{{"text": systemPrompt}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=%s", apiKey), bytes.NewBuffer(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call gemini: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("gemini status %d", resp.StatusCode)
	}

	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode gemini response: %w", err)
	}
	if len(parsed.Candidates) == 0 || len(parsed.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("gemini response missing content")
	}
	rawText := cleanupJSONText(parsed.Candidates[0].Content.Parts[0].Text)
	var out map[string]any
	if err := json.Unmarshal([]byte(rawText), &out); err != nil {
		return nil, fmt.Errorf("unmarshal gemini payload: %w", err)
	}
	return out, nil
}

func proxyOpenAI(ctx context.Context, apiKey string, data PatientData) (map[string]any, error) {
	bodyBytes, err := json.Marshal(map[string]any{
		"model": "gpt-4o",
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": toJSON(data)},
		},
		"response_format": map[string]string{"type": "json_object"},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/chat/completions", bytes.NewBuffer(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call openai: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("openai status %d", resp.StatusCode)
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode openai response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("openai response missing choices")
	}
	rawText := cleanupJSONText(parsed.Choices[0].Message.Content)
	var out map[string]any
	if err := json.Unmarshal([]byte(rawText), &out); err != nil {
		return nil, fmt.Errorf("unmarshal openai payload: %w", err)
	}
	return out, nil
}

func cleanupJSONText(s string) string {
	s = strings.ReplaceAll(s, "```json", "")
	s = strings.ReplaceAll(s, "```", "")
	return strings.TrimSpace(s)
}

func toJSON(data any) string {
	b, err := json.Marshal(data)
	if err != nil {
		return ""
	}
	return string(b)
}

func mockAnalyze(data PatientData) DiagnosticResult {
	return runSafetyEngine(data)
}

func runSafetyEngine(data PatientData) DiagnosticResult {
	meds := normalizeList(data.Medications)
	allergies := normalizeList(data.Allergies)

	conditions := make([]string, 0, len(data.Conditions))
	for _, c := range data.Conditions {
		conditions = append(conditions, strings.ToLower(strings.TrimSpace(c)))
	}

	hasPDE5i := hasClassToken(meds, pde5iClass)
	hasNitrates := hasClassToken(meds, nitrateClass)
	hasAlphaBlocker := hasClassToken(meds, alphaBlockerClass)
	hasCyp3a4 := hasClassToken(meds, cyp3a4Class)
	bpSys := data.BPSystolic
	bpDia := data.BPDiastolic
	bmi := data.BMI
	smoking := strings.ToLower(strings.TrimSpace(data.Smoking))
	alcohol := strings.ToLower(strings.TrimSpace(data.Alcohol))
	exercise := strings.ToLower(strings.TrimSpace(data.Exercise))

	pregnant := containsString(conditions, "pregnant")
	kidneyDisease := containsString(conditions, "kidney disease")
	liverDisease := containsString(conditions, "liver disease")
	heartDisease := containsString(conditions, "heart disease")
	hypertension := containsString(conditions, "hypertension")

	allergyToPde5i := hasClassToken(allergies, pde5iClass)
	allergyToNitrates := hasClassToken(allergies, nitrateClass)

	interactions := []Interaction{}
	contraindications := []Contraindication{}
	dosingConcerns := []DosingConcern{}

	if hasPDE5i && hasNitrates {
		interactions = append(interactions, Interaction{
			Pair:     "Nitrates + PDE5i",
			Severity: "HIGH",
			Note:     "Risk of profound hypotension; avoid co-administration.",
		})
	}
	if hasPDE5i && hasAlphaBlocker {
		interactions = append(interactions, Interaction{
			Pair:     "Alpha-blocker + PDE5i",
			Severity: "MEDIUM",
			Note:     "Additive hypotension; separate dosing and start low.",
		})
	}
	if hasPDE5i && hasCyp3a4 {
		interactions = append(interactions, Interaction{
			Pair:     "Strong CYP3A4 inhibitor + PDE5i",
			Severity: "MEDIUM",
			Note:     "Higher PDE5i levels; use lowest dose and monitor.",
		})
	}

	for _, rule := range ruleDB {
		switch rule.Type {
		case "interaction":
			if hasClassTokenByName(meds, rule.Match.DrugClassA) && hasClassTokenByName(meds, rule.Match.DrugClassB) {
				interactions = append(interactions, Interaction{
					Pair:     fmt.Sprintf("%s+%s", rule.Match.DrugClassA, rule.Match.DrugClassB),
					Severity: rule.Severity,
					Note:     rule.Note,
				})
			}
		case "contra":
			condMatch := rule.Match.Condition != "" && containsString(conditions, rule.Match.Condition)
			drugMatch := rule.Match.RequiresDrugClass == "" || hasClassTokenByName(meds, rule.Match.RequiresDrugClass)
			if condMatch && drugMatch {
				contraindications = append(contraindications, Contraindication{
					ConditionOrAllergy: rule.Match.Condition,
					Severity:           rule.Severity,
					Note:               rule.Note,
				})
			}
		case "dosing":
			if rule.Match.Condition != "" && containsString(conditions, rule.Match.Condition) {
				dosingConcerns = append(dosingConcerns, DosingConcern{
					Factor:         rule.Match.Condition,
					Severity:       rule.Severity,
					Recommendation: rule.Note,
				})
			}
		}
	}

	if hasNitrates {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Nitrate therapy",
			Severity:           "HIGH",
			Note:               "Concurrent nitrate use contraindicates PDE5 inhibitors due to hypotension risk.",
		})
	}
	if bpSys >= 170 || bpDia >= 110 {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Severely elevated BP",
			Severity:           "HIGH",
			Note:               "Uncontrolled hypertension; PDE5 inhibitors contraindicated.",
		})
	} else if bpSys >= 150 || bpDia >= 95 {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Elevated BP",
			Severity:           "MEDIUM",
			Note:               "Elevated blood pressure; use lowest dose and monitor.",
		})
	}
	if allergyToPde5i {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "PDE5 inhibitor allergy",
			Severity:           "HIGH",
			Note:               "Do not prescribe PDE5 inhibitors.",
		})
	}
	if allergyToNitrates {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Nitrate allergy",
			Severity:           "HIGH",
			Note:               "Avoid nitrates and PDE5 co-prescribing.",
		})
	}
	if pregnant {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Pregnancy",
			Severity:           "MEDIUM",
			Note:               "Safety not established; avoid PDE5 inhibitors.",
		})
	}
	if heartDisease {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Heart Disease",
			Severity:           "MEDIUM",
			Note:               "Assess hemodynamic reserve; prefer low dose or alternative.",
		})
	}
	if hypertension {
		contraindications = append(contraindications, Contraindication{
			ConditionOrAllergy: "Hypertension",
			Severity:           "MEDIUM",
			Note:               "Monitor BP; start low to avoid hypotension.",
		})
	}

	if data.Age >= 65 {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Age >65",
			Severity:       "MEDIUM",
			Recommendation: "Initiate at lowest dose; titrate cautiously.",
		})
	}
	if kidneyDisease {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Renal impairment",
			Severity:       "MEDIUM",
			Recommendation: "Max 2.5mg-5mg daily; monitor for hypotension.",
		})
	}
	if liverDisease {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Hepatic impairment",
			Severity:       "MEDIUM",
			Recommendation: "Use lowest dose; consider avoiding if severe.",
		})
	}
	if bmi >= 35 {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Obesity (BMI ≥35)",
			Severity:       "MEDIUM",
			Recommendation: "Start lowest dose; monitor cardiovascular tolerance.",
		})
	} else if bmi >= 30 {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Overweight (BMI ≥30)",
			Severity:       "LOW",
			Recommendation: "Start low; encourage weight management and monitoring.",
		})
	}
	if smoking == "current" {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Smoking",
			Severity:       "LOW",
			Recommendation: "Counsel cessation; monitor CV risk with therapy.",
		})
	}
	if alcohol == "heavy" {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Heavy alcohol use",
			Severity:       "MEDIUM",
			Recommendation: "Avoid concurrent dosing; monitor BP and sedation risk.",
		})
	}
	if exercise == "none" {
		dosingConcerns = append(dosingConcerns, DosingConcern{
			Factor:         "Sedentary",
			Severity:       "LOW",
			Recommendation: "Encourage activity; monitor cardiometabolic risk.",
		})
	}

	allFindings := len(interactions) + len(contraindications) + len(dosingConcerns)
	maxSeverity := "LOW"
	for _, i := range interactions {
		if i.Severity == "HIGH" {
			maxSeverity = "HIGH"
			break
		}
		if i.Severity == "MEDIUM" && maxSeverity == "LOW" {
			maxSeverity = "MEDIUM"
		}
	}
	if maxSeverity != "HIGH" {
		for _, c := range contraindications {
			if c.Severity == "HIGH" {
				maxSeverity = "HIGH"
				break
			}
			if c.Severity == "MEDIUM" && maxSeverity == "LOW" {
				maxSeverity = "MEDIUM"
			}
		}
	}
	if maxSeverity != "HIGH" {
		for _, d := range dosingConcerns {
			if d.Severity == "MEDIUM" && maxSeverity == "LOW" {
				maxSeverity = "MEDIUM"
			}
		}
	}

	score := 5
	for _, i := range interactions {
		score += severityWeight[i.Severity]
	}
	for _, c := range contraindications {
		score += severityWeight[c.Severity]
	}
	for _, d := range dosingConcerns {
		score += severityWeight[d.Severity]
	}
	if score > 100 {
		score = 100
	}

	riskLevel := "LOW"
	if maxSeverity == "HIGH" || score >= 60 {
		riskLevel = "HIGH"
	} else if maxSeverity == "MEDIUM" || score >= 30 {
		riskLevel = "MEDIUM"
	}

	issues := []string{}
	for _, i := range interactions {
		issues = append(issues, fmt.Sprintf("[%s] Interaction: %s - %s", i.Severity, i.Pair, i.Note))
	}
	for _, c := range contraindications {
		issues = append(issues, fmt.Sprintf("[%s] Contraindication: %s - %s", c.Severity, c.ConditionOrAllergy, c.Note))
	}
	for _, d := range dosingConcerns {
		issues = append(issues, fmt.Sprintf("[%s] Dosing: %s - %s", d.Severity, d.Factor, d.Recommendation))
	}
	if len(issues) == 0 {
		issues = append(issues, "None")
	}

	medication := "Tadalafil"
	dosage := "5mg Daily"
	duration := "90 Days"
	highBlocker := hasSeverity(interactions, "HIGH") || hasSeverityContra(contraindications, "HIGH")

	if highBlocker {
		medication = "None"
		dosage = "N/A"
		duration = "N/A"
	} else if data.Age >= 65 || kidneyDisease || liverDisease || hasAlphaBlocker || hasCyp3a4 || hypertension || heartDisease {
		dosage = "2.5mg Daily"
		duration = "30 Days"
	}

	rationaleParts := []string{}
	if medication == "None" {
		rationaleParts = append(rationaleParts, "Safety blockers present; pharmacotherapy deferred.")
	} else {
		rationaleParts = append(rationaleParts, "PDE5 inhibitor indicated; starting conservatively due to risk factors.")
	}
	if data.Age >= 65 {
		rationaleParts = append(rationaleParts, "Age >65")
	}
	if kidneyDisease {
		rationaleParts = append(rationaleParts, "Renal impairment")
	}
	if liverDisease {
		rationaleParts = append(rationaleParts, "Hepatic impairment")
	}
	if hasAlphaBlocker {
		rationaleParts = append(rationaleParts, "Alpha-blocker co-therapy")
	}
	if hasCyp3a4 {
		rationaleParts = append(rationaleParts, "CYP3A4 inhibitor present")
	}
	if heartDisease {
		rationaleParts = append(rationaleParts, "Cardiovascular history")
	}
	if pregnant {
		rationaleParts = append(rationaleParts, "Pregnancy")
	}

	confidence := 1 - float64(score)/120
	if confidence < 0.6 {
		confidence = 0.6
	}

	planConfidence := confidence
	alternatives := []Alternative{
		{Option: "Sildenafil 25mg on demand", Confidence: 0.7},
		{Option: "Vardenafil 10mg", Confidence: 0.65},
		{Option: "Behavioral therapy", Confidence: 0.6},
	}
	if medication == "None" {
		alternatives = []Alternative{
			{Option: "Vacuum erection device", Confidence: 0.65},
			{Option: "Specialist referral", Confidence: 0.7},
		}
		planConfidence = 0.4
	}

	result := DiagnosticResult{
		RiskScore:         score,
		RiskLevel:         riskLevel,
		Issues:            issues,
		Interactions:      interactions,
		Contraindications: contraindications,
		DosingConcerns:    dosingConcerns,
		Plan: Plan{
			Medication: medication,
			Dosage:     dosage,
			Duration:   duration,
			Rationale:  strings.Join(rationaleParts, "; "),
		},
		Alternatives:             alternatives,
		ConfidenceScore:          confidence,
		RecommendationConfidence: RecommendationConfidence{Plan: planConfidence},
		Source:                   "rules",
	}

	if allFindings == 0 {
		result.RiskScore = 12
		result.RiskLevel = "LOW"
	}

	return result
}

func normalizeList(text string) []string {
	out := []string{}
	for _, t := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return r == ',' || r == ';'
	}) {
		trimmed := strings.TrimSpace(t)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func hasClassToken(tokens []string, class []string) bool {
	for _, t := range tokens {
		for _, drug := range class {
			if strings.Contains(t, drug) {
				return true
			}
		}
	}
	return false
}

func hasClassTokenByName(tokens []string, className string) bool {
	switch className {
	case "pde5i":
		return hasClassToken(tokens, pde5iClass)
	case "nitrates":
		return hasClassToken(tokens, nitrateClass)
	case "alphaBlockers":
		return hasClassToken(tokens, alphaBlockerClass)
	case "cyp3a4Inhibitors":
		return hasClassToken(tokens, cyp3a4Class)
	default:
		return false
	}
}

func containsString(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}

func hasSeverity(items []Interaction, severity string) bool {
	for _, i := range items {
		if i.Severity == severity {
			return true
		}
	}
	return false
}

func hasSeverityContra(items []Contraindication, severity string) bool {
	for _, i := range items {
		if i.Severity == severity {
			return true
		}
	}
	return false
}

func validatePatientData(p PatientData) []validationError {
	var errs []validationError

	add := func(field, msg string) {
		errs = append(errs, validationError{Field: field, Message: msg})
	}

	if strings.TrimSpace(p.Name) == "" {
		add("name", "Name is required.")
	}

	if p.Age < 0 || p.Age > 120 {
		add("age", "Age must be between 0 and 120.")
	}

	if p.Height < 0 || (p.Height > 0 && (p.Height < 90 || p.Height > 250)) {
		add("height", "Height must be between 90 and 250 cm when provided.")
	}

	if p.Weight < 0 || (p.Weight > 0 && (p.Weight < 25 || p.Weight > 350)) {
		add("weight", "Weight must be between 25 and 350 kg when provided.")
	}

	if (p.BPSystolic > 0 && p.BPSystolic < 50) || (p.BPDiastolic > 0 && p.BPDiastolic < 30) {
		add("bloodPressure", "Blood pressure values are implausible.")
	}

	if containsString(lowerSlice(p.Conditions), "hypertension") && (p.BPSystolic == 0 || p.BPDiastolic == 0) {
		add("bloodPressure", "Blood pressure is required when hypertension is selected.")
	}

	return errs
}

func lowerSlice(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		out = append(out, strings.ToLower(strings.TrimSpace(v)))
	}
	return out
}

func waitForShutdown(server *http.Server) {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Println("shutting down server...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func limitBodySize(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}

func detectStaticRoot() string {
	startDir, err := os.Getwd()
	if err != nil {
		return "."
	}

	candidates := []string{
		startDir,
		filepath.Dir(startDir),
		filepath.Dir(filepath.Dir(startDir)),
	}

	for _, dir := range candidates {
		if fileExists(filepath.Join(dir, "index.html")) {
			return dir
		}
	}

	return startDir
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}
