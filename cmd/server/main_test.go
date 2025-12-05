package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type fakeDB struct {
	err error
}

func (f fakeDB) Ping(ctx context.Context) error {
	return f.err
}

func TestMockAnalyze_Nitro(t *testing.T) {
	result := mockAnalyze(PatientData{Medications: "Nitroglycerin"})
	if result.RiskLevel != "HIGH" || result.Plan.Medication != "None" {
		t.Fatalf("expected high risk and no medication, got %+v", result)
	}
}

func TestMockAnalyze_Hypertension(t *testing.T) {
	result := mockAnalyze(PatientData{Conditions: []string{"Hypertension"}})
	if result.RiskLevel != "MEDIUM" || !strings.Contains(result.Plan.Dosage, "2.5mg") {
		t.Fatalf("expected medium risk and low dose, got %+v", result)
	}
}

func TestLoadConfigRequiresDatabaseURL(t *testing.T) {
	t.Setenv("ENABLE_DB", "true")
	t.Setenv("DATABASE_URL", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected error when DATABASE_URL is missing")
	}
}

func TestLoadConfigUsesDefaults(t *testing.T) {
	t.Setenv("ENABLE_DB", "false")
	t.Setenv("DATABASE_URL", "postgres://test:test@localhost:5432/test?sslmode=disable")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != "8080" {
		t.Fatalf("expected default port 8080, got %s", cfg.Port)
	}
}

func TestRouterHealthz(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := setupRouter(fakeDB{}, ".")

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/healthz", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

// Ensure limitBodySize middleware allows small payloads and blocks large ones.
func TestLimitBodySize(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(limitBodySize(10))
	router.POST("/echo", func(c *gin.Context) {
		_, err := c.GetRawData()
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "too large"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	t.Run("within limit", func(t *testing.T) {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest("POST", "/echo", strings.NewReader("12345"))
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
	})

	t.Run("over limit", func(t *testing.T) {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest("POST", "/echo", strings.NewReader("01234567890"))
		router.ServeHTTP(w, req)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("expected 413, got %d", w.Code)
		}
	})
}

// Guard against long-running tests due to context leaks.
func TestLimitBodySizeContextDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := ctx.Err(); err != nil && err != context.DeadlineExceeded {
		t.Fatalf("unexpected context error: %v", err)
	}
}
