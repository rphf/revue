GO ?= go
UI_DIST := internal/server/ui/dist
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/rphf/revue/internal/cli.Version=$(VERSION)
PLATFORMS := darwin/arm64 darwin/amd64 linux/arm64 linux/amd64

# This repo does not vendor; shield builds from a stray -mod=vendor in
# the ambient environment.
export GOFLAGS :=

.PHONY: build release next-version release-notes web-install web-build ui-dist test web-test lint fmt smoke e2e clean

build: web-build
	$(GO) build -trimpath -ldflags '$(LDFLAGS)' -o bin/revue ./cmd/revue

# One archive per platform. No version in the names, so releases/latest/download/ URLs stay stable.
release: web-build
	rm -rf dist && mkdir -p dist
	for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; dir=dist/revue_$${os}_$${arch}; \
	  mkdir -p $$dir; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $$dir/revue ./cmd/revue || exit 1; \
	  tar -czf $$dir.tar.gz -C $$dir revue; \
	  rm -r $$dir; \
	done
	cd dist && shasum -a 256 *.tar.gz > checksums.txt
	@ls -l dist

# Next release tag from the commit types since the last tag
# (docs/releasing.md); the Release workflow runs the same script.
next-version:
	@bash scripts/next-version.sh

# The release notes that tag would get, grouped by commit type.
release-notes:
	@bash scripts/release-notes.sh

web-install:
	cd web && npm install

web-build:
	cd web && npm run build

# go:embed requires dist to exist even for pure-Go builds and tests.
ui-dist:
	@mkdir -p $(UI_DIST)
	@test -f $(UI_DIST)/index.html || printf '<!doctype html><title>revue</title><p>placeholder build</p>\n' > $(UI_DIST)/index.html

test: ui-dist
	$(GO) vet ./...
	$(GO) test ./...

web-test:
	cd web && npm run test --if-present

# Default rule sets only: golangci-lint (errcheck, govet, ineffassign,
# staticcheck, unused) and gofmt for Go; ESLint recommended configs and
# Prettier for the web. `fmt` rewrites, `lint` only reports.
lint: ui-dist
	golangci-lint run ./...
	golangci-lint fmt --diff ./...
	cd web && npm run check

fmt:
	golangci-lint fmt ./...
	cd web && npm run format

# Scripted end-to-end loop on a fixture repo: open -> draft -> submit
# -> agent reads -> reply -> round 2 -> anchors recomputed.
smoke: build
	bash scripts/smoke.sh

# Browser e2e: the full review loop in chromium against the built
# binary and a seeded fixture repo.
e2e: build
	cd web && npx playwright test

clean:
	rm -rf bin dist $(UI_DIST)
