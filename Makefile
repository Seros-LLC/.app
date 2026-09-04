# Development Makefile for Seros

.PHONY: dev worker test typecheck verify

dev:
	npm run dev

worker:
	npm run worker

test:
	npm test

typecheck:
	npm run typecheck

verify:
	npm run verify

all: verify

# Migration and setup targets

migrate:
	npm run migrate

seed: migrate
	npm run seed

# Help target

help:
	@echo "Available targets:"
	@echo "  dev    - Start the web app in development mode"
	@echo "  worker - Start the background worker"
	@echo "  test   - Run the test suite"
	@echo "  typecheck - TypeScript type checking"
	@echo "  verify - Full verification (typecheck + tenancy check + tests)"
	@echo "  migrate - Apply database migrations"
	@echo "  seed   - Seed initial data"
	@echo ""
	@echo "Dependencies (if not installed): npm install"
