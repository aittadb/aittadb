import { nowSeconds, sha256, uuid } from "./crypto";
import {
  bearerToken,
  hypermediaJson,
  isJsonMediaType,
  oauthError,
  readBoundedRequestBody,
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
import { decodeStorageCursor, encodeStorageCursor } from "./storage-cursor";
import type {
  AppConfig,
  AuthStore,
  ClientView,
  RuntimeEnv,
  StorageFileMetadata,
  StorageListPosition,
  StorageRecord,
  StorageUsage,
} from "./types";

export const MAX_RECORD_BYTES = 65_536;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const R2_DELETE_ATTEMPTS = 2;

type StorageScope = "storage.read" | "storage.write" | "storage.delete";

interface StoragePrincipal {
  userId: string;
  client: ClientView;
  scopes: string[];
  writesEnabled: boolean;
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
  writesEnabled: boolean;
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

interface StoragePageRequest {
  cursor: string | null;
  position: StorageListPosition | null;
  pageSize: number;
}

interface StorageCollectionPage {
  cursor: string | null;
  nextCursor: string | null;
  pageSize: number;
  usage: StorageUsage;
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
    const page = await parseStoragePage(url, "records", principal, config);
    if (page instanceof Response) return page;
    const [records, usage] = await Promise.all([
      store.listStorageRecords(
        principal.userId,
        principal.client.id,
        page.position,
        page.pageSize,
      ),
      store.getStorageUsage(principal.userId, principal.client.id),
    ]);
    const nextCursor = await nextStorageCursor(
      "records",
      records.items,
      records.hasMore,
      principal,
      config,
    );
    return hypermediaJson(
      request,
      storageCollectionDocument(
        config,
        "records",
        records.items.map((record) =>
          recordDocument(
            record,
            config,
            storageActionContext(principal, representation),
          ),
        ),
        storageActionContext(principal, representation),
        {
          cursor: page.cursor,
          nextCursor,
          pageSize: page.pageSize,
          usage,
        },
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
      if (!(await store.upsertStorageRecord(record, config.storageLimits))) {
        return storageLimitExceeded();
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
    const page = await parseStoragePage(url, "files", principal, config);
    if (page instanceof Response) return page;
    const [files, usage] = await Promise.all([
      store.listStorageFiles(
        principal.userId,
        principal.client.id,
        page.position,
        page.pageSize,
      ),
      store.getStorageUsage(principal.userId, principal.client.id),
    ]);
    const nextCursor = await nextStorageCursor(
      "files",
      files.items,
      files.hasMore,
      principal,
      config,
    );
    return hypermediaJson(
      request,
      storageCollectionDocument(
        config,
        "files",
        files.items.map((file) =>
          fileDocument(
            file,
            config,
            storageActionContext(principal, representation),
            Boolean(env.BUCKET),
          ),
        ),
        storageActionContext(principal, representation),
        {
          cursor: page.cursor,
          nextCursor,
          pageSize: page.pageSize,
          usage,
        },
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
        if (!(await deleteStorageFileConsistently(env.BUCKET!, store, file))) {
          return storageConflict();
        }
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
  const expectedR2Key = existing?.r2Key ?? null;
  try {
    if (
      !(await store.upsertStorageFileMetadata(
        file,
        expectedR2Key,
        config.storageLimits,
      ))
    ) {
      await deleteR2Object(env.BUCKET, r2Key);
      const current = await store.getStorageFileMetadata(
        principal.userId,
        principal.client.id,
        fileKey,
      );
      if (
        (expectedR2Key === null && current !== null) ||
        (expectedR2Key !== null && current?.r2Key !== expectedR2Key)
      ) {
        return storageConflict();
      }
      return storageLimitExceeded();
    }
  } catch (error) {
    try {
      await deleteR2Object(env.BUCKET, r2Key);
    } catch {
      await recordStorageFileOrphanRepairs(store, file);
    }
    throw error;
  }
  if (existing) {
    if (
      !(await retireReplacedStorageObject(env.BUCKET, store, existing, file))
    ) {
      return storageConflict();
    }
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
): Promise<boolean> {
  if (
    !(await store.deleteStorageFileMetadata(
      file.userId,
      file.clientId,
      file.key,
      file.r2Key,
    ))
  ) {
    return false;
  }
  try {
    await deleteR2Object(bucket, file.r2Key);
    return true;
  } catch (deleteError) {
    const present = await r2ObjectPresent(bucket, file.r2Key);
    if (present === false) return true;
    if (present === null) {
      await recordStorageFileOrphanRepairs(store, file);
      throw deleteError;
    }
    if (present === true) {
      try {
        if (!(await store.upsertStorageFileMetadata(file, null))) {
          await deleteR2Object(bucket, file.r2Key);
          return false;
        }
      } catch (restoreError) {
        // If metadata restoration fails, complete the deletion when possible
        // instead of leaving an unreferenced object after a partial rollback.
        try {
          await deleteR2Object(bucket, file.r2Key);
          return true;
        } catch {
          await recordStorageFileOrphanRepairs(store, file);
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
): Promise<boolean> {
  try {
    await deleteR2Object(bucket, previous.r2Key);
  } catch (deleteError) {
    const previousPresent = await r2ObjectPresent(bucket, previous.r2Key);
    if (previousPresent === false) {
      return currentFileIs(store, replacement);
    }
    if (previousPresent === null) {
      await recordStorageFileOrphanRepairs(store, previous);
      throw deleteError;
    }

    try {
      if (
        !(await store.upsertStorageFileMetadata(previous, replacement.r2Key))
      ) {
        await deleteR2Object(bucket, previous.r2Key);
        return false;
      }
    } catch (restoreError) {
      // The replacement remains internally consistent. One final bounded
      // retirement attempt avoids rolling metadata back to an uncertain key.
      try {
        await deleteR2Object(bucket, previous.r2Key);
        return false;
      } catch {
        await recordStorageFileOrphanRepairs(store, previous);
        throw restoreError;
      }
    }

    try {
      await deleteR2Object(bucket, replacement.r2Key);
    } catch (cleanupError) {
      const replacementPresent = await r2ObjectPresent(
        bucket,
        replacement.r2Key,
      );
      let repairCandidates = replacementPresent === false ? [] : [replacement];
      if (replacementPresent === true) {
        // Keep metadata paired with the object that is known to exist if
        // rollback cleanup itself fails.
        try {
          if (
            await store.upsertStorageFileMetadata(replacement, previous.r2Key)
          ) {
            repairCandidates = [previous];
            try {
              await deleteR2Object(bucket, previous.r2Key);
              return true;
            } catch {
              // The previous object is now the only repair candidate.
            }
          }
        } catch {
          // The D1 outcome is uncertain, so repair must verify both objects.
          repairCandidates = [previous, replacement];
        }
      }
      await recordStorageFileOrphanRepairs(store, ...repairCandidates);
      throw cleanupError;
    }
    throw deleteError;
  }
  return currentFileIs(store, replacement);
}

async function recordStorageFileOrphanRepairs(
  store: AuthStore,
  ...files: StorageFileMetadata[]
): Promise<void> {
  const recordedAt = nowSeconds();
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.r2Key)) continue;
    seen.add(file.r2Key);
    const recorded = await store.recordStorageFileOrphanRepair({
      userId: file.userId,
      clientId: file.clientId,
      r2Key: file.r2Key,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
    if (!recorded) throw new Error("storage_file_repair_owner_conflict");
  }
}

async function currentFileIs(
  store: AuthStore,
  expected: StorageFileMetadata,
): Promise<boolean> {
  return (
    (
      await store.getStorageFileMetadata(
        expected.userId,
        expected.clientId,
        expected.key,
      )
    )?.r2Key === expected.r2Key
  );
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
    const rateKind = requiredScope === "storage.read" ? "read" : "write";
    const rateLimit =
      rateKind === "read"
        ? config.storageReadRateLimit
        : config.storageWriteRateLimit;
    const ownerHash = await sha256(`${user.id}:${client.id}`);
    if (
      !(await store.rateLimit(
        `storage:${rateKind}:${ownerHash}`,
        rateLimit,
        60,
        nowSeconds(),
      ))
    ) {
      const response = oauthError("slow_down", "Rate limit exceeded", 429);
      response.headers.set("retry-after", "60");
      return response;
    }
    if (
      requiredScope === "storage.write" &&
      !config.storageLimits.writesEnabled
    ) {
      return oauthError(
        "storage_writes_disabled",
        "Storage writes are temporarily disabled by this AittaDB deployment",
        503,
      );
    }
    return {
      userId: user.id,
      client,
      scopes,
      writesEnabled: config.storageLimits.writesEnabled,
    };
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
  let text: string;
  try {
    text = new TextDecoder().decode(
      await readBoundedRequestBody(request, maxBytes),
    );
  } catch (error) {
    return error instanceof Error && error.message === "request_too_large"
      ? oauthError("invalid_request", "Storage record is too large", 413)
      : oauthError("invalid_request", "Malformed JSON body");
  }
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
  try {
    return await readBoundedRequestBody(request, maxBytes);
  } catch (error) {
    return error instanceof Error && error.message === "request_too_large"
      ? oauthError("invalid_request", "Storage file is too large", 413)
      : oauthError("invalid_request", "Malformed request body");
  }
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
  page: StorageCollectionPage,
) {
  const href = storagePageHref(config, kind, page.pageSize, page.cursor);
  return resourceDocument({
    type: `storage-${kind}-collection`,
    id: href,
    data: {
      count: items.length,
      page_size: page.pageSize,
      has_more: Boolean(page.nextCursor),
      usage: {
        item_count: page.usage.itemCount,
        byte_count: page.usage.byteCount,
        item_limit: config.storageLimits.namespaceMaxItems,
        byte_limit: config.storageLimits.namespaceMaxBytes,
        writes_enabled: config.storageLimits.writesEnabled,
      },
      items: [...items],
    },
    links: storageCollectionLinks(config, kind, page),
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
    actions:
      context.writesEnabled && hasScope(context.scopes, "storage.write")
        ? [storagePutAction(config, kind, context, key, undefined, "missing")]
        : [],
  });
}

function storageCollectionLinks(
  config: AppConfig,
  kind: "records" | "files",
  page: StorageCollectionPage,
) {
  const other = kind === "records" ? "files" : "records";
  const otherEnabled =
    kind === "records" ? config.features.files : config.features.records;
  return [
    link("self", storagePageHref(config, kind, page.pageSize, page.cursor), {
      type: HYPERMEDIA_MEDIA_TYPE,
    }),
    ...(page.nextCursor
      ? [
          link(
            "next",
            storagePageHref(config, kind, page.pageSize, page.nextCursor),
            { type: HYPERMEDIA_MEDIA_TYPE },
          ),
        ]
      : []),
    ...(!otherEnabled
      ? []
      : [
          link(`storage-${other}`, `${config.issuerUrl}/storage/${other}`, {
            type: HYPERMEDIA_MEDIA_TYPE,
          }),
        ]),
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
  if (context.writesEnabled && hasScope(context.scopes, "storage.write")) {
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
  if (context.writesEnabled && hasScope(context.scopes, "storage.write")) {
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
    writesEnabled: principal.writesEnabled,
    ...(representation.csrfToken
      ? { csrfToken: representation.csrfToken }
      : {}),
  };
}

async function parseStoragePage(
  url: URL,
  kind: "records" | "files",
  principal: StoragePrincipal,
  config: AppConfig,
): Promise<StoragePageRequest | Response> {
  const rawPageSize = url.searchParams.get("page_size");
  const pageSize = rawPageSize
    ? Number.parseInt(rawPageSize, 10)
    : config.storageDefaultPageSize;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > config.storageMaxPageSize ||
    (rawPageSize !== null && String(pageSize) !== rawPageSize)
  ) {
    return oauthError(
      "invalid_request",
      `page_size must be an integer from 1 to ${config.storageMaxPageSize}`,
    );
  }
  const cursor = url.searchParams.get("cursor");
  const position = cursor
    ? await decodeStorageCursor(
        cursor,
        kind,
        principal.userId,
        principal.client.id,
        config,
      )
    : null;
  if (cursor && !position) {
    return oauthError("invalid_request", "Invalid storage cursor");
  }
  return { cursor, position, pageSize };
}

async function nextStorageCursor(
  kind: "records" | "files",
  items: readonly { updatedAt: number; key: string }[],
  hasMore: boolean,
  principal: StoragePrincipal,
  config: AppConfig,
): Promise<string | null> {
  const last = hasMore ? items.at(-1) : null;
  return last
    ? encodeStorageCursor(
        kind,
        principal.userId,
        principal.client.id,
        { updatedAt: last.updatedAt, key: last.key },
        config,
      )
    : null;
}

function storagePageHref(
  config: AppConfig,
  kind: "records" | "files",
  pageSize: number,
  cursor: string | null,
): string {
  const url = new URL(`${config.issuerUrl}/storage/${kind}`);
  url.searchParams.set("page_size", String(pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

function storageLimitExceeded(): Response {
  return oauthError(
    "storage_limit_exceeded",
    "A configured AittaDB storage limit has been reached",
    507,
  );
}

function storageConflict(): Response {
  return oauthError(
    "storage_conflict",
    "The file changed while this request was being processed",
    409,
  );
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
