import { nowSeconds, sha256, uuid } from "./crypto";
import {
  bearerToken,
  hypermediaJson,
  isJsonMediaType,
  oauthError,
} from "./http";
import {
  HYPERMEDIA_MEDIA_TYPE,
  action,
  field,
  link,
  resourceDocument,
  type HypermediaAction,
  type HypermediaDocument,
  type HypermediaField,
} from "./hypermedia";
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
const R2_DELETE_ATTEMPTS = 2;

type StorageScope = "storage.read" | "storage.write" | "storage.delete";

interface StoragePrincipal {
  userId: string;
  client: ClientView;
  scopes: string[];
}

export interface StorageRepresentationContext {
  actionScopes?: readonly string[];
  authorizationScheme?: "bearer" | "sites-session";
  csrfToken?: string;
}

interface StorageActionContext {
  scopes: readonly string[];
  authorizationScheme: "bearer" | "sites-session";
  csrfToken?: string;
}

interface StorageRecordData {
  key: string;
  value: unknown;
  created_at: number;
  updated_at: number;
}

interface StorageFileData {
  key: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: number;
  updated_at: number;
}

export async function storageEndpoint(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
  representation: StorageRepresentationContext = {},
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
    return hypermediaJson(
      request,
      storageCollectionDocument(
        config,
        "records",
        records.map((record) =>
          recordDocument(
            record,
            config,
            storageActionContext(principal, representation),
          ),
        ),
        storageActionContext(principal, representation),
      ),
    );
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
      if (!record) {
        return storageNotFound(
          config,
          "records",
          recordKey,
          storageActionContext(principal, representation),
        );
      }
      return hypermediaJson(
        request,
        recordDocument(
          record,
          config,
          storageActionContext(principal, representation),
        ),
      );
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
      return hypermediaJson(
        request,
        recordDocument(
          record,
          config,
          storageActionContext(principal, representation),
        ),
      );
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
      return hypermediaJson(
        request,
        storageDeletionDocument(
          config,
          "records",
          recordKey,
          storageActionContext(principal, representation),
        ),
      );
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
    return hypermediaJson(
      request,
      storageCollectionDocument(
        config,
        "files",
        files.map((file) =>
          fileDocument(
            file,
            config,
            storageActionContext(principal, representation),
            Boolean(env.BUCKET),
          ),
        ),
        storageActionContext(principal, representation),
      ),
    );
  }

  if (url.pathname === "/storage/files" && request.method === "POST") {
    const principal = await requireStorageScope(
      request,
      config,
      store,
      "storage.write",
    );
    if (principal instanceof Response) return principal;
    const fileKey = uuid();
    return writeStorageFile(
      request,
      fileKey,
      principal,
      env,
      store,
      config,
      representation,
      true,
    );
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
      if (!file) {
        return storageNotFound(
          config,
          "files",
          fileKey,
          storageActionContext(principal, representation),
        );
      }
      if (wantsFileMetadata(request)) {
        return hypermediaJson(
          request,
          fileDocument(
            file,
            config,
            storageActionContext(principal, representation),
            Boolean(env.BUCKET),
          ),
        );
      }
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
      return writeStorageFile(
        request,
        fileKey,
        principal,
        env,
        store,
        config,
        representation,
        false,
      );
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
      if (file && !env.BUCKET)
        return oauthError(
          "storage_unavailable",
          "R2 bucket is unavailable",
          503,
        );
      if (file) {
        await deleteStorageFileConsistently(env.BUCKET!, store, file);
      } else {
        await store.deleteStorageFileMetadata(
          principal.userId,
          principal.client.id,
          fileKey,
        );
      }
      return hypermediaJson(
        request,
        storageDeletionDocument(
          config,
          "files",
          fileKey,
          storageActionContext(principal, representation),
        ),
      );
    }
  }

  return oauthError("not_found", "No storage route matches this request", 404);
}

async function writeStorageFile(
  request: Request,
  fileKey: string,
  principal: StoragePrincipal,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
  representation: StorageRepresentationContext,
  created: boolean,
): Promise<Response> {
  if (!env.BUCKET)
    return oauthError("storage_unavailable", "R2 bucket is unavailable", 503);
  const body = await readBytes(request, MAX_FILE_BYTES);
  if (body instanceof Response) return body;
  const existing = created
    ? null
    : await store.getStorageFileMetadata(
        principal.userId,
        principal.client.id,
        fileKey,
      );
  const now = nowSeconds();
  // Copy-on-write keeps the committed object untouched until its new metadata
  // is durable, so a failed replacement cannot change bytes behind old metadata.
  const r2Key = `users/${principal.userId}/clients/${principal.client.id}/files/${uuid()}`;
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
  try {
    await store.upsertStorageFileMetadata(file);
  } catch (error) {
    await deleteR2Object(env.BUCKET, r2Key);
    throw error;
  }
  if (existing) {
    await retireReplacedStorageObject(env.BUCKET, store, existing, file);
  }
  return hypermediaJson(
    request,
    fileDocument(
      file,
      config,
      storageActionContext(principal, representation),
      true,
    ),
    created
      ? {
          status: 201,
          headers: { location: itemHref(config, "files", fileKey) },
        }
      : undefined,
  );
}

async function deleteStorageFileConsistently(
  bucket: R2Bucket,
  store: AuthStore,
  file: StorageFileMetadata,
): Promise<void> {
  await store.deleteStorageFileMetadata(file.userId, file.clientId, file.key);
  try {
    await deleteR2Object(bucket, file.r2Key);
  } catch (deleteError) {
    const present = await r2ObjectPresent(bucket, file.r2Key);
    if (present === false) return;
    if (present === true) {
      try {
        await store.upsertStorageFileMetadata(file);
      } catch (restoreError) {
        // If metadata restoration fails, complete the deletion when possible
        // instead of leaving an unreferenced object after a partial rollback.
        try {
          await deleteR2Object(bucket, file.r2Key);
          return;
        } catch {
          throw restoreError;
        }
      }
    }
    throw deleteError;
  }
}

async function retireReplacedStorageObject(
  bucket: R2Bucket,
  store: AuthStore,
  previous: StorageFileMetadata,
  replacement: StorageFileMetadata,
): Promise<void> {
  try {
    await deleteR2Object(bucket, previous.r2Key);
  } catch (deleteError) {
    const previousPresent = await r2ObjectPresent(bucket, previous.r2Key);
    if (previousPresent === false) return;
    if (previousPresent !== true) throw deleteError;

    try {
      await store.upsertStorageFileMetadata(previous);
    } catch (restoreError) {
      // The replacement remains internally consistent. One final bounded
      // retirement attempt avoids rolling metadata back to an uncertain key.
      try {
        await deleteR2Object(bucket, previous.r2Key);
        return;
      } catch {
        throw restoreError;
      }
    }

    try {
      await deleteR2Object(bucket, replacement.r2Key);
    } catch (cleanupError) {
      if ((await r2ObjectPresent(bucket, replacement.r2Key)) === true) {
        // Keep metadata paired with the object that is known to exist if
        // rollback cleanup itself fails.
        try {
          await store.upsertStorageFileMetadata(replacement);
        } catch {
          // The outer request still fails generically; no internal key leaks.
        }
      }
      throw cleanupError;
    }
    throw deleteError;
  }
}

async function deleteR2Object(bucket: R2Bucket, key: string): Promise<void> {
  let lastError: unknown = new Error("r2_delete_failed");
  for (let attempt = 0; attempt < R2_DELETE_ATTEMPTS; attempt += 1) {
    try {
      await bucket.delete(key);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if ((await r2ObjectPresent(bucket, key)) === false) return;
  throw lastError;
}

async function r2ObjectPresent(
  bucket: R2Bucket,
  key: string,
): Promise<boolean | null> {
  try {
    return (await bucket.get(key)) !== null;
  } catch {
    return null;
  }
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
    return { userId: user.id, client, scopes };
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

export function isValidStorageKey(key: string): boolean {
  if (!key || key.length > 240) return false;
  for (const char of key) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return !key.split("/").some((part) => part === "." || part === "..");
}

function storageCollectionDocument(
  config: AppConfig,
  kind: "records" | "files",
  items: readonly HypermediaDocument<unknown>[],
  context: StorageActionContext,
) {
  const href = `${config.issuerUrl}/storage/${kind}`;
  return resourceDocument({
    type: `storage-${kind}-collection`,
    id: href,
    data: { count: items.length, items: [...items] },
    links: storageCollectionLinks(config, kind),
    actions: storageCollectionActions(config, kind, context),
  });
}

function recordDocument(
  record: StorageRecord,
  config: AppConfig,
  context: StorageActionContext,
): HypermediaDocument<StorageRecordData> {
  const data: StorageRecordData = {
    key: record.key,
    value: JSON.parse(record.valueJson) as unknown,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
  return resourceDocument({
    type: "storage-record",
    id: record.key,
    data,
    links: storageItemLinks(config, "records", record.key),
    actions: storageItemActions(config, "records", record.key, context, data),
  });
}

function fileDocument(
  file: StorageFileMetadata,
  config: AppConfig,
  context: StorageActionContext,
  bucketAvailable: boolean,
): HypermediaDocument<StorageFileData> {
  const data: StorageFileData = {
    key: file.key,
    content_type: file.contentType,
    size: file.size,
    sha256: file.sha256,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
  };
  return resourceDocument({
    type: "storage-file",
    id: file.key,
    data,
    links: storageItemLinks(config, "files", file.key),
    actions: storageItemActions(
      config,
      "files",
      file.key,
      context,
      data,
      bucketAvailable,
    ),
  });
}

function storageDeletionDocument(
  config: AppConfig,
  kind: "records" | "files",
  key: string,
  context: StorageActionContext,
) {
  const singular = kind === "records" ? "record" : "file";
  return resourceDocument({
    type: `storage-${singular}-deletion`,
    id: key,
    data: { deleted: true, key, resource_type: `storage-${singular}` },
    links: [
      link("collection", `${config.issuerUrl}/storage/${kind}`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
    ],
    actions: hasScope(context.scopes, "storage.write")
      ? [storagePutAction(config, kind, context, key, undefined, "missing")]
      : [],
  });
}

function storageCollectionLinks(config: AppConfig, kind: "records" | "files") {
  const other = kind === "records" ? "files" : "records";
  return [
    link("self", `${config.issuerUrl}/storage/${kind}`, {
      type: HYPERMEDIA_MEDIA_TYPE,
    }),
    link(`storage-${other}`, `${config.issuerUrl}/storage/${other}`, {
      type: HYPERMEDIA_MEDIA_TYPE,
    }),
    link("item", `${config.issuerUrl}/storage/${kind}/{key}`, {
      type: HYPERMEDIA_MEDIA_TYPE,
      templated: true,
    }),
    link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
    link("documentation", `${config.issuerUrl}/docs`, { type: "text/html" }),
    link("describedby", `${config.issuerUrl}/openapi.json`, {
      type: "application/json",
    }),
  ];
}

function storageItemLinks(
  config: AppConfig,
  kind: "records" | "files",
  key: string,
) {
  return [
    link("self", itemHref(config, kind, key), {
      type: HYPERMEDIA_MEDIA_TYPE,
    }),
    link("collection", `${config.issuerUrl}/storage/${kind}`, {
      type: HYPERMEDIA_MEDIA_TYPE,
    }),
    link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
  ];
}

function storageCollectionActions(
  config: AppConfig,
  kind: "records" | "files",
  context: StorageActionContext,
): HypermediaAction[] {
  const singular = kind === "records" ? "record" : "file";
  const actions: HypermediaAction[] = [];
  if (hasScope(context.scopes, "storage.read")) {
    actions.push(
      action(
        `list-${kind}`,
        `List ${kind}`,
        "GET",
        `${config.issuerUrl}/storage/${kind}`,
        {
          accept: HYPERMEDIA_MEDIA_TYPE,
          authorization: storageAuthorization(
            "storage.read",
            context.authorizationScheme,
          ),
          fields: [],
        },
      ),
      action(
        `open-${singular}`,
        `Open ${singular}`,
        "GET",
        `${config.issuerUrl}/storage/${kind}/{key}`,
        {
          accept: HYPERMEDIA_MEDIA_TYPE,
          templated: true,
          authorization: storageAuthorization(
            "storage.read",
            context.authorizationScheme,
          ),
          fields: [storageKeyField()],
        },
      ),
    );
  }
  if (hasScope(context.scopes, "storage.write")) {
    if (kind === "files") {
      actions.push(storageCreateFileAction(config, context));
    }
    actions.push(storagePutAction(config, kind, context));
  }
  return actions;
}

function storageItemActions(
  config: AppConfig,
  kind: "records" | "files",
  key: string,
  context: StorageActionContext,
  data: StorageRecordData | StorageFileData,
  bucketAvailable = true,
): HypermediaAction[] {
  const singular = kind === "records" ? "record" : "file";
  const href = itemHref(config, kind, key);
  const actions: HypermediaAction[] = [];
  if (hasScope(context.scopes, "storage.read")) {
    actions.push(
      action(`read-${singular}`, `Read ${singular}`, "GET", href, {
        accept: HYPERMEDIA_MEDIA_TYPE,
        authorization: storageAuthorization(
          "storage.read",
          context.authorizationScheme,
        ),
        fields: [],
      }),
    );
    if (kind === "files" && bucketAvailable) {
      actions.push(
        action(
          "download-file",
          "Download file",
          context.authorizationScheme === "sites-session" ? "POST" : "GET",
          href,
          {
            ...(context.authorizationScheme === "sites-session"
              ? {
                  type: "application/x-www-form-urlencoded",
                  fields: sessionAdapterFields(context, "GET"),
                }
              : { fields: [] }),
            accept: "application/octet-stream",
            authorization: storageAuthorization(
              "storage.read",
              context.authorizationScheme,
            ),
          },
        ),
      );
    }
  }
  if (hasScope(context.scopes, "storage.write")) {
    actions.push(storagePutAction(config, kind, context, key, data));
  }
  if (hasScope(context.scopes, "storage.delete")) {
    actions.push(
      action(
        `delete-${singular}`,
        `Delete ${singular}`,
        context.authorizationScheme === "sites-session" ? "POST" : "DELETE",
        href,
        {
          ...(context.authorizationScheme === "sites-session"
            ? {
                type: "application/x-www-form-urlencoded",
                fields: sessionAdapterFields(context, "DELETE"),
              }
            : { fields: [] }),
          authorization: storageAuthorization(
            "storage.delete",
            context.authorizationScheme,
          ),
        },
      ),
    );
  }
  return actions;
}

function storageCreateFileAction(
  config: AppConfig,
  context: StorageActionContext,
): HypermediaAction {
  const session = context.authorizationScheme === "sites-session";
  return action(
    "create-file",
    "Upload new file",
    "POST",
    `${config.issuerUrl}/storage/files`,
    {
      type: session ? "multipart/form-data" : "application/octet-stream",
      accept: HYPERMEDIA_MEDIA_TYPE,
      authorization: storageAuthorization(
        "storage.write",
        context.authorizationScheme,
      ),
      fields: [
        ...(session ? sessionAdapterFields(context, "POST") : []),
        field("file", "File", "file", "body", {
          required: true,
          max_bytes: MAX_FILE_BYTES,
        }),
      ],
    },
  );
}

function storagePutAction(
  config: AppConfig,
  kind: "records" | "files",
  context: StorageActionContext,
  key?: string,
  data?: StorageRecordData | StorageFileData,
  state: "collection" | "missing" | "existing" = key === undefined
    ? "collection"
    : "existing",
): HypermediaAction {
  const records = kind === "records";
  const singular = records ? "record" : "file";
  const templated = key === undefined;
  const fields = templated ? [storageKeyField()] : [];
  const session = context.authorizationScheme === "sites-session";
  if (session) fields.push(...sessionAdapterFields(context, "PUT"));
  fields.push(
    records
      ? field("value", "JSON value", session ? "string" : "object", "body", {
          required: true,
          max_bytes: MAX_RECORD_BYTES,
          ...(session
            ? {
                description: "JSON text submitted through the browser adapter.",
              }
            : {}),
          ...("value" in (data ?? {})
            ? { value: (data as StorageRecordData).value }
            : {}),
        })
      : field("file", "File", "file", "body", {
          required: true,
          max_bytes: MAX_FILE_BYTES,
        }),
  );
  return action(
    `${state === "collection" ? "create-or-replace" : state === "missing" ? "create" : "replace"}-${singular}`,
    `${state === "collection" ? "Create or replace" : state === "missing" ? "Create" : "Replace"} ${singular}`,
    session ? "POST" : "PUT",
    key === undefined
      ? `${config.issuerUrl}/storage/${kind}/{key}`
      : itemHref(config, kind, key),
    {
      type: session
        ? records
          ? "application/x-www-form-urlencoded"
          : "multipart/form-data"
        : records
          ? "application/json"
          : "application/octet-stream",
      accept: HYPERMEDIA_MEDIA_TYPE,
      templated,
      authorization: storageAuthorization(
        "storage.write",
        context.authorizationScheme,
      ),
      fields,
    },
  );
}

function storageKeyField() {
  return field("key", "Logical storage key", "string", "path", {
    required: true,
    min_length: 1,
    max_length: 240,
  });
}

function storageAuthorization(
  scope: StorageScope,
  scheme: "bearer" | "sites-session",
) {
  return { scheme, scopes: [scope] };
}

function hasScope(scopes: readonly string[], scope: StorageScope): boolean {
  return scopes.includes(scope);
}

function storageActionContext(
  principal: StoragePrincipal,
  representation: StorageRepresentationContext,
): StorageActionContext {
  return {
    scopes: representation.actionScopes ?? principal.scopes,
    authorizationScheme: representation.authorizationScheme ?? "bearer",
    ...(representation.csrfToken
      ? { csrfToken: representation.csrfToken }
      : {}),
  };
}

function sessionAdapterFields(
  context: StorageActionContext,
  method: "GET" | "POST" | "PUT" | "DELETE",
): HypermediaField[] {
  return [
    field("ui", "Browser operation", "string", "body", {
      required: true,
      value: "1",
    }),
    field("csrf_token", "CSRF token", "string", "body", {
      required: true,
      secret: true,
      value: context.csrfToken ?? "",
    }),
    field("_method", "Canonical method", "string", "body", {
      required: true,
      value: method,
    }),
    field("auth_mode", "Authentication", "string", "body", {
      required: true,
      value: "session",
      options: [{ value: "session", title: "Current signed-in session" }],
    }),
  ];
}

function itemHref(
  config: AppConfig,
  kind: "records" | "files",
  key: string,
): string {
  return `${config.issuerUrl}/storage/${kind}/${encodeStorageKey(key)}`;
}

function storageNotFound(
  config: AppConfig,
  kind: "records" | "files",
  key: string,
  context: StorageActionContext,
): Response {
  const singular = kind === "records" ? "record" : "file";
  return oauthError("not_found", `Storage ${singular} not found`, 404, {
    links: [
      link("collection", `${config.issuerUrl}/storage/${kind}`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
    ],
    actions: hasScope(context.scopes, "storage.write")
      ? [storagePutAction(config, kind, context, key, undefined, "missing")]
      : [],
  });
}

function wantsFileMetadata(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return (
      isJsonMediaType(mediaType) ||
      mediaType === "text/html" ||
      mediaType === "application/*"
    );
  });
}

export function encodeStorageKey(key: string): string {
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
