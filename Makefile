# AWSops v2 — deployment entrypoints (OSS-portable, consumer-facing).
#
# Prerequisites (must be on PATH):
#   - terraform >= 1.15   (S3 native state locking via use_lockfile)
#   - node >= 18          (configurator TUI)
#   - aws CLI (configured credentials for the target account)
#   - docker w/ buildx    (image build, later phases)
#
# Usage:
#   make configure   # interactive: pick VPC/domain → terraform.tfvars + backend.hcl
#   make help        # list targets

.DEFAULT_GOAL := help
.PHONY: help configure deps

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

deps: ## Install node deps required by the configurator (idempotent; first run only)
	@[ -d node_modules/@inquirer/prompts ] || npm install

configure: deps ## Interactive TUI: choose new/existing VPC, domain, bucket → terraform.tfvars + backend.hcl
	@node scripts/v2/configure.mjs
