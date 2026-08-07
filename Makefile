.PHONY: generate-local-jwt-key validate

LOCAL_SECRET_DIR := .secrets
LOCAL_JWT_KEY_FILE := $(LOCAL_SECRET_DIR)/jwt-signing-key.json

generate-local-jwt-key:
	@mkdir -p "$(LOCAL_SECRET_DIR)"
	@node --import tsx scripts/generate-keypair.ts --out "$(LOCAL_JWT_KEY_FILE)"
	@chmod 600 "$(LOCAL_JWT_KEY_FILE)"
	@printf 'Generated local JWT signing key at %s\n' "$(LOCAL_JWT_KEY_FILE)"

validate:
	npm run validate
