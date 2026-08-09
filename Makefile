.PHONY: generate-local-jwt-key validate

generate-local-jwt-key:
	@npm run --silent keys:generate

validate:
	npm run validate
