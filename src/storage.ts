import { nowSeconds, sha256, uuid } from "./crypto";
import { bearerToken, json, oauthError } from "./http";
import { parseScopes, verifyAccessToken } from "./oauth";
import type {
  AppConfig,
  AuthStore,
  ClientView,
  RuntimeEnv,
  StorageFileMetadata,
  StorageRecord,
} from "./types";

export const MAX_RECORD_BYTES = 65_536;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

type StorageScope = "storage.read" | "storage.write" | "storage.delete";

interface StoragePrincipal {
  userId: string;
  client: ClientView;
}

export async function storageEndpoint(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response> {
  if (url.pathname === "/storage/records" && request.method === "GET") {
    const principal = await requireStorageScope(
      request,
      config,
      store,
      "storage.read",
    );
    if (principal instanceof Response) return principal;
    const records = await store.listStorageRecords(
      principal.userId,
      principal.client.id,
    );
    return json({
      records: records.map(recordView),
      _links: storageLinks(config),
      actions: storageActions(config, "records"),
    });
  }

  const recordKey = decodeStorageKey(url.pathname, "/storage/records/");
  if (recordKey) {
    if (request.method === "GET") {
      const principal = await requireStorageScope(
        request,
        config,
        store,
        "storage.read",
      );
      if (principal instanceof Response) return principal;
      const record = await store.getStorageRecord(
        principal.userId,
        principal.client.id,
        recordKey,
      );
      if (!record)
        return oauthError("not_found", "Storage record not found", 404);
      return json(recordView(record));
    }

    if (request.method === "PUT") {
      const principal = await requireStorageScope(
        request,
        config,
        store,
        "storage.write",
      );
      if (principal instanceof Response) return principal;
      const parsed = await readJsonBody(request, MAX_RECORD_BYTES);
      if (parsed instanceof Response) return parsed;
      const existing = await store.getStorageRecord(
        principal.userId,
        principal.client.id,
        recordKey,
      );
      const now = nowSeconds();
      const record: StorageRecord = {
        userId: principal.userId,
        clientId: principal.client.id,
        key: recordKey,
        valueJson: JSON.stringify(parsed),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await store.upsertStorageRecord(record);
      return json(recordView(record));
    }

    if (request.method === "DELETE") {
      const principal = await requireStorageScope(
        request,
        config,
        store,
        "storage.delete",
      );
      if (principal instanceof Response) return principal;
      await store.deleteStorageRecord(
        principal.userId,
        principal.client.id,
        recordKey,
      );
      return json({
        deleted: true,
        key: recordKey,
        _links: storageLinks(config),
        actions: storageActions(config, "records"),
      });
    }
  }

  if (url.pathname === "/storage/files" && request.method === "GET") {
    const principal = await requireStorageScope(
      request,
      config,
      store,
      "storage.read",
    );
    if (principal instanceof Response) return principal;
    const files = await store.listStorageFiles(
      principal.userId,
      principal.client.id,
    );
    return json({
      files: files.map(fileView),
      _links: storageLinks(config),
      actions: storageActions(config, "files"),
    });
  }

  const fileKey = decodeStorageKey(url.pathname, "/storage/files/");
  if (fileKey) {
    if (request.method === "GET") {
      const principal = await requireStorageScope(
        request,
        config,
        store,
        "storage.read",
      );
      if (principal instanceof Response) return principal;
      const file = await store.getStorageFileMetadata(
        principal.userId,
        principal.client.id,
        fileKey,
      );
      if (!file) return oauthError("not_found", "Storage file not found", 404);
      if (!env.BUCKET)
        return oauthError(
          "storage_unavailable",
          "R2 bucket is unavailable",
          503,
        );
      const object = await env.BUCKET.get(file.r2Key);
      if (!object)
        return oauthError("not_found", "Storage file not found", 404);
      return new Response(await object.arrayBuffer(), {
        headers: {
          "content-type": file.contentType,
          "content-disposition": storageAttachmentDisposition(file.key),
          "cache-control": "no-store",
          "x-aittadb-storage-key": encodeURIComponent(file.key),
        },
      });
    }

    if (request.method === "PUT") {
      const principal = await requireStorageScope(
        request,
        config,
        store,
        "storage.write",
      );
      if (principal instanceof Response) return principal;
      if (!env.BUCKET)
        return oauthError(
          "storage_unavailable",
          "R2 bucket is unavailable",
          503,
        );
      const body = await readBytes(request, MAX_FILE_BYTES);
      if (body instanceof Response) return body;
      const existing = await store.getStorageFileMetadata(
        principal.userId,
        principal.client.id,
        fileKey,
      );
      const now = nowSeconds();
      const r2Key =
        existing?.r2Key ??
        `users/${principal.userId}/clients/${principal.client.id}/files/${uuid()}`;
      const contentType =
        request.headers.get("content-type") || "application/octet-stream";
      const digest = await sha256(new Uint8Array(body));
      await env.BUCKET.put(r2Key, body, {
        httpMetadata: { contentType },
        customMetadata: {
          userId: principal.userId,
          clientId: principal.client.id,
          keySha256: await sha256(fileKey),
        },
      });
      const file: StorageFileMetadata = {
        userId: principal.userId,
        clientId: principal.client.id,
        key: fileKey,
        r2Key,
        contentType,
        size: body.byteLength,
        sha256: digest,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await store.upsertStorageFileMetadata(file);
      return json(fileView(file));
    }

    if (request.method === "DELETE") {
      const principal = await requireStorageScope(
        request,
        config,
        store,
        "storage.delete",
      );
      if (principal instanceof Response) return principal;
      const file = await store.getStorageFileMetadata(
        principal.userId,
        principal.client.id,
        fileKey,
      );
      if (file && env.BUCKET) await env.BUCKET.delete(file.r2Key);
      await store.deleteStorageFileMetadata(
        principal.userId,
        principal.client.id,
        fileKey,
      );
      return json({
        deleted: true,
        key: fileKey,
        _links: storageLinks(config),
        actions: storageActions(config, "files"),
      });
    }
  }

  return oauthError("not_found", "No storage route matches this request", 404);
}

async function requireStorageScope(
  request: Request,
  config: AppConfig,
  store: AuthStore,
  requiredScope: StorageScope,
): Promise<StoragePrincipal | Response> {
  const token = bearerToken(request);
  if (!token) return oauthError("invalid_token", "Bearer token required", 401);
  const audience = parseJwtAudience(token);
  if (!audience) return oauthError("invalid_token", "Invalid token", 401);
  try {
    const verified = await verifyAccessToken(token, config, store, audience);
    if (verified.claims.token_use !== "access")
      return oauthError("invalid_token", "Access token required", 401);
    const scopes = parseScopes(String(verified.claims.scope || ""));
    if (!scopes.includes(requiredScope)) {
      return oauthError(
        "insufficient_scope",
        `Required scope: ${requiredScope}`,
        403,
      );
    }
    const user = await store.getUser(verified.claims.sub);
    const client = await store.getClient(audience);
    if (!user || !client || client.disabledAt)
      return oauthError("invalid_token", "Invalid token", 401);
    return { userId: user.id, client };
  } catch {
    return oauthError("invalid_token", "Invalid token", 401);
  }
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json"))
    return oauthError("invalid_request", "JSON content type required", 415);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    return oauthError("invalid_request", "Storage record is too large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return oauthError("invalid_request", "Malformed JSON body");
  }
}

async function readBytes(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | Response> {
  const length = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > maxBytes)
    return oauthError("invalid_request", "Storage file is too large", 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes)
    return oauthError("invalid_request", "Storage file is too large", 413);
  return body;
}

function decodeStorageKey(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  try {
    const key = decodeURIComponent(pathname.slice(prefix.length));
    return isValidStorageKey(key) ? key : null;
  } catch {
    return null;
  }
}

function isValidStorageKey(key: string): boolean {
  if (!key || key.length > 240) return false;
  for (const char of key) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return !key.split("/").some((part) => part === "." || part === "..");
}

function recordView(record: StorageRecord): Record<string, unknown> {
  return {
    key: record.key,
    value: JSON.parse(record.valueJson) as unknown,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    _links: {
      self: { href: `/storage/records/${encodeStorageKey(record.key)}` },
      collection: { href: "/storage/records" },
    },
    actions: {
      replace: {
        method: "PUT",
        href: `/storage/records/${encodeStorageKey(record.key)}`,
        encoding: "application/json",
      },
      delete: {
        method: "DELETE",
        href: `/storage/records/${encodeStorageKey(record.key)}`,
      },
    },
  };
}

function fileView(file: StorageFileMetadata): Record<string, unknown> {
  return {
    key: file.key,
    content_type: file.contentType,
    size: file.size,
    sha256: file.sha256,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
    _links: {
      self: { href: `/storage/files/${encodeStorageKey(file.key)}` },
      collection: { href: "/storage/files" },
    },
    actions: {
      replace: {
        method: "PUT",
        href: `/storage/files/${encodeStorageKey(file.key)}`,
      },
      delete: {
        method: "DELETE",
        href: `/storage/files/${encodeStorageKey(file.key)}`,
      },
    },
  };
}

function storageLinks(config: AppConfig): Record<string, unknown> {
  return {
    service: { href: config.issuerUrl },
    records: { href: `${config.issuerUrl}/storage/records` },
    files: { href: `${config.issuerUrl}/storage/files` },
    docs: { href: `${config.issuerUrl}/docs`, type: "text/html" },
    openapi: {
      href: `${config.issuerUrl}/openapi.json`,
      type: "application/json",
    },
  };
}

function storageActions(
  config: AppConfig,
  kind: "records" | "files",
): Record<string, unknown> {
  const base = `${config.issuerUrl}/storage/${kind}/{key}`;
  return {
    list: { method: "GET", href: `${config.issuerUrl}/storage/${kind}` },
    put: {
      method: "PUT",
      href: base,
      encoding:
        kind === "records" ? "application/json" : "application/octet-stream",
      parameters: ["key"],
    },
    delete: { method: "DELETE", href: base, parameters: ["key"] },
  };
}

function encodeStorageKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function storageAttachmentDisposition(key: string): string {
  const fileName = key.split("/").filter(Boolean).at(-1) || "aittadb-download";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="aittadb-download"; filename*=UTF-8''${encoded}`;
}

function parseJwtAudience(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const padded = payload
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { aud?: unknown };
    return typeof claims.aud === "string" ? claims.aud : null;
  } catch {
    return null;
  }
}
