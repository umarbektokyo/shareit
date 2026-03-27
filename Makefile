.PHONY: dev build start test clean docker

# Development with hot reload
dev:
	npm run dev

# Build for production
build:
	npm run build

# Run production server
start: build
	node server.js

# Run all tests
test:
	npm run test

# Docker
docker:
	docker compose up --build

# Clean build artifacts
clean:
	rm -rf build .svelte-kit node_modules
