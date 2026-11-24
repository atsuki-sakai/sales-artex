package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSessionUsesUpdatedDotenv(t *testing.T) {
	for _, name := range []string{"OPENAI_API_KEY", "SALES_EXPERT_MODEL"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(t.TempDir(), ".env")
	write := func(contents string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-rotated" {
			t.Error("session did not pick up the rotated file value")
		}
		w.WriteHeader(201)
		w.Write([]byte(`{"session":{"id":"test"},"transport":{"sdp":"v=0"}}`))
	}))
	defer upstream.Close()
	handler := app{envFile: path, endpoint: upstream.URL, client: upstream.Client(), port: "8787"}.routes()
	config := func(want bool) {
		t.Helper()
		response := requestApp(handler, "GET", localHost, "/api/config", "", nil)
		var info struct{ Configured bool }
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &info) != nil || info.Configured != want || strings.Contains(response.Body.String(), "test-secret") {
			t.Error("unexpected public configuration")
		}
	}
	config(false)
	write("OPENAI_API_KEY='test-secret'\n")
	config(true)
	write("OPENAI_API_KEY=test-rotated\n")
	if result := requestApp(handler, "POST", localHost, "/api/session", localOrigin, sessionPayload(t, sample)); result.Code != 201 {
		t.Errorf("session status %d", result.Code)
	}
	write("OPENAI_API_KEY=\n")
	config(false)
	t.Setenv("OPENAI_API_KEY", "override")
	config(true)
	write("bad!key=test-secret\n")
	response := requestApp(handler, "GET", localHost, "/api/config", "", nil)
	if response.Code != 500 || strings.Contains(response.Body.String(), "test-secret") {
		t.Error("malformed dotenv should return a redacted error")
	}
}
