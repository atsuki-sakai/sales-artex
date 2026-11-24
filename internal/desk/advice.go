package desk

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"sales-artex/internal/openai"
)

func (h handler) advice(w http.ResponseWriter, r *http.Request) {
	var input openai.AdviceInput
	if !decodeRequest(w, r, 48<<10, &input) || !validBrief(input.Product, input.Goal, input.Target) ||
		strings.TrimSpace(input.Transcript) == "" || utf8.RuneCountInString(input.Transcript) > 3000 {
		http.Error(w, "専門分析の入力を確認してください", http.StatusBadRequest)
		return
	}
	cfg, ok := h.loadSettings(w)
	if !ok {
		return
	}
	if cfg.ExpertModel == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if cfg.APIKey == "" {
		http.Error(w, ".env に OPENAI_API_KEY を設定してください", http.StatusServiceUnavailable)
		return
	}
	action, err := h.client.Advice(r.Context(), cfg.APIKey, cfg.ExpertModel, input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if action == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"action": action})
}
