SHELL := /bin/bash

HOST ?= 127.0.0.1
PORT ?= 5555
WEB_DIR := apps/web
DIST_DIR := dist
BIN_NAME := documind
RELEASE_BIN := target/release/$(BIN_NAME)
DIST_BIN := $(DIST_DIR)/$(BIN_NAME)

.PHONY: install web-build dev dev-web build start clean

install:
	cd $(WEB_DIR) && npm install

web-build: install
	cd $(WEB_DIR) && DOCUMIND_STATIC_EXPORT=1 npm run build

dev: web-build
	SERVER_HOST=$(HOST) SERVER_PORT=$(PORT) cargo run -p $(BIN_NAME)

dev-web: install
	cd $(WEB_DIR) && npm run dev -- -H $(HOST)

$(DIST_BIN): web-build
	cargo build --release -p $(BIN_NAME)
	mkdir -p $(DIST_DIR)
	cp $(RELEASE_BIN) $(DIST_BIN)
	chmod +x $(DIST_BIN)

build: $(DIST_BIN)

start:
	@test -x $(DIST_BIN) || (echo "dist binary missing. Run 'make build' first." && exit 1)
	SERVER_HOST=$(HOST) SERVER_PORT=$(PORT) ./$(DIST_BIN)

clean:
	cargo clean
	rm -rf $(DIST_DIR) $(WEB_DIR)/out $(WEB_DIR)/.next
