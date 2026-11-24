package openai

import "encoding/json"

func responseRequest(model string, input AdviceInput) map[string]any {
	facts, _ := json.Marshal(input)
	format := map[string]any{
		"type": "json_schema", "name": "sales_advice", "strict": true,
		"schema": map[string]any{
			"type": "object", "required": []string{"action"}, "additionalProperties": false,
			"properties": map[string]any{"action": map[string]any{"type": "string", "enum": adviceActions}},
		},
	}
	return map[string]any{
		"model": model, "store": false, "instructions": expertInstructions, "input": string(facts),
		"text": map[string]any{"format": format}, "max_output_tokens": 192,
	}
}

func responseAction(d *json.Decoder) (string, error) {
	var result struct {
		Status string
		Output []struct {
			Type    string
			Content []struct{ Type, Text string }
		}
	}
	if err := d.Decode(&result); err != nil {
		return "", err
	}
	if result.Status != "completed" {
		return "", nil
	}
	for _, item := range result.Output {
		if item.Type != "message" {
			continue
		}
		for _, part := range item.Content {
			var advice struct{ Action string }
			if part.Type == "output_text" && json.Unmarshal([]byte(part.Text), &advice) == nil {
				return advice.Action, nil
			}
		}
	}
	return "", nil
}
