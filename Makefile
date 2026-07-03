GO ?= go
UI_DIST := internal/server/ui/dist

# This repo does not vendor; shield builds from a stray -mod=vendor in
# the ambient environment.
export GOFLAGS :=

.PHONY: build web-install web-build ui-dist test web-test clean

build: web-build
	$(GO) build -o bin/revue ./cmd/revue

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

clean:
	rm -rf bin $(UI_DIST)
