package desk

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"sales-artex/internal/openai"
)

type liveInputMessage struct {
	Role    string
	Content []struct{ Type, Text string }
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
				if got.Transport.Type != "webrtc" || got.Transport.SDP != sample.SDP || s.Model != openai.LiveModel || s.Audio.Output.Voice != "harema" || s.Wake.Type != "speech" || s.Idle <= 0 || s.Store == nil || *s.Store {
					t.Error("invalid Live transport or session configuration")
				}
				if !strings.Contains(s.Instructions, "日本語のAI営業担当") || strings.Contains(s.Instructions, sample.Product) || len(s.Input) != 2 || s.Input[0].Role != "developer" || len(s.Input[0].Content) != 1 {
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
				if q.Type != "choice" || q.Name != "conversation_control" || !strings.Contains(q.Instructions, "次に誰が話す番か") || !reflect.DeepEqual(choices, []string{"none", "listen", "respond", "end_call"}) {
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

func TestRejectedRequestsDoNotCreateLiveSessions(t *testing.T) {
	for _, tc := range []struct {
		name, host, origin, key string
		s                       openai.SessionInput
		status                  int
	}{
		{"other-host", "unrelated.test", "http://unrelated.test", mockKey, sample, 403},
		{"other-origin", localHost, "https://unrelated.test", mockKey, sample, 403},
		{"missing-origin", localHost, "", mockKey, sample, 403},
		{"no-key", localHost, localOrigin, "", sample, 503},
		{"invalid-offer", localHost, localOrigin, mockKey, openai.SessionInput{SDP: "invalid", Product: "日報", Goal: "相談"}, 400},
		{"long-target", localHost, localOrigin, mockKey, openai.SessionInput{SDP: sample.SDP, Product: "日報", Goal: "相談", Target: strings.Repeat("あ", 1201)}, 400},
		{"long-goal", localHost, localOrigin, mockKey, openai.SessionInput{SDP: sample.SDP, Product: "日報", Goal: strings.Repeat("あ", 241)}, 400},
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
		if !strings.Contains(s.Instructions, "日本語のAI営業担当") || strings.Contains(s.Instructions, sample.Product) || len(s.Input) != 3 || len(s.Input[0].Content) != 1 || len(s.Input[2].Content) != 1 || len(s.Wake) > 0 || len(s.Idle) > 0 {
			t.Fatal("proactive call needs a brief, the application's capabilities and an independent opening instruction")
		}
		checkDeskCapabilities(t, s.Input[1])
		if !strings.Contains(s.Input[0].Content[0].Text, goal) || !strings.Contains(s.Input[0].Content[0].Text, target) || s.Input[0].Role != "developer" || s.Input[2].Role != "developer" || !strings.Contains(s.Input[2].Content[0].Text, "話してよいか") || strings.Contains(s.Input[2].Content[0].Text, target) {
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
