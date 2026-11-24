package desk

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"sales-artex/internal/config"
	"sales-artex/internal/openai"
)

type handler struct {
	envFile string
	client  *openai.Client
}

// NewHandler serves the local sales desk and its browser-facing API.
func NewHandler(port, envFile string, client *openai.Client) http.Handler {
	h := handler{envFile: envFile, client: client}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", h.publicConfig)
	mux.HandleFunc("POST /api/session", requireSameOrigin(h.createSession))
	mux.HandleFunc("POST /api/advice", requireSameOrigin(h.advice))
	mux.Handle("GET /", http.FileServer(http.Dir("frontend/out")))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "127.0.0.1:"+port && r.Host != "localhost:"+port {
			http.Error(w, "ローカルホストを使用してください", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		mux.ServeHTTP(w, r)
	})
}

func requireSameOrigin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "接続元を確認してください", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (h handler) loadSettings(w http.ResponseWriter) (config.Settings, bool) {
	cfg, err := config.Load(h.envFile)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
	return cfg, err == nil
}

func (h handler) publicConfig(w http.ResponseWriter, _ *http.Request) {
	cfg, ok := h.loadSettings(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": cfg.APIKey != "", "model": openai.LiveModel, "expert": cfg.ExpertModel,
	})
}

func decodeRequest(w http.ResponseWriter, r *http.Request, limit int64, dst any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	return d.Decode(dst) == nil && d.Decode(new(any)) == io.EOF
}

func validBrief(product, goal, target string) bool {
	return strings.TrimSpace(product) != "" && utf8.RuneCountInString(product) <= 1600 &&
		strings.TrimSpace(goal) != "" && utf8.RuneCountInString(goal) <= 240 &&
		utf8.RuneCountInString(target) <= 1200
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
