package main

import (
	"errors"
	"io/fs"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type settings struct {
	key, expert, port string
}

func readSettings(path string) (settings, error) {
	values, err := godotenv.Read(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		// dotenv の構文エラーには対象行の内容が含まれることがある。
		return settings{}, errors.New(".env を読み込めません。ファイルのアクセス権と KEY=value の書式を確認してください")
	}
	value := func(name string) string {
		if v, ok := os.LookupEnv(name); ok {
			return strings.TrimSpace(v)
		}
		return strings.TrimSpace(values[name])
	}
	return settings{key: value("OPENAI_API_KEY"), expert: value("SALES_EXPERT_MODEL"), port: value("PORT")}, nil
}
