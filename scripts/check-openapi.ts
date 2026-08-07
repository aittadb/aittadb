import { openApiSpec } from "../src/openapi";

const requiredPaths = [
  "/",
  "/health",
  "/session",
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

const requiredMethods: Record<string, readonly string[]> = {
  "/": ["get"],
  "/session": ["get"],
  "/authorize": ["get"],
  "/oauth/device_authorization": ["get", "post"],
  "/oauth/token": ["get", "post"],
  "/oauth/revoke": ["get", "post"],
  "/oauth/introspect": ["get", "post"],
  "/userinfo": ["get", "post"],
  "/storage/records": ["get", "post"],
  "/storage/records/{key}": ["get", "post", "put", "delete"],
  "/storage/files": ["get", "post"],
  "/storage/files/{key}": ["get", "post", "put", "delete"],
  "/openapi.json": ["get"],
  "/docs": ["get"],
};

if (openApiSpec.openapi !== "3.1.0") {
  throw new Error("OpenAPI spec must be 3.1.0");
}

if (openApiSpec.info.title !== "AittaDB") {
  throw new Error("OpenAPI title must match the AittaDB product contract");
}

for (const path of requiredPaths) {
  if (!(path in openApiSpec.paths)) {
    throw new Error(`Missing OpenAPI path: ${path}`);
  }
}

const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
for (const [path, methods] of Object.entries(requiredMethods)) {
  for (const method of methods) {
    if (!(method in paths[path])) {
      throw new Error(
        `Missing OpenAPI operation: ${method.toUpperCase()} ${path}`,
      );
    }
  }
}

console.log(
  `OpenAPI ${openApiSpec.openapi} contains ${requiredPaths.length} required paths.`,
);
