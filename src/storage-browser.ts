import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
  type BrowserSessionScope,
} from "./browser-session";
import {
  acceptsHtml,
  acceptsJson,
  bearerToken,
  csrfCookie,
  csrfTokenForRequest,
  csrfTokenMatches,
  html,
  isJsonMediaType,
  oauthError,
  readBoundedBody,
  readForm,
  redirect,
  requireSameOrigin,
} from "./http";
import {
  HYPERMEDIA_API_VERSION,
  HYPERMEDIA_MEDIA_TYPE,
  requestedHypermediaVersion,
} from "./hypermedia";
import {
  requireSitesIdentity,
  type UpstreamIdentityProvider,
} from "./identity";
import { errorPage } from "./pages";
import {
  encodeStorageKey,
  isValidStorageKey,
  MAX_FILE_BYTES,
  MAX_RECORD_BYTES,
  storageAttachmentDisposition,
  storageEndpoint,
  type StorageRepresentationContext,
} from "./storage";
import {
  fileStorageFormPage,
  recordStorageFormPage,
  storageResultPage,
} from "./storage-pages";
import type { AppConfig, AuthStore, RuntimeEnv } from "./types";

export const MAX_STORAGE_FORM_BYTES = MAX_RECORD_BYTES * 3 + 16_384;
const MAX_FILE_FORM_BYTES = MAX_FILE_BYTES + 256 * 1024;

type StorageKind = "records" | "files";
type StorageMethod = "GET" | "POST" | "PUT" | "DELETE";
type StorageResource = { type: "collection" } | { type: "item"; key: string };

interface BrowserStorageOperation {
  method: StorageMethod;
  name: "list" | "read" | "write" | "download" | "upload" | "delete";
  scope: BrowserSessionScope;
}

interface BrowserStorageRequest {
  headers: Headers;
  representation?: StorageRepresentationContext;
}

const SESSION_STORAGE_SCOPES: readonly BrowserSessionScope[] = [
  "storage.read",
  "storage.write",
  "storage.delete",
];

const SESSION_REPRESENTATION: StorageRepresentationContext = {
  actionScopes: SESSION_STORAGE_SCOPES,
  authorizationScheme: "sites-session",
};

export async function storageBrowserEndpoint(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response | null> {
  const kind = storageKind(url.pathname);
  if (!kind) return null;
  const resource = storageResource(url.pathname, kind);
  if (!resource) return null;

  if (request.method === "GET" && !bearerToken(request)) {
    const htmlRequested = acceptsHtml(request);
    const vendorRequested = requestedHypermediaVersion(request).requested;
    const compatibilityJsonRequested = acceptsJson(request);
    const signedIn = hasBrowserSession(request, identityProvider);
    if (
      htmlRequested &&
      resource.type === "collection" &&
      url.searchParams.has("key")
    ) {
      const key = url.searchParams.get("key") ?? "";
      if (!isValidStorageKey(key)) {
        return renderStorageResponse(
          oauthError(
            "invalid_request",
            "A valid logical storage key is required",
          ),
          kind,
          "navigate",
          collectionPath(kind),
          request,
          signedIn,
          siblingStorageEnabled(config, kind),
        );
      }
      return redirect(`${collectionPath(kind)}/${encodeStorageKey(key)}`, 303);
    }
    if (
      signedIn &&
      (htmlRequested || vendorRequested || compatibilityJsonRequested)
    ) {
      const csrf = csrfTokenForRequest(request);
      const representation: StorageRepresentationContext = htmlRequested
        ? SESSION_REPRESENTATION
        : { ...SESSION_REPRESENTATION, csrfToken: csrf };
      const accessToken = await issueBrowserSessionAccessToken(
        request,
        identityProvider,
        store,
        config,
        ["storage.read"],
      );
      if (accessToken instanceof Response) {
        return htmlRequested
          ? renderStorageResponse(
              accessToken,
              kind,
              "read",
              url.pathname,
              request,
              true,
              siblingStorageEnabled(config, kind),
            )
          : accessToken;
      }
      const target = canonicalStorageUrl(url);
      const response = await storageEndpoint(
        new Request(target, {
          method: "GET",
          headers: storageHeaders(accessToken),
        }),
        target,
        env,
        store,
        config,
        representation,
      );
      if (htmlRequested) {
        return renderStorageResponse(
          response,
          kind,
          resource.type === "collection" ? "list" : "read",
          target.pathname,
          request,
          true,
          siblingStorageEnabled(config, kind),
        );
      }
      response.headers.set("set-cookie", csrfCookie(csrf));
      return response;
    }
    if (htmlRequested) {
      return storageFormResponse(
        request,
        kind,
        resource.type === "item" ? resource.key : "",
        false,
        siblingStorageEnabled(config, kind),
      );
    }
  }

  if (request.method === "GET" && acceptsHtml(request)) {
    if (!bearerToken(request)) {
      return storageFormResponse(
        request,
        kind,
        resource.type === "item" ? resource.key : "",
        hasBrowserSession(request, identityProvider),
        siblingStorageEnabled(config, kind),
      );
    }
    const operation = browserOperation(kind, resource, "GET");
    const response = await storageEndpoint(request, url, env, store, config);
    return renderStorageResponse(
      response,
      kind,
      operation?.name ?? "read",
      url.pathname,
      request,
      hasBrowserSession(request, identityProvider),
      siblingStorageEnabled(config, kind),
    );
  }

  if (request.method !== "POST") return null;

  const browserContentType = request.headers.get("content-type") ?? "";
  if (
    !browserContentType.includes("application/x-www-form-urlencoded") &&
    !browserContentType.includes("multipart/form-data")
  ) {
    return null;
  }

  if (!requireSameOrigin(request, config.issuerUrl)) {
    return storageSecurityError(
      request,
      "Same-origin form submission is required",
    );
  }

  return kind === "records"
    ? handleRecordForm(
        request,
        url,
        resource,
        env,
        store,
        config,
        identityProvider,
      )
    : handleFileForm(
        request,
        url,
        resource,
        env,
        store,
        config,
        identityProvider,
      );
}

async function handleRecordForm(
  request: Request,
  url: URL,
  resource: StorageResource,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return methodNotAllowed(resourceMethods("records", resource));
  }
  let form: URLSearchParams;
  try {
    form = await readForm(request, MAX_STORAGE_FORM_BYTES);
  } catch (error) {
    return storageFormReadError(
      error,
      "records",
      url.pathname,
      request,
      config.features.files,
    );
  }
  if (form.get("ui") !== "1")
    return methodNotAllowed(resourceMethods("records", resource));
  if (!csrfTokenMatches(request, form.get("csrf_token")))
    return storageSecurityError(request, "CSRF validation failed");

  const operation = browserOperation("records", resource, form.get("_method"));
  if (!operation) {
    return renderStorageResponse(
      oauthError(
        "invalid_request",
        "This browser action does not match the JSON storage resource URL",
      ),
      "records",
      "invalid",
      url.pathname,
      request,
      hasBrowserSession(request, identityProvider),
      config.features.files,
    );
  }
  const authorized = await browserStorageHeaders(
    request,
    form.get("auth_mode"),
    form.get("access_token") || "",
    operation.scope,
    store,
    config,
    identityProvider,
  );
  if (authorized instanceof Response) {
    return renderStorageResponse(
      authorized,
      "records",
      operation.name,
      url.pathname,
      request,
      hasBrowserSession(request, identityProvider),
      config.features.files,
    );
  }
  const { headers } = authorized;
  let body: string | undefined;
  if (operation.method === "PUT") {
    headers.set("content-type", "application/json");
    body = form.get("value") || "";
  }
  const target = canonicalStorageUrl(url);
  const response = await storageEndpoint(
    new Request(target, { method: operation.method, headers, body }),
    target,
    env,
    store,
    config,
    authorized.representation,
  );
  return renderStorageResponse(
    response,
    "records",
    operation.name,
    target.pathname,
    request,
    hasBrowserSession(request, identityProvider),
    config.features.files,
  );
}

async function handleFileForm(
  request: Request,
  url: URL,
  resource: StorageResource,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const multipart = contentType.includes("multipart/form-data");
  const urlEncoded = contentType.includes("application/x-www-form-urlencoded");
  if (!multipart && !urlEncoded)
    return methodNotAllowed(resourceMethods("files", resource));
  if (multipart) {
    const identity = requireSitesIdentity(request, identityProvider);
    if (identity instanceof Response) return identity;
  }

  let form: FormData | URLSearchParams;
  try {
    form = multipart
      ? await readBoundedMultipartForm(request, MAX_FILE_FORM_BYTES)
      : await readForm(request, MAX_STORAGE_FORM_BYTES);
  } catch (error) {
    return storageFormReadError(
      error,
      "files",
      url.pathname,
      request,
      config.features.records,
    );
  }
  if (stringEntry(form.get("ui")) !== "1") {
    return methodNotAllowed(resourceMethods("files", resource));
  }
  if (!csrfTokenMatches(request, stringEntry(form.get("csrf_token")))) {
    return storageSecurityError(request, "CSRF validation failed");
  }

  const operation = browserOperation(
    "files",
    resource,
    stringEntry(form.get("_method")),
  );
  if (!operation) {
    return renderStorageResponse(
      oauthError(
        "invalid_request",
        "This browser action does not match the file storage resource URL",
      ),
      "files",
      "invalid",
      url.pathname,
      request,
      hasBrowserSession(request, identityProvider),
      config.features.records,
    );
  }
  if (
    (operation.method === "PUT" || operation.method === "POST") &&
    !multipart
  ) {
    return renderStorageResponse(
      oauthError(
        "invalid_request",
        "File upload requires multipart form data",
        415,
      ),
      "files",
      operation.name,
      url.pathname,
      request,
      hasBrowserSession(request, identityProvider),
      config.features.records,
    );
  }

  const authorized = await browserStorageHeaders(
    request,
    stringEntry(form.get("auth_mode")),
    stringEntry(form.get("access_token")),
    operation.scope,
    store,
    config,
    identityProvider,
  );
  if (authorized instanceof Response) {
    return renderStorageResponse(
      authorized,
      "files",
      operation.name,
      url.pathname,
      request,
      hasBrowserSession(request, identityProvider),
      config.features.records,
    );
  }
  const { headers } = authorized;
  let body: ArrayBuffer | undefined;
  if (operation.method === "PUT" || operation.method === "POST") {
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) {
      return renderStorageResponse(
        oauthError("invalid_request", "A file is required for upload"),
        "files",
        operation.name,
        url.pathname,
        request,
        hasBrowserSession(request, identityProvider),
        config.features.records,
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return renderStorageResponse(
        oauthError("invalid_request", "Storage file is too large", 413),
        "files",
        operation.name,
        url.pathname,
        request,
        hasBrowserSession(request, identityProvider),
        config.features.records,
      );
    }
    headers.set("content-type", file.type || "application/octet-stream");
    body = await file.arrayBuffer();
  }
  const target = canonicalStorageUrl(url);
  if (operation.name === "download") {
    headers.set("accept", "application/octet-stream");
  }
  const response = await storageEndpoint(
    new Request(target, { method: operation.method, headers, body }),
    target,
    env,
    store,
    config,
    authorized.representation,
  );
  if (
    operation.name === "download" &&
    response.ok &&
    resource.type === "item"
  ) {
    const headersOut = new Headers(response.headers);
    headersOut.set(
      "content-disposition",
      storageAttachmentDisposition(resource.key),
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headersOut,
    });
  }
  return renderStorageResponse(
    response,
    "files",
    operation.name,
    target.pathname,
    request,
    hasBrowserSession(request, identityProvider),
    config.features.records,
  );
}

async function readBoundedMultipartForm(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const declaredLength = request.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      throw new Error("request_too_large");
    }
  }

  const body = await readBoundedBody(request.body, maxBytes);
  const contentType = request.headers.get("content-type") ?? "";
  return new Response(body, {
    headers: { "content-type": contentType },
  }).formData();
}

async function renderStorageResponse(
  response: Response,
  kind: StorageKind,
  operation: string,
  retryHref: string,
  request?: Request,
  signedIn = false,
  siblingStorageEnabled = true,
): Promise<Response> {
  if (request && !acceptsHtml(request)) return response;
  if (!isJsonMediaType(response.headers.get("content-type") ?? "")) {
    return response;
  }
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return response;
  const csrf = request ? csrfTokenForRequest(request) : "";
  const page = storageResultPage({
    kind,
    operation,
    payload,
    resourceHref: retryHref,
    csrf,
    signedIn,
    ...(kind === "records"
      ? { filesEnabled: siblingStorageEnabled }
      : { recordsEnabled: siblingStorageEnabled }),
  });
  const headers = new Headers(response.headers);
  if (request) headers.set("set-cookie", csrfCookie(csrf));
  return html(page, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function browserOperation(
  kind: StorageKind,
  resource: StorageResource,
  submittedMethod: string | null,
): BrowserStorageOperation | null {
  if (resource.type === "collection") {
    if (submittedMethod === "GET") {
      return { method: "GET", name: "list", scope: "storage.read" };
    }
    if (kind === "files" && submittedMethod === "POST") {
      return { method: "POST", name: "upload", scope: "storage.write" };
    }
    return null;
  }
  if (submittedMethod === "GET") {
    return {
      method: "GET",
      name: kind === "records" ? "read" : "download",
      scope: "storage.read",
    };
  }
  if (submittedMethod === "PUT") {
    return {
      method: "PUT",
      name: kind === "records" ? "write" : "upload",
      scope: "storage.write",
    };
  }
  if (submittedMethod === "DELETE") {
    return { method: "DELETE", name: "delete", scope: "storage.delete" };
  }
  return null;
}

function storageFormResponse(
  request: Request,
  kind: StorageKind,
  key: string,
  signedIn: boolean,
  siblingStorageEnabled: boolean,
): Response {
  const csrf = csrfTokenForRequest(request);
  const page =
    kind === "records"
      ? recordStorageFormPage(
          csrf,
          key,
          signedIn,
          undefined,
          siblingStorageEnabled,
        )
      : fileStorageFormPage(
          csrf,
          key,
          signedIn,
          undefined,
          siblingStorageEnabled,
        );
  return html(page, { headers: { "set-cookie": csrfCookie(csrf) } });
}

function storageHeaders(token: string): Headers {
  return new Headers({
    accept: `${HYPERMEDIA_MEDIA_TYPE}; version=${HYPERMEDIA_API_VERSION}`,
    authorization: `Bearer ${token}`,
  });
}

async function browserStorageHeaders(
  request: Request,
  submittedMode: string | null,
  submittedToken: string,
  scope: BrowserSessionScope,
  store: AuthStore,
  config: AppConfig,
  identityProvider: UpstreamIdentityProvider,
): Promise<BrowserStorageRequest | Response> {
  const mode =
    submittedMode || (submittedToken.length > 0 ? "token" : "session");
  if (mode !== "session" && mode !== "token") {
    return oauthError("invalid_request", "Unsupported authentication mode");
  }
  if (mode === "token") {
    return submittedToken
      ? { headers: storageHeaders(submittedToken) }
      : oauthError("invalid_request", "An AittaDB access token is required");
  }

  const accessToken = await issueBrowserSessionAccessToken(
    request,
    identityProvider,
    store,
    config,
    [scope],
  );
  return accessToken instanceof Response
    ? accessToken
    : {
        headers: storageHeaders(accessToken),
        representation: {
          ...SESSION_REPRESENTATION,
          csrfToken: csrfTokenForRequest(request),
        },
      };
}

function storageKind(pathname: string): StorageKind | null {
  if (
    pathname === "/storage/records" ||
    pathname.startsWith("/storage/records/")
  ) {
    return "records";
  }
  if (pathname === "/storage/files" || pathname.startsWith("/storage/files/")) {
    return "files";
  }
  return null;
}

function storageResource(
  pathname: string,
  kind: StorageKind,
): StorageResource | null {
  const collection = collectionPath(kind);
  if (pathname === collection) return { type: "collection" };
  const prefix = `${collection}/`;
  if (!pathname.startsWith(prefix)) return null;
  try {
    const key = decodeURIComponent(pathname.slice(prefix.length));
    return isValidStorageKey(key) ? { type: "item", key } : null;
  } catch {
    return null;
  }
}

function collectionPath(kind: StorageKind): string {
  return `/storage/${kind}`;
}

function siblingStorageEnabled(config: AppConfig, kind: StorageKind): boolean {
  return kind === "records" ? config.features.files : config.features.records;
}

function canonicalStorageUrl(url: URL): URL {
  const target = new URL(url);
  const cursor = target.searchParams.get("cursor");
  const pageSize = target.searchParams.get("page_size");
  target.search = "";
  target.hash = "";
  if (/^\/storage\/(?:records|files)$/.test(target.pathname)) {
    if (pageSize) target.searchParams.set("page_size", pageSize);
    if (cursor) target.searchParams.set("cursor", cursor);
  }
  return target;
}

function resourceMethods(kind: StorageKind, resource: StorageResource): string {
  if (resource.type === "item") return "GET, PUT, DELETE";
  return kind === "files" ? "GET, POST" : "GET";
}

function stringEntry(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value : "";
}

function storageFormReadError(
  error: unknown,
  kind: StorageKind,
  retryHref: string,
  request: Request,
  siblingStorageEnabled: boolean,
): Promise<Response> {
  const tooLarge =
    error instanceof Error && error.message === "request_too_large";
  return renderStorageResponse(
    oauthError(
      "invalid_request",
      tooLarge
        ? "Storage browser form is too large"
        : "Malformed storage browser form",
      tooLarge ? 413 : 400,
    ),
    kind,
    "invalid",
    retryHref,
    request,
    false,
    siblingStorageEnabled,
  );
}

function storageSecurityError(request: Request, description: string): Response {
  return acceptsHtml(request)
    ? html(errorPage("Invalid request", description, { status: 403 }), {
        status: 403,
      })
    : oauthError("invalid_request", description, 403);
}

function methodNotAllowed(allowed: string): Response {
  const response = oauthError(
    "invalid_request",
    `Method not allowed; use ${allowed}`,
    405,
  );
  response.headers.set("allow", allowed);
  return response;
}
