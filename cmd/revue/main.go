package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/rphf/revue/internal/server/ui"
)

func main() {
	fs := flag.NewFlagSet("revue", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:7369", "listen address")
	fs.Parse(os.Args[1:])

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	log.Printf("revue serving on http://%s", ln.Addr())
	if err := http.Serve(ln, ui.Handler()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
