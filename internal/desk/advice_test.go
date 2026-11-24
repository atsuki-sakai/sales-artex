package desk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"sales-artex/internal/openai"
)

func TestBackgroundAdvice(t *testing.T) {
	input := []byte(`{"product":"見積作成","goal":"利用条件の比較","target":"設備会社","transcript":"予算と納期を比較したいです"}`)
	for _, tc := range []struct {
		name, expert, origin, result, output string
		upstream, status, calls              int
	}{
		{"select action", "responses-compatible", localOrigin, "completed", `{"action":"compare_options","other":"untrusted"}`, 200, 200, 1},
		{"no further sales action", "responses-compatible", localOrigin, "completed", `{"action":"no_action"}`, 200, 204, 1},
		{"invalid result", "responses-compatible", localOrigin, "completed", `{"action":"untrusted"}`, 200, 204, 1},
		{"incomplete", "responses-compatible", localOrigin, "incomplete", `{"action":"compare_options"}`, 200, 204, 1},
		{"disabled", "", localOrigin, "", "", 200, 204, 0},
		{"wrong origin", "responses-compatible", "http://other.test", "", "", 200, 403, 0},
		{"no upstream retry", "responses-compatible", localOrigin, "", "", 429, 502, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			handler := testAPI(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer "+mockKey {
					t.Error("invalid background request")
				}
				var got struct {
					Model, Input string
					Store        *bool

					MaxOutput int `json:"max_output_tokens"`
					Text      struct {
						Format struct {
							Type   string
							Strict bool
						}
					}
				}
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Error(err)
					return
				}
				if got.Model != "responses-compatible" || !strings.Contains(got.Input, "予算と納期") || got.Store == nil || *got.Store || got.MaxOutput != 192 || got.Text.Format.Type != "json_schema" || !got.Text.Format.Strict {
					t.Error("invalid inference config")
				}
				w.WriteHeader(tc.upstream)
				encoded, _ := json.Marshal(tc.output)
				fmt.Fprintf(w, `{"status":%q,"output":[{"type":"message","content":[{"type":"output_text","text":%s}]}]}`, tc.result, encoded)
			}, mockKey, tc.expert)
			rec := requestApp(handler, "POST", localHost, "/api/advice", tc.origin, input)
			if rec.Code != tc.status || int(calls.Load()) != tc.calls || strings.Contains(rec.Body.String(), "untrusted") {
				t.Fatalf("status=%d, calls=%d", rec.Code, calls.Load())
			}
			if rec.Code == 200 && strings.TrimSpace(rec.Body.String()) != `{"action":"compare_options"}` {
				t.Fatal("expected a single validated action")
			}
		})
	}
}

func TestLunaUsesSingleDecisionsChoice(t *testing.T) {
	input := openai.AdviceInput{Product: "見積支援", Goal: "次回の面談", Target: "設備業", Transcript: "費用と使いやすさを比較したい"}
	payload, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, upstream string
		status         int
	}{
		{"choice", `{"answers":[{"type":"choice","name":"action","choice":"compare_options"}]}`, 200},
		{"no advice needed", `{"answers":[{"type":"choice","name":"action","choice":"no_action"}]}`, 204},
		{"refusal", `{"answers":[{"type":"refusal","name":"action"}]}`, 204},
		{"unknown choice", `{"answers":[{"type":"choice","name":"action","choice":"unknown"}]}`, 204},
		{"different question", `{"answers":[{"type":"choice","name":"other","choice":"compare_options"}]}`, 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			handler := testAPI(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/v1/decisions" || r.Header.Get("Authorization") != "Bearer "+mockKey {
					t.Error("unexpected Decisions request")
				}
				var request struct {
					Model string
					Input []struct {
						Role    string
						Content []struct {
							Type string
							Data openai.AdviceInput
						}
					}
					Questions []struct {
						Type, Name, Instructions string
						Choices                  []struct{ Value string }
					}
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					return
				}
				if request.Model != "gpt-6-luna" || len(request.Input) != 1 || request.Input[0].Role != "user" || len(request.Input[0].Content) != 1 || request.Input[0].Content[0].Type != "input_json" || request.Input[0].Content[0].Data != input || len(request.Questions) != 1 {
					t.Error("unexpected evidence/question count")
					return
				}
				q := request.Questions[0]
				var values []string
				for _, c := range q.Choices {
					values = append(values, c.Value)
				}
				wantChoices := []string{"no_action", "clarify_need", "compare_options", "confirm_constraints", "confirm_next_step", "respect_decline"}
				if q.Type != "choice" || q.Name != "action" || !strings.Contains(q.Instructions, "顧客本人の最新の発言と訂正を優先") || !reflect.DeepEqual(values, wantChoices) {
					t.Error("unexpected action choices or rubric")
				}
				io.WriteString(w, tc.upstream)
			}, mockKey, "gpt-6-luna")
			rec := requestApp(handler, "POST", localHost, "/api/advice", localOrigin, payload)
			if calls.Load() != 1 || rec.Code != tc.status {
				t.Fatalf("status=%d calls=%d", rec.Code, calls.Load())
			}
			if tc.status == 200 && strings.TrimSpace(rec.Body.String()) != `{"action":"compare_options"}` {
				t.Fatal("unexpected normalized decision")
			}
		})
	}
}

func TestVoiceCanStartWhileExpertRequestIsOutstanding(t *testing.T) {
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	handler := testAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/live/sessions" {
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{"session":{"id":"live_now"},"transport":{"sdp":"v=0"}}`)
			return
		}
		io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(5 * time.Second):
		}
	}, mockKey, "gpt-6-luna")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", localOrigin+"/api/advice", strings.NewReader(`{"product":"商材","goal":"面談","transcript":"比較希望"}`)).WithContext(ctx)
	req.Header.Set("Origin", localOrigin)
	done := make(chan struct{})
	go func() { defer close(done); handler.ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("expert did not start")
	}
	if response := requestApp(handler, "POST", localHost, "/api/session", localOrigin, sessionPayload(t, sample)); response.Code != 201 {
		t.Fatalf("voice startup failed while expert pending: %d", response.Code)
	}
	select {
	case <-done:
		t.Fatal("voice waited until expert finished")
	default:
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("aborting caller did not cancel upstream")
	}
	<-done
}
