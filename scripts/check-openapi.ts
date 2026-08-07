import { openApiSpec } from "../src/openapi";

const requiredPaths = [
  "/",
  "/health",
  "/.well-known/openid-configuration",
  "/.well-known/jwks.json",
  "/authorize",
  "/oauth/device_authorization",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/introspect",
  "/userinfo",
  "/storage/records",
  "/storage/records/{key}",
  "/storage/files",
  "/storage/files/{key}",
  "/openapi.json",
  "/docs",
];

if (openApiSpec.openapi !== "3.1.0") {
  throw new Error("OpenAPI spec must be 3.1.0");
}

for (const path of requiredPaths) {
  if (!(path in openApiSpec.paths)) {
    throw new Error(`Missing OpenAPI path: ${path}`);
  }
}

console.log(
  `OpenAPI ${openApiSpec.openapi} contains ${requiredPaths.length} required paths.`,
);
