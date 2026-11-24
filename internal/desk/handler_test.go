package desk

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sales-artex/internal/openai"
)

const localHost = "127.0.0.1:8787"
const localOrigin = "http://" + localHost
const mockKey = "test-only-long-lived-key"

var sample = openai.SessionInput{SDP: "v=0\r\ns=test offer\r\n", Product: "日報の集計", Goal: "相談内容の確認"}

func requestApp(handler http.Handler, method, host, path, origin string, payload []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+host+path, bytes.NewReader(payload))
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func sessionPayload(t *testing.T, s openai.SessionInput) []byte {
	t.Helper()
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testAPI(t *testing.T, upstream http.HandlerFunc, key, expert string) http.Handler {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	t.Setenv("OPENAI_API_KEY", key)
	t.Setenv("SALES_EXPERT_MODEL", expert)
	return NewHandler("8787", filepath.Join(t.TempDir(), ".env"), openai.NewClient(server.URL+"/v1"))
}

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
	handler := NewHandler("8787", path, openai.NewClient(upstream.URL+"/v1"))
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

func TestRejectMultipleJSONValues(t *testing.T) {
	handler := testAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("unexpected upstream call for concatenated JSON")
		w.WriteHeader(http.StatusBadRequest)
	}, mockKey, "gpt-6-luna")
	for _, tc := range []struct {
		path string
		body []byte
	}{
		{"/api/session", sessionPayload(t, sample)},
		{"/api/advice", []byte(`{"product":"商材","goal":"相談","transcript":"使い方を教えてください"}`)},
	} {
		t.Run(tc.path, func(t *testing.T) {
			body := append(tc.body, []byte(" {}")...)
			if rec := requestApp(handler, "POST", localHost, tc.path, localOrigin, body); rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", rec.Code)
			}
		})
	}
}
