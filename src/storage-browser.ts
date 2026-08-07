import { randomToken } from "./crypto";
import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
  type BrowserSessionScope,
} from "./browser-session";
import {
  acceptsHtml,
  bearerToken,
  csrfCookie,
  csrfTokenMatches,
  html,
  oauthError,
  readForm,
  requireSameOrigin,
} from "./http";
import { errorPage } from "./pages";
import { protocolErrorPage } from "./protocol-pages";
import {
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

export async function storageBrowserEndpoint(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response | null> {
  const kind = storageKind(url.pathname);
  if (!kind) return null;

  if (request.method === "GET" && acceptsHtml(request)) {
    if (!bearerToken(request)) {
      return storageFormResponse(
        kind,
        keyFromPath(url.pathname, kind),
        hasBrowserSession(request, env),
      );
    }
    const response = await storageEndpoint(request, url, env, store, config);
    return renderStorageResponse(response, kind, "read", collectionPath(kind));
  }

  if (request.method !== "POST" || url.pathname !== collectionPath(kind)) {
    return null;
  }

  if (!requireSameOrigin(request)) {
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  }

  return kind === "records"
    ? handleRecordForm(request, url, env, store, config)
    : handleFileForm(request, url, env, store, config);
}

async function handleRecordForm(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return methodNotAllowed("GET");
  }
  const form = await readForm(request, MAX_RECORD_FORM_BYTES);
  if (form.get("ui") !== "1") return methodNotAllowed("GET");
  if (!csrfTokenMatches(request, form.get("csrf_token"))) {
    return csrfError();
  }

  const operation = form.get("operation") || "";
  const key = form.get("key") || "";
  const token = form.get("access_token") || "";
  const target = operationTarget(url, "records", operation, key);
  if (target instanceof Response) return target;
  const headers = await browserStorageHeaders(
    request,
    form.get("auth_mode"),
    token,
    operationScope(operation),
    env,
    store,
    config,
  );
  if (headers instanceof Response) {
    return renderStorageResponse(
      headers,
      "records",
      operation,
      "/storage/records",
    );
  }
  let body: string | undefined;
  if (operation === "write") {
    headers.set("content-type", "application/json");
    body = form.get("value") || "";
  }
  const response = await storageEndpoint(
    new Request(target.url, {
      method: target.method,
      headers,
      body,
    }),
    target.url,
    env,
    store,
    config,
  );
  return renderStorageResponse(
    response,
    "records",
    operation,
    "/storage/records",
  );
}

async function handleFileForm(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore,
  config: AppConfig,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return methodNotAllowed("GET");
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_FORM_BYTES) {
    return oauthError("invalid_request", "Storage file form is too large", 413);
  }
  const form = await request.formData();
  if (form.get("ui") !== "1") return methodNotAllowed("GET");
  if (!csrfTokenMatches(request, stringEntry(form.get("csrf_token")))) {
    return csrfError();
  }

  const operation = stringEntry(form.get("operation"));
  const key = stringEntry(form.get("key"));
  const token = stringEntry(form.get("access_token"));
  const target = operationTarget(url, "files", operation, key);
  if (target instanceof Response) return target;
  const headers = await browserStorageHeaders(
    request,
    stringEntry(form.get("auth_mode")),
    token,
    operationScope(operation),
    env,
    store,
    config,
  );
  if (headers instanceof Response) {
    return renderStorageResponse(headers, "files", operation, "/storage/files");
  }
  let body: ArrayBuffer | undefined;
  if (operation === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) {
      return oauthError("invalid_request", "A file is required for upload");
    }
    if (file.size > MAX_FILE_BYTES) {
      return oauthError("invalid_request", "Storage file is too large", 413);
    }
    headers.set("content-type", file.type || "application/octet-stream");
    body = await file.arrayBuffer();
  }
  const response = await storageEndpoint(
    new Request(target.url, {
      method: target.method,
      headers,
      body,
    }),
    target.url,
    env,
    store,
    config,
  );
  if (operation === "download" && response.ok) {
    const headersOut = new Headers(response.headers);
    headersOut.set("content-disposition", storageAttachmentDisposition(key));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headersOut,
    });
  }
  return renderStorageResponse(response, "files", operation, "/storage/files");
}

async function renderStorageResponse(
  response: Response,
  kind: "records" | "files",
  operation: string,
  retryHref: string,
): Promise<Response> {
  if (
    !(response.headers.get("content-type") ?? "").includes("application/json")
  )
    return response;
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return response;
  const page =
    response.status >= 400
      ? protocolErrorPage(payload, response.status, retryHref)
      : storageResultPage({ kind, operation, payload });
  return html(page, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function operationTarget(
  sourceUrl: URL,
  kind: "records" | "files",
  operation: string,
  key: string,
): { method: string; url: URL } | Response {
  const method = {
    list: "GET",
    read: "GET",
    download: "GET",
    write: "PUT",
    upload: "PUT",
    delete: "DELETE",
  }[operation];
  if (!method)
    return oauthError("invalid_request", "Unsupported storage operation");
  if (operation !== "list" && !key) {
    return oauthError("invalid_request", "A logical storage key is required");
  }
  const target = new URL(collectionPath(kind), sourceUrl.origin);
  if (operation !== "list") {
    target.pathname = `${collectionPath(kind)}/${encodeStorageKey(key)}`;
  }
  return { method, url: target };
}

function storageFormResponse(
  kind: "records" | "files",
  key: string,
  signedIn: boolean,
): Response {
  const csrf = randomToken(24);
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
  if (mode === "token") return storageHeaders(submittedToken);

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

function operationScope(operation: string): BrowserSessionScope {
  if (operation === "write" || operation === "upload") return "storage.write";
  if (operation === "delete") return "storage.delete";
  return "storage.read";
}

function storageKind(pathname: string): "records" | "files" | null {
  if (
    pathname === "/storage/records" ||
    pathname.startsWith("/storage/records/")
  )
    return "records";
  if (pathname === "/storage/files" || pathname.startsWith("/storage/files/"))
    return "files";
  return null;
}

function collectionPath(kind: "records" | "files"): string {
  return `/storage/${kind}`;
}

function keyFromPath(pathname: string, kind: "records" | "files"): string {
  const prefix = `${collectionPath(kind)}/`;
  if (!pathname.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return "";
  }
}

function encodeStorageKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function stringEntry(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
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
