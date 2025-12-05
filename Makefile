APP_NAME ?= gorocky
DB_URL ?= $(DATABASE_URL)
MIGRATIONS_DIR ?= ./migrations

.PHONY: run fmt test docker-build docker-up docker-down db-migrate-up db-migrate-down

run:
	@PORT=$(PORT) DATABASE_URL=$(DATABASE_URL) GIN_MODE=$(GIN_MODE) go run ./cmd/server

fmt:
	@gofmt -w ./cmd

test:
	@go test ./...

docker-build:
	@docker build -t $(APP_NAME):local .

docker-up:
	@docker-compose up --build

docker-down:
	@docker-compose down

db-migrate-up:
	@test -n "$(DB_URL)" || (echo "DATABASE_URL/DB_URL is required"; exit 1)
	@docker run --rm -v $(PWD)/migrations:/migrations --network=host migrate/migrate -path=/migrations -database "$(DB_URL)" up

db-migrate-down:
	@test -n "$(DB_URL)" || (echo "DATABASE_URL/DB_URL is required"; exit 1)
	@docker run --rm -v $(PWD)/migrations:/migrations --network=host migrate/migrate -path=/migrations -database "$(DB_URL)" down

