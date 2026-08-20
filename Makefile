# Development Makefile for Seros

.PHONY: dev worker test typecheck lint fmt verify

dev:
	npm run dev

worker:
	npm run worker

test:
	npm test

typecheck:
	npm run typecheck

lint:
	npx eslint .

fmt:
	npx prettier --write .

verify:
	npm run verify

all: typecheck test lint fmt

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
	@echo "  lint   - Run ESLint linter"
	@echo "  fmt    - Format code with Prettier"
	@echo "  verify - Full verification (typecheck + tests + lint)"
	@echo "  migrate - Apply database migrations"
	@echo "  seed   - Seed initial data"
	@echo ""
	@echo "Dependencies (if not installed): npm install"
