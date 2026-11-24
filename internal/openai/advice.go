package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"
)

const decisionsModel = "gpt-6-luna"

var adviceActions = []string{"no_action", "clarify_need", "compare_options", "confirm_constraints", "confirm_next_step", "respect_decline"}

type AdviceInput struct {
	Product    string `json:"product"`
	Goal       string `json:"goal"`
	Target     string `json:"target"`
	Transcript string `json:"transcript"`
}

func (c *Client) Advice(ctx context.Context, key, model string, input AdviceInput) (string, error) {
	var body map[string]any
	path := "/responses"
	decodeAction := responseAction
	if model == decisionsModel {
		path = "/decisions"
		body = decisionRequest(input)
		decodeAction = decisionAction
	} else {
		body = responseRequest(model, input)
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	resp, err := c.post(ctx, path, key, body)
	if err != nil {
		return "", errors.New("専門分析を取得できませんでした")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("専門分析を取得できませんでした（OpenAI HTTP %d）", resp.StatusCode)
	}
	action, err := decodeAction(json.NewDecoder(io.LimitReader(resp.Body, 128<<10)))
	if err != nil {
		return "", errors.New("専門分析の応答を読み取れませんでした")
	}
	if action == "no_action" || !slices.Contains(adviceActions, action) {
		return "", nil
	}
	return action, nil
}
