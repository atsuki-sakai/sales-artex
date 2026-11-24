package desk

import (
	"net/http"
	"strings"

	"sales-artex/internal/openai"
)

func (h handler) createSession(w http.ResponseWriter, r *http.Request) {
	var input openai.SessionInput
	if !decodeRequest(w, r, 96<<10, &input) || !strings.HasPrefix(input.SDP, "v=0") ||
		len(input.SDP) > 65536 || !validBrief(input.Product, input.Goal, input.Target) {
		http.Error(w, "商材・目的・接続情報を確認してください", http.StatusBadRequest)
		return
	}
	cfg, ok := h.loadSettings(w)
	if !ok {
		return
	}
	if cfg.APIKey == "" {
		http.Error(w, ".env に OPENAI_API_KEY を設定してください", http.StatusServiceUnavailable)
		return
	}
	connection, err := h.client.CreateSession(r.Context(), cfg.APIKey, input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusCreated, connection)
}
