# ARTEXの構造と音声商談への応用

指定されたBaaRai/ARTEXは、自律型セキュリティ検査基盤の英訳版である。音声営業に応用しやすいのは、**処理中の主会話から確定済みの文脈を取り出し、補助モデルに独立した問いを渡す**仕組みだ。営業では「お客さまへの返答」と「次に確かめるべきこと」を並行して扱える。調査対象は2026年11月24日に取得したコミット `0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9` に固定した。[対象リポジトリ](https://github.com/BaaRai/ARTEX/tree/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9)

## 実装から確認した構成

| ARTEXの構成 | 観察した振る舞い | 営業用に使える判断 |
|---|---|---|
| GoのHTTPサーバー、Next.js／Reactの画面、PostgreSQL | Goが処理の進行とイベント配信を担う。製品ビルドでは画面をGoバイナリに同梱できる。 | 通話を中継するサーバーと、状態の管理だけを担当するサーバーは負荷が大きく異なる。今回のブラウザ版では音声をWebRTCでモデルへ直接送り、アプリには接続設定と商談メモの処理を持たせる。[構成資料](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/docs/ARCHITECTURE.md#L25-L48) |
| 確認できた事実と、試行の経過を別々に管理 | 既知の事実と、「何を試してどうなったか」の記録を参照で結ぶ。役割ごとに判断・処理・結果記録を分担する。 | 「予算は次年度」と明言した発話、担当者が選んだ質問、質問への返事を関連づける。関心についての仮説を書き換えても、元の発話を保持できる。初期版にグラフDBは不要。[状態モデル](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/docs/ARCHITECTURE.md#L8-L22) |
| `sidequestion` のスナップショット | 親の識別子、実行番号、版、取得時刻、モデル、構造化リクエストが一組。ストリーム中断時は直前の有効な境界を保つ。 | 最後に確定した発話を起点に補助分析を開始する。商談ID・発話IDを照合してから次の応答に反映する。[構造体](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/sidequestion/capture.go#L46-L68)・[ストリーム処理](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/sidequestion/capture.go#L150-L184) |
| 補助回答の専用サービス | テキストと使用量を収集し、中断・キャンセル・空回答を区別する。副質問は主会話の履歴とは独立する。 | 営業担当の声は一つに保ち、裏で分析が失敗しても話を続けられる。短い助言だけを音声側に渡す。[Go実装](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/sidequestion/service.go#L11-L69) |
| 補助分析の予算 | 古い文脈と直近の発話群を分け、入力上限に合わせて前者を要約する。同じ要約を再利用できる。 | 軽い分析には直近の発話と確認済みの条件だけを送り、商談が長くても毎回全履歴を読み直す費用を抑える。[文脈圧縮](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/sidequestion/context.go#L213-L252) |
| 画面での順序制御 | リクエストIDと連番で新しいイベントを採用し、親会話が切り替わった後のイベントを世代番号で除外する。 | 通話終了後のメモ、割り込み前の古い助言、再接続時の重複表示を区別する。[マージ](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/web/src/hooks/use-side-questions.ts#L19-L25)・[世代の照合](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/web/src/hooks/use-side-questions.ts#L129-L151) |

上流の全体設計資料には副質問を「人に質問して処理を一時停止する」と説明する箇所がある。今回確認した専用サービスと画面では、操作者が質問し、モデルがスナップショットを読んで回答する。営業用の自動分析は、そこに「顧客の発話確定を契機に呼び出す」「有効な助言を音声モデルに返す」という二つの処理を加える設計になる。[専用機能の仕様](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/sidequestion/README.md#L1-L28)

## 商談での「内なる独白」の設計

ここでいう独白は、発話前後に更新する**短い商談メモ**である。「知りたいこと」「根拠となる発言」「次の質問」を持ち、音声の読み上げ対象から外す。顧客の内面を当てようとするより、問いを一つ選んで実際の返答で仮説を更新するほうが、営業担当者も判断を検証しやすい。

例えば顧客が「料金より、月末の作業が止まるのが心配です」と言った場面なら、次のように扱える。

| 担当する観点 | メモに残す内容の例 | 次の応答への影響 |
|---|---|---|
| 課題の聞き取り | 関心の候補は移行中の業務継続。根拠は「月末の作業が止まる」。 | 価格説明を繰り返す優先度を下げる。 |
| 提案の妥当性 | 月末の対象業務、許容できる停止時間、商品の保証範囲が未確認。 | 無停止で移行できるという約束を避ける。 |
| 商談進行 | 次は要件の確認。 | 「月末に一番止めたくない作業は何ですか」と一つだけ聞く。 |

応答待ちを減らすには、音声モデルに最初から商品情報と会話方針を与え、分析結果が間に合った場合に次の発話へ反映する。モデルを観点の数だけ直列に呼ぶと、最も遅い分析が会話の間を決めてしまう。初期版では一度の判定で複数の観点を出せる。後に専門家を独立させる判断材料は、実際の録音での見落とし率、応答遅延、追加費用である。

音高やテンポは、質問の速度や間の取り方を調整する手掛かりになる。購買意向は発話中の質問や明示された条件に根拠を持たせる。「音高が上がったから導入に関心がある」という判定は、同じ言葉でも話者の声域、マイク距離、周囲の音によって変わる。商談の到達点も「資料を見たい」「次回の日程に合意」「契約締結」のように個別に記録する。「資料を送ってください」から契約締結を推定すると、成約率の集計まで狂う。

## REAの調査記録と適用範囲

公開ツリーの `web` を対象に、REAの `analyze_javascript_application` で `src/hooks/use-side-questions.ts` と `src/lib/side-questions.ts` を指定して静的解析した。選定した2ファイルは構文解析に成功し、1,753のASTノードを走査した。解析結果の親Evidence IDは `ev_b8ef7cf2e5a56fb8cc2b22e13770594aee3777d39b0f2e4d78dce25525d187af`。対象ディレクトリのSHA-256は `1b42ad042b7f4aa178dd5f31aea1ad827edc4a08b37a51ab1fe97518eb3e7c25`。残る206ファイルはこのREA解析の対象外。Go側の記述は同一コミットの構造体・関数および専用機能の文書と照合した。ARTEX本体の実行、処理速度の測定、音声営業への有効性の検証はこの静的調査の範囲外である。[対象フック](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/web/src/hooks/use-side-questions.ts)・[データ型とAPI境界](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/web/src/lib/side-questions.ts)

リポジトリのルートはGNU AGPL v3で、13条は改変版をネットワーク越しに利用する人への対応ソースの提供を扱う。`web/LICENSE` には別途MIT表記もある。営業版は設計上の考え方を参照して個別に実装する方針とした。[ルートのライセンス](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/LICENSE#L540-L551)・[web配下の表記](https://github.com/BaaRai/ARTEX/blob/0c64c3958ca8fb815aed6f1c1dc8cd499cd7dcf9/web/LICENSE)
