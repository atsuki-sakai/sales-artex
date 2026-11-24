package openai

import "encoding/json"

func choiceQuestion(name, instructions string, values ...string) map[string]any {
	choices := make([]map[string]string, 0, len(values))
	for _, value := range values {
		choices = append(choices, map[string]string{"value": value})
	}
	return map[string]any{"type": "choice", "name": name, "instructions": instructions, "choices": choices}
}

func decisionRequest(input AdviceInput) map[string]any {
	return map[string]any{
		"model": decisionsModel,
		"input": []any{map[string]any{
			"role":    "user",
			"content": []any{map[string]any{"type": "input_json", "data": input}},
		}},
		"questions": []any{choiceQuestion("action", expertInstructions, adviceActions...)},
	}
}

func decisionAction(d *json.Decoder) (string, error) {
	var result struct {
		Answers []struct{ Type, Name, Choice string }
	}
	if err := d.Decode(&result); err != nil {
		return "", err
	}
	for _, answer := range result.Answers {
		if answer.Type == "choice" && answer.Name == "action" {
			return answer.Choice, nil
		}
	}
	return "", nil
}
