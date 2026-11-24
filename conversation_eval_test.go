package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"testing"
	"time"
)

// Opt-in evaluation of the production choice question on complete Japanese
// utterances. Streaming decisions and their ordering are tested separately.
func TestLiveConversationMeanings(t *testing.T) {
	if os.Getenv("SALES_RUN_SEMANTIC_EVAL") != "1" {
		t.Skip("実モデル評価は SALES_RUN_SEMANTIC_EVAL=1 で実行")
	}
	cfg, err := readSettings(".env")
	if err != nil || cfg.key == "" {
		t.Fatal("実モデル評価に使うAPIキーを読み込めません")
	}
	var session struct {
		Triggers []struct {
			Decisions struct{ Questions json.RawMessage }
		}
	}
	payload, err := json.Marshal(sample.sessionConfig())
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &session); err != nil {
		t.Fatal(err)
	}
	if len(session.Triggers) != 1 || len(session.Triggers[0].Decisions.Questions) == 0 {
		t.Fatal("音声セッションの会話制御用質問を取得できません")
	}
	keepOpen := []string{"respond", "none"}
	cases := []struct {
		name, history, customer string
		allowed                 []string
	}{
		{"発言権を譲る", "AIが機能を紹介している。", "私の説明がまだ途中です。まず最後まで聞いてもらえますか。", []string{"listen"}},
		{"誰が待つのか", "AIが料金について答えず、顧客が返事を待っている。", "こちらは何か待つ必要がありますか？", []string{"respond"}},
		{"新しい質問で再開", "顧客から少し考えたいと言われ、AIは黙っている。", "では質問です。商品一覧から何が作れますか？", []string{"respond"}},
		{"考えた後の回答で再開", "AIが必要な部数を尋ねたところ、相手は手帳で数える間だけ待ってほしいと言った。", "全部で四部です。", []string{"respond"}},
		{"発言を制してから質問", "AIがプランについて説明し始めた。", "ちょっとストップ、それって一人でも使えますか。", []string{"respond"}},
		{"候補の訂正に応じる", "AIが金曜の午後でよいか聞き、相手は予定を見ている。", "あ、違いました。木曜の午前を希望します。", []string{"respond"}},
		{"短い返事でも了承", "AIがプランの違いを説明してよいか尋ねている。", "ええ、どうぞ。", []string{"respond"}},
		{"先が続くときは遮らない", "顧客が作業手順を順に説明中。AIは最後まで聞くよう頼まれている。", "その次の工程なんだけど、ええと、", []string{"none", "listen"}},
		{"業務終了と終話の区別", "見積作成で困る点について話している。", "夕方までに入力を終わらせたいんです。", keepOpen},
		{"提案だけ辞退", "AIが面談を提案した。", "面談は結構です。製品についてはもう少し聞かせてください。", keepOpen},
		{"見積中の引用", "顧客が取引先から受けた依頼を説明している。", "先方から『ここで終わりにしてください』と言われた時は、見積をどう直せますか。", keepOpen},
		{"通話終了を依頼", "営業担当が説明している。", "もうお電話はここまでにしてください。失礼します。", []string{"end_call"}},
	}
	a := app{client: liveHTTPClient()}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			input := "会話の状況：" + tc.history + "\n今回の顧客の発言：" + tc.customer
			resp, err := a.post(ctx, "https://api.openai.com/v1/decisions", cfg.key, map[string]any{
				"model": "gpt-6-luna", "input": input, "questions": session.Triggers[0].Decisions.Questions,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("Decisions API HTTP %d", resp.StatusCode)
			}
			var result struct {
				Answers []struct{ Type, Name, Choice string }
			}
			if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if len(result.Answers) != 1 {
				t.Fatalf("回答数 %d", len(result.Answers))
			}
			answer := result.Answers[0]
			if answer.Type != "choice" || answer.Name != "conversation_control" || !slices.Contains(tc.allowed, answer.Choice) {
				t.Errorf("「%s」の判定 %q、期待 %v", tc.customer, answer.Choice, tc.allowed)
			}
		})
	}
}
