import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
  type BrowserSessionScope,
} from "./browser-session";
import {
  acceptsHtml,
  bearerToken,
  csrfCookie,
  csrfTokenForRequest,
  csrfTokenMatches,
  html,
  oauthError,
  readForm,
  redirect,
  requireSameOrigin,
} from "./http";
import { errorPage } from "./pages";
import { protocolErrorPage } from "./protocol-pages";
import {
  encodeStorageKey,
  isValidStorageKey,
  MAX_FILE_BYTES,
  MAX_RECORD_BYTES,
  storageAttachmentDisposition,
  storageEndpoint,
} from "./storage";
import {
  fileStorageFormPage,
  recordStorageFormPage,
  storageResultPage,
} from "./storage-pages";
import type { AppConfig, AuthStore, RuntimeEnv } from "./types";

const MAX_RECORD_FORM_BYTES = MAX_RECORD_BYTES * 3 + 16_384;
const MAX_FILE_FORM_BYTES = MAX_FILE_BYTES + 256 * 1024;

type StorageKind = "records" | "files";
type StorageMethod = "GET" | "PUT" | "DELETE";
type StorageResource = { type: "collection" } | { type: "item"; key: string };

interface BrowserStorageOperation {
  method: StorageMethod;
  name: "list" | "read" | "write" | "download" | "upload" | "delete";
  scope: BrowserSessionScope;
}

export async function storageBrowserEndpoint(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response | null> {
  const kind = storageKind(url.pathname);
  if (!kind) return null;
  const resource = storageResource(url.pathname, kind);
  if (!resource) return null;

  if (request.method === "GET" && acceptsHtml(request)) {
    if (!bearerToken(request)) {
      if (resource.type === "collection" && url.searchParams.has("key")) {
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
          );
        }
        return redirect(
          `${collectionPath(kind)}/${encodeStorageKey(key)}`,
          303,
        );
      }
      return storageFormResponse(
        request,
        kind,
        resource.type === "item" ? resource.key : "",
        hasBrowserSession(request, env),
      );
    }
    const operation = browserOperation(kind, resource, "GET");
    const response = await storageEndpoint(request, url, env, store, config);
    return renderStorageResponse(
      response,
      kind,
      operation?.name ?? "read",
      url.pathname,
    );
  }

  if (request.method !== "POST") return null;

  if (!requireSameOrigin(request, config.issuerUrl)) {
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  }

  return kind === "records"
    ? handleRecordForm(request, url, resource, env, store, config)
    : handleFileForm(request, url, resource, env, store, config);
}

async function handleRecordForm(
  request: Request,
  url: URL,
  resource: StorageResource,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return methodNotAllowed(resourceMethods(resource));
  }
  let form: URLSearchParams;
  try {
    form = await readForm(request, MAX_RECORD_FORM_BYTES);
  } catch (error) {
    return storageFormReadError(error, "records", url.pathname);
  }
  if (form.get("ui") !== "1")
    return methodNotAllowed(resourceMethods(resource));
  if (!csrfTokenMatches(request, form.get("csrf_token"))) return csrfError();

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
    );
  }
  const headers = await browserStorageHeaders(
    request,
    form.get("auth_mode"),
    form.get("access_token") || "",
    operation.scope,
    env,
    store,
    config,
  );
  if (headers instanceof Response) {
    return renderStorageResponse(
      headers,
      "records",
      operation.name,
      url.pathname,
    );
  }
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
  );
  return renderStorageResponse(
    response,
    "records",
    operation.name,
    target.pathname,
  );
}

async function handleFileForm(
  request: Request,
  url: URL,
  resource: StorageResource,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const multipart = contentType.includes("multipart/form-data");
  const urlEncoded = contentType.includes("application/x-www-form-urlencoded");
  if (!multipart && !urlEncoded)
    return methodNotAllowed(resourceMethods(resource));

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (
    multipart &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_FILE_FORM_BYTES
  ) {
    return renderStorageResponse(
      oauthError("invalid_request", "Storage file form is too large", 413),
      "files",
      "upload",
      url.pathname,
    );
  }

  let form: FormData | URLSearchParams;
  try {
    form = multipart
      ? await request.formData()
      : await readForm(request, MAX_RECORD_FORM_BYTES);
  } catch (error) {
    return storageFormReadError(error, "files", url.pathname);
  }
  if (stringEntry(form.get("ui")) !== "1") {
    return methodNotAllowed(resourceMethods(resource));
  }
  if (!csrfTokenMatches(request, stringEntry(form.get("csrf_token")))) {
    return csrfError();
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
    );
  }
  if (operation.method === "PUT" && !multipart) {
    return renderStorageResponse(
      oauthError(
        "invalid_request",
        "File upload requires multipart form data",
        415,
      ),
      "files",
      operation.name,
      url.pathname,
    );
  }

  const headers = await browserStorageHeaders(
    request,
    stringEntry(form.get("auth_mode")),
    stringEntry(form.get("access_token")),
    operation.scope,
    env,
    store,
    config,
  );
  if (headers instanceof Response) {
    return renderStorageResponse(
      headers,
      "files",
      operation.name,
      url.pathname,
    );
  }
  let body: ArrayBuffer | undefined;
  if (operation.method === "PUT") {
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) {
      return renderStorageResponse(
        oauthError("invalid_request", "A file is required for upload"),
        "files",
        operation.name,
        url.pathname,
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return renderStorageResponse(
        oauthError("invalid_request", "Storage file is too large", 413),
        "files",
        operation.name,
        url.pathname,
      );
    }
    headers.set("content-type", file.type || "application/octet-stream");
    body = await file.arrayBuffer();
  }
  const target = canonicalStorageUrl(url);
  const response = await storageEndpoint(
    new Request(target, { method: operation.method, headers, body }),
    target,
    env,
    store,
    config,
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
  );
}

async function renderStorageResponse(
  response: Response,
  kind: StorageKind,
  operation: string,
  retryHref: string,
): Promise<Response> {
  if (
    !(response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    return response;
  }
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return response;
  const page =
    response.status >= 400
      ? protocolErrorPage(payload, response.status, retryHref)
      : storageResultPage({
          kind,
          operation,
          payload,
          resourceHref: retryHref,
        });
  return html(page, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function browserOperation(
  kind: StorageKind,
  resource: StorageResource,
  submittedMethod: string | null,
): BrowserStorageOperation | null {
  if (resource.type === "collection") {
    return submittedMethod === "GET"
      ? { method: "GET", name: "list", scope: "storage.read" }
      : null;
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
): Response {
  const csrf = csrfTokenForRequest(request);
  const page =
    kind === "records"
      ? recordStorageFormPage(csrf, key, signedIn)
      : fileStorageFormPage(csrf, key, signedIn);
  return html(page, { headers: { "set-cookie": csrfCookie(csrf) } });
}

function storageHeaders(token: string): Headers {
  return new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });
}

async function browserStorageHeaders(
  request: Request,
  submittedMode: string | null,
  submittedToken: string,
  scope: BrowserSessionScope,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Headers | Response> {
  const mode =
    submittedMode || (submittedToken.length > 0 ? "token" : "session");
  if (mode !== "session" && mode !== "token") {
    return oauthError("invalid_request", "Unsupported authentication mode");
  }
  if (mode === "token") {
    return submittedToken
      ? storageHeaders(submittedToken)
      : oauthError("invalid_request", "An AittaDB access token is required");
  }

  const accessToken = await issueBrowserSessionAccessToken(
    request,
    env,
    store,
    config,
    [scope],
  );
  return accessToken instanceof Response
    ? accessToken
    : storageHeaders(accessToken);
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

function canonicalStorageUrl(url: URL): URL {
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  return target;
}

function resourceMethods(resource: StorageResource): string {
  return resource.type === "collection" ? "GET" : "GET, PUT, DELETE";
}

function stringEntry(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value : "";
}

function storageFormReadError(
  error: unknown,
  kind: StorageKind,
  retryHref: string,
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
  );
}

function csrfError(): Response {
  return html(
    errorPage("Invalid request", "CSRF validation failed", { status: 403 }),
    { status: 403 },
  );
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
