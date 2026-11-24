package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const localHost = "127.0.0.1:8787"
const localOrigin = "http://" + localHost
const mockKey = "test-only-long-lived-key"

var sample = setup{SDP: "v=0\r\ns=test offer\r\n", Product: "日報の集計", Goal: "相談内容の確認"}

type liveInputMessage struct {
	Role    string
	Content []struct{ Type, Text string }
}

func requestApp(handler http.Handler, method, host, path, origin string, payload []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+host+path, bytes.NewReader(payload))
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func sessionPayload(t *testing.T, s setup) []byte {
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
	return app{envFile: filepath.Join(t.TempDir(), ".env"), endpoint: server.URL + "/v1/live/sessions", adviceEndpoint: server.URL + "/v1/responses", decisionsEndpoint: server.URL + "/v1/decisions", port: "8787", client: liveHTTPClient()}.routes()
}

// Check the precise fields needed to negotiate the SDP, configure wake-on-speech
// and allow the browser's coaching and interruption events.
func TestLiveSessionHandshake(t *testing.T) {
	for _, expert := range []string{"", "expert-test-model"} {
		name := "local-analysis"
		if expert != "" {
			name = "background-analysis"
		}
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			handler := testAPI(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/v1/live/sessions" || r.Header.Get("Authorization") != "Bearer "+mockKey || r.Header.Get("Content-Type") != "application/json" {
					t.Error("unexpected upstream request, route or headers")
				}
				var got struct {
					Transport struct{ Type, SDP string }
					Session   struct {
						Model, Instructions string
						Input               []liveInputMessage
						Triggers            []struct {
							Type      string
							EventType string `json:"event_type"`
							Decisions struct {
								Questions []struct {
									Type, Name, Instructions string
									Choices                  []struct{ Value string }
								}
							}
						}
						Store      *bool
						Audio      struct{ Output struct{ Voice string } }
						Wake       struct{ Type string } `json:"wake_policy"`
						Idle       int                   `json:"idle_timeout_s"`
						Delegation struct {
							AcknowledgementDelay int `json:"acknowledgement_delay_ms"`
							Type                 string
							Responses            *struct {
								Model, Instructions string
								Max                 int `json:"max_output_tokens"`
							}
						}
						Client struct {
							Channel struct {
								Events []string `json:"allowed_client_events"`
							} `json:"data_channel"`
						}
					}
				}
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Error(err)
					http.Error(w, "invalid fixture", 400)
					return
				}
				s := got.Session
				if got.Transport.Type != "webrtc" || got.Transport.SDP != sample.SDP || s.Model != liveModel || s.Audio.Output.Voice == "" || s.Wake.Type != "speech" || s.Idle <= 0 || s.Store == nil || *s.Store {
					t.Error("invalid Live transport or session configuration")
				}
				if s.Instructions != salesInstructions || len(s.Input) != 2 || s.Input[0].Role != "developer" || len(s.Input[0].Content) != 1 {
					t.Fatal("session needs the operator brief and the application's separate capabilities")
				}
				brief := s.Input[0].Content[0]
				if brief.Type != "input_text" || !strings.Contains(brief.Text, sample.Product) || !strings.Contains(brief.Text, sample.Goal) {
					t.Error("missing product or goal in the attributed brief")
				}
				checkDeskCapabilities(t, s.Input[1])
				if len(s.Triggers) != 1 || s.Triggers[0].Type != "decisions" || s.Triggers[0].EventType != "session.input_transcript.delta" || len(s.Triggers[0].Decisions.Questions) != 1 {
					t.Fatal("expected one conversation control trigger on the caller's speech")
				}
				q := s.Triggers[0].Decisions.Questions[0]
				var choices []string
				for _, c := range q.Choices {
					choices = append(choices, c.Value)
				}
				if q.Type != "choice" || q.Name != "conversation_control" || q.Instructions != controlInstructions || !reflect.DeepEqual(choices, []string{"none", "listen", "respond", "end_call"}) {
					t.Error("conversation control decisions do not match the browser's contract")
				}
				wantEvents := []string{"session.thinking.append", "session.commentary.append", "session.instructions.append", "session.close"}
				if !reflect.DeepEqual(s.Client.Channel.Events, wantEvents) {
					t.Errorf("unexpected events: %v", s.Client.Channel.Events)
				}
				d := s.Delegation
				if d.AcknowledgementDelay <= 0 || d.AcknowledgementDelay > 800 {
					t.Error("client delegation needs a supported spoken acknowledgement delay")
				}
				if d.Type != "client" || d.Responses != nil {
					t.Error("voice session could block on delegated expert inference")
				}
				w.WriteHeader(http.StatusCreated)
				fmt.Fprintf(w, `{"session":{"id":"live_test","credentials":"%s"},"transport":{"sdp":"v=0\r\ns=test answer\r\n"},"debug":"upstream-private"}`, mockKey)
			}, mockKey, expert)
			got := requestApp(handler, "POST", localHost, "/api/session", localOrigin, sessionPayload(t, sample))
			if calls.Load() != 1 || got.Code != 201 || got.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("handshake status=%d upstream requests=%d", got.Code, calls.Load())
			}
			var answer map[string]map[string]string
			if err := json.Unmarshal(got.Body.Bytes(), &answer); err != nil {
				t.Fatal(err)
			}
			want := map[string]map[string]string{"session": {"id": "live_test"}, "transport": {"sdp": "v=0\r\ns=test answer\r\n"}}
			if !reflect.DeepEqual(answer, want) {
				t.Error("client did not receive only the session ID and SDP answer")
			}
			config := requestApp(handler, "GET", localHost, "/api/config", "", nil)
			if config.Code != 200 || strings.Contains(config.Body.String(), mockKey) || !strings.Contains(config.Body.String(), `"configured":true`) {
				t.Error("unexpected config response")
			}
		})
	}
}

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
	input := adviceInput{Product: "見積支援", Goal: "次回の面談", Target: "設備業", Transcript: "費用と使いやすさを比較したい"}
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
							Data adviceInput
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
				if q.Type != "choice" || q.Name != "action" || q.Instructions != expertInstructions || !reflect.DeepEqual(values, adviceActions) {
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

func TestRejectedRequestsDoNotCreateLiveSessions(t *testing.T) {
	for _, tc := range []struct {
		name, host, origin, key string
		s                       setup
		status                  int
	}{
		{"other-host", "unrelated.test", "http://unrelated.test", mockKey, sample, 403},
		{"other-origin", localHost, "https://unrelated.test", mockKey, sample, 403},
		{"missing-origin", localHost, "", mockKey, sample, 403},
		{"no-key", localHost, localOrigin, "", sample, 503},
		{"invalid-offer", localHost, localOrigin, mockKey, setup{SDP: "invalid", Product: "日報", Goal: "相談"}, 400},
		{"long-target", localHost, localOrigin, mockKey, setup{SDP: sample.SDP, Product: "日報", Goal: "相談", Target: strings.Repeat("あ", 1201)}, 400},
		{"long-goal", localHost, localOrigin, mockKey, setup{SDP: sample.SDP, Product: "日報", Goal: strings.Repeat("あ", 241)}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			handler := testAPI(t, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(500)
			}, tc.key, "")
			rec := requestApp(handler, "POST", tc.host, "/api/session", tc.origin, sessionPayload(t, tc.s))
			if rec.Code != tc.status || calls.Load() != 0 || strings.Contains(rec.Body.String(), mockKey) {
				t.Fatalf("status=%d upstream requests=%d", rec.Code, calls.Load())
			}
		})
	}
}

func TestFailedCreationIsNotAutomaticallyRetried(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"temporary-redirect", 307, ""},
		{"permanent-redirect", 308, ""},
		{"access-denied", 403, "upstream-private"},
		{"rate-limit", 429, "upstream-private"},
		{"overloaded", 503, "upstream-private"},
		{"unexpected-success-code", 200, "{}"},
		{"truncated", 201, "{"},
		{"missing-id", 201, `{"transport":{"sdp":"v=0"}}`},
		{"invalid-answer", 201, `{"session":{"id":"live_test"},"transport":{"sdp":"upstream-private"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			handler := testAPI(t, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				if (tc.status == 307 || tc.status == 308) && calls.Load() == 1 {
					w.Header().Set("Location", "/repeated-session")
				}
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}, mockKey, "")
			rec := requestApp(handler, "POST", localHost, "/api/session", localOrigin, sessionPayload(t, sample))
			if rec.Code != 502 || calls.Load() != 1 || strings.Contains(rec.Body.String(), "upstream-private") || strings.Contains(rec.Body.String(), mockKey) {
				t.Fatalf("status=%d upstream requests=%d", rec.Code, calls.Load())
			}
		})
	}
}

func TestUnsupportedTranscriptTriggerReportsCreationFailure(t *testing.T) {
	handler := testAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":{"param":"session.triggers[0]","message":"upstream-private"}}`)
	}, mockKey, "")
	rec := requestApp(handler, "POST", localHost, "/api/session", localOrigin, sessionPayload(t, sample))
	if rec.Code != 502 || !strings.Contains(rec.Body.String(), "Decisions") || strings.Contains(rec.Body.String(), "upstream-private") {
		t.Fatal("trigger rejection must surface without leaking upstream details")
	}
}

func TestProactiveSessionReceivesBriefAndOpening(t *testing.T) {
	target := "経理担当。月末の集計に手間がかかる可能性。"
	goal := "先方が了承したら来訪を予約し担当者へ送る"
	handler := testAPI(t, func(w http.ResponseWriter, r *http.Request) {
		var got struct {
			Session struct {
				Instructions string
				Input        []liveInputMessage
				Wake         json.RawMessage `json:"wake_policy"`
				Idle         json.RawMessage `json:"idle_timeout_s"`
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
			return
		}
		s := got.Session
		if s.Instructions != salesInstructions || len(s.Input) != 3 || len(s.Input[0].Content) != 1 || len(s.Input[2].Content) != 1 || len(s.Wake) > 0 || len(s.Idle) > 0 {
			t.Fatal("proactive call needs a brief, the application's capabilities and an independent opening instruction")
		}
		checkDeskCapabilities(t, s.Input[1])
		if !strings.Contains(s.Input[0].Content[0].Text, goal) || !strings.Contains(s.Input[0].Content[0].Text, target) || s.Input[0].Role != "developer" || s.Input[2].Role != "developer" || s.Input[2].Content[0].Text != greeting {
			t.Error("the target hypothesis must not be attributed to the caller or used as the opening instruction")
		}
		w.WriteHeader(201)
		io.WriteString(w, `{"session":{"id":"live_proactive"},"transport":{"sdp":"v=0"}}`)
	}, mockKey, "")
	body, err := json.Marshal(map[string]any{"sdp": sample.SDP, "product": sample.Product, "goal": goal, "target": target, "proactive": true})
	if err != nil {
		t.Fatal(err)
	}
	got := requestApp(handler, "POST", localHost, "/api/session", localOrigin, body)
	if got.Code != 201 {
		t.Fatalf("status=%d", got.Code)
	}
}

func checkDeskCapabilities(t *testing.T, message liveInputMessage) {
	t.Helper()
	if message.Role != "developer" || len(message.Content) != 1 || message.Content[0].Type != "input_text" {
		t.Fatal("missing independent application capability record")
	}
	var facts map[string]json.RawMessage
	if err := json.Unmarshal([]byte(message.Content[0].Text), &facts); err != nil {
		t.Fatal(err)
	}
	var result string
	if err := json.Unmarshal(facts["希望を受け取った結果"], &result); err != nil || !strings.Contains(result, "会話ログ") {
		t.Error("need to identify where the preference actually appears")
	}
	for _, key := range []string{"業務用の保存先", "実行できる外部業務", "連絡の送信先", "通話後に自動実行する業務"} {
		var available []string
		if err := json.Unmarshal(facts[key], &available); err != nil || available == nil || len(available) != 0 {
			t.Errorf("unsupported application capability %s: %s", key, facts[key])
		}
	}
}
