package main

import (
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"sales-artex/internal/config"
	"sales-artex/internal/desk"
	"sales-artex/internal/openai"
)

func main() {
	const envFile = ".env"
	cfg, err := config.Load(envFile)
	if err != nil {
		log.Fatal(err)
	}
	port := cfg.Port
	if port == "" {
		port = "8787"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
		log.Fatal("PORT は 1〜65535 の整数で指定してください")
	}
	if _, err := os.Stat("frontend/out/index.html"); err != nil {
		log.Fatal("先に npm --prefix frontend ci と npm --prefix frontend run build を実行してください")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:"+port)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("営業デスク http://127.0.0.1:%s", port)
	server := http.Server{
		Handler:           desk.NewHandler(port, envFile, openai.NewClient(openai.DefaultBaseURL)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
