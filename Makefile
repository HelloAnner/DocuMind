SHELL := /bin/bash

WEB_DIR := apps/web
DIST_DIR := dist
BIN_NAME := documind
DEPLOY_HOST ?= documind
DEPLOY_PORT ?= 8089
DEPLOY_BASE_PATH ?= /documind
DEPLOY_TARGET ?= x86_64-unknown-linux-musl
DEPLOY_TARGET_DIR ?= target/deploy-linux-x86_64-musl
DEPLOY_BINARY ?= $(DEPLOY_TARGET_DIR)/$(DEPLOY_TARGET)/release/$(BIN_NAME)

.PHONY: install deploy-web-build deploy-build deploy status health logs clean

install:
	cd $(WEB_DIR) && npm install

deploy-web-build: install
	cd $(WEB_DIR) && DOCUMIND_STATIC_EXPORT=1 DOCUMIND_BASE_PATH=$(DEPLOY_BASE_PATH) NEXT_PUBLIC_API_BASE=$(DEPLOY_BASE_PATH) npm run build

deploy-build: deploy-web-build
	DEPLOY_TARGET=$(DEPLOY_TARGET) DEPLOY_TARGET_DIR=$(DEPLOY_TARGET_DIR) scripts/build-linux.sh

deploy: deploy-build
	DEPLOY_HOST=$(DEPLOY_HOST) DEPLOY_PORT=$(DEPLOY_PORT) LOCAL_BINARY=$(DEPLOY_BINARY) scripts/deploy.sh

status:
	ssh $(DEPLOY_HOST) 'bash -lc '"'"'set -euo pipefail; \
		echo "== documind process =="; pgrep -af "/opt/documind/.*/documind|documind" || true; \
		echo; echo "== documind port =="; (command -v ss >/dev/null && ss -ltnp | grep ":$(DEPLOY_PORT) " || true); \
		echo; echo "== logs =="; ls -lh /opt/documind/shared/logs 2>/dev/null || true'"'"''

health:
	ssh $(DEPLOY_HOST) 'bash -lc '"'"'set -euo pipefail; \
		curl -fsS http://127.0.0.1:$(DEPLOY_PORT)/api/health; echo; \
		curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$(DEPLOY_PORT)/documind/'"'"''

logs:
	ssh $(DEPLOY_HOST) 'bash -lc '"'"'tail -n $${LINES:-300} -f /opt/documind/shared/logs/documind-$(DEPLOY_PORT).log'"'"''

clean:
	cargo clean
	rm -rf $(DIST_DIR) $(WEB_DIR)/out $(WEB_DIR)/.next
