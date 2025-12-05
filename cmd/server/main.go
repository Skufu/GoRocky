package main

import (
	"context"
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
	Name        string   `json:"name"`
	Weight      float64  `json:"weight"`
	Height      float64  `json:"height"`
	Conditions  []string `json:"conditions"`
	Medications string   `json:"medications"`
	Complaint   string   `json:"complaint"`
}

type Plan struct {
	Medication string `json:"medication"`
	Dosage     string `json:"dosage"`
	Duration   string `json:"duration"`
	Rationale  string `json:"rationale"`
}

type DiagnosticResult struct {
	RiskScore       int      `json:"riskScore"`
	RiskLevel       string   `json:"riskLevel"`
	Issues          []string `json:"issues"`
	Plan            Plan     `json:"plan"`
	Alternatives    []string `json:"alternatives"`
	ConfidenceScore float64  `json:"confidenceScore"`
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
	router := setupRouter(db, staticRoot)
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

func setupRouter(db HealthChecker, staticRoot string) *gin.Engine {
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

		result := mockAnalyze(payload)
		c.JSON(http.StatusOK, result)
	})

	return router
}

func mockAnalyze(data PatientData) DiagnosticResult {
	meds := strings.ToLower(data.Medications)
	isNitro := strings.Contains(meds, "nitro") || strings.Contains(meds, "isosorbide")
	isHTN := containsValue(data.Conditions, "Hypertension")

	switch {
	case isNitro:
		return DiagnosticResult{
			RiskScore: 98,
			RiskLevel: "HIGH",
			Issues: []string{
				"ABSOLUTE CONTRAINDICATION: Nitrates detected",
				"Risk of fatal hypotension",
			},
			Plan: Plan{
				Medication: "None",
				Dosage:     "N/A",
				Duration:   "N/A",
				Rationale:  "Patient takes nitrates. PDE5 inhibitors are absolutely contraindicated.",
			},
			Alternatives:    []string{"Vacuum Erection Device (VED)", "Intracavernosal Injections (Specialist)"},
			ConfidenceScore: 0.99,
		}
	case isHTN:
		return DiagnosticResult{
			RiskScore: 45,
			RiskLevel: "MEDIUM",
			Issues: []string{
				"Hypertension history - monitor BP",
				"Potential additive hypotensive effect",
			},
			Plan: Plan{
				Medication: "Tadalafil",
				Dosage:     "2.5mg Daily",
				Duration:   "30 Days",
				Rationale:  "Starting low dose due to cardiovascular history. Monitor BP.",
			},
			Alternatives:    []string{"Sildenafil 25mg on demand"},
			ConfidenceScore: 0.92,
		}
	default:
		return DiagnosticResult{
			RiskScore: 12,
			RiskLevel: "LOW",
			Issues:    []string{"None"},
			Plan: Plan{
				Medication: "Tadalafil",
				Dosage:     "5mg Daily",
				Duration:   "90 Days",
				Rationale:  "Standard protocol. Patient fits safety profile.",
			},
			Alternatives:    []string{"Sildenafil 50mg on demand", "Vardenafil 10mg"},
			ConfidenceScore: 0.98,
		}
	}
}

func containsValue(values []string, target string) bool {
	for _, v := range values {
		if strings.EqualFold(v, target) {
			return true
		}
	}
	return false
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
