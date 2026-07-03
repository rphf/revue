package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rphf/revue/internal/server"
)

// Temporary entry point until the full agent CLI lands (U7): serve
// the given repo in the foreground.
func main() {
	fs := flag.NewFlagSet("revue", flag.ExitOnError)
	repo := fs.String("repo", ".", "repository to serve")
	fs.Parse(os.Args[1:])

	s, err := server.Start(server.Config{RepoRoot: *repo, IdleTimeout: 30 * time.Minute})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("revue serving %s\n", *repo)
	fmt.Printf("open: %s\n", s.URL()+"/auth?token="+s.Token()+"&next=/")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.Shutdown(ctx)
	case <-s.Done():
	}
}
