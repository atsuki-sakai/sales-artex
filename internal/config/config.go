package config

import (
	"errors"
	"io/fs"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Settings struct {
	APIKey      string
	ExpertModel string
	Port        string
}

func Load(path string) (Settings, error) {
	values, err := godotenv.Read(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		// dotenv の構文エラーには対象行の内容が含まれることがある。
		return Settings{}, errors.New(".env を読み込めません。ファイルのアクセス権と KEY=value の書式を確認してください")
	}
	value := func(name string) string {
		if v, ok := os.LookupEnv(name); ok {
			return strings.TrimSpace(v)
		}
		return strings.TrimSpace(values[name])
	}
	return Settings{
		APIKey:      value("OPENAI_API_KEY"),
		ExpertModel: value("SALES_EXPERT_MODEL"),
		Port:        value("PORT"),
	}, nil
}
