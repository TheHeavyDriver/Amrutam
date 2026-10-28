SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install up down reset logs dev app build start test test-unit test-e2e test-cov lint typecheck format check db-migrate db-rollback db-status db-seed worker jobs-status jobs-replay load-test

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

up: ## Start local infrastructure (Postgres, Redis, observability)
	docker compose up -d db redis otel-collector tempo prometheus loki grafana

down: ## Stop local infrastructure
	docker compose down

reset: ## Stop infrastructure and delete all local data
	docker compose down -v

logs: ## Tail infrastructure logs
	docker compose logs -f --tail=100

dev: up ## Start infrastructure and the API in watch mode
	npm run start:dev

app: ## Build, migrate, seed, and run the API and worker containers
	docker compose --profile app build api worker
	docker compose --profile app up -d db redis otel-collector tempo prometheus loki grafana
	docker compose --profile app run --rm -e SEED_ALLOW=true api node dist/database/cli.js up
	docker compose --profile app run --rm -e SEED_ALLOW=true api node dist/database/seed.js
	docker compose --profile app up -d api worker

worker: ## Run the outbox/scheduler worker locally
	npm run jobs:run

jobs-status: ## Show outbox backlog and dead-letter events
	npm run jobs:status

jobs-replay: ## Replay dead-letter events (pass ARGS="--all")
	npm run jobs:replay -- $(ARGS)

build: ## Compile the application
	npm run build

start: ## Run the compiled application
	npm run start

test: ## Run all tests
	npm test

test-unit: ## Run unit tests only
	npm run test:unit

test-e2e: ## Run end-to-end tests only
	npm run test:e2e

test-cov: ## Run tests with coverage
	npm run test:cov

lint: ## Lint the codebase
	npm run lint

typecheck: ## Type-check without emitting
	npm run typecheck

format: ## Format the codebase
	npm run format

check: lint typecheck test ## Run the full local quality gate

db-migrate: ## Apply pending database migrations
	npm run db:migrate

db-rollback: ## Roll back the latest database migration
	npm run db:rollback

db-status: ## Show applied and pending database migrations
	npm run db:status

db-seed: ## Load deterministic demo data (development only)
	npm run db:seed

load-test: ## Run k6 booking flow against API_BASE_URL
	k6 run load/k6/booking-flow.js
