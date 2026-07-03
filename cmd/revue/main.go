package main

import (
	"os"

	"github.com/rphf/revue/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:]))
}
