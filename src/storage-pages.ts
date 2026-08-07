import {
  conditionalField,
  conditionalFormScript,
  escapeHtml,
  pageDocument,
} from "./pages";

type StorageKind = "records" | "files";
type StorageMethod = "GET" | "POST" | "PUT" | "DELETE";

export function recordStorageFormPage(
  csrf: string,
  key = "",
  signedIn = false,
  payload?: Record<string, unknown>,
): string {
  return storageFormPage("records", csrf, key, signedIn, payload);
}

export function fileStorageFormPage(
  csrf: string,
  key = "",
  signedIn = false,
  payload?: Record<string, unknown>,
): string {
  return storageFormPage("files", csrf, key, signedIn, payload);
}

function storageFormPage(
  kind: StorageKind,
  csrf: string,
  key: string,
  signedIn: boolean,
  payload?: Record<string, unknown>,
): string {
  const records = kind === "records";
  const collection = `/storage/${kind}`;
  const resourceKey = storagePayloadKey(payload) || key;
  const collectionPayload = isCollectionPayload(payload);
  const item = resourceKey
    ? `${collection}/${encodeStorageKey(resourceKey)}`
    : "";
  const title = records ? "JSON record storage" : "File object storage";
  const availableActions = payload ? storageActionNames(payload) : undefined;
  const controls =
    item && !collectionPayload
      ? itemOperations(
          kind,
          item,
          resourceKey,
          csrf,
          signedIn,
          availableActions,
        )
      : collectionOperations(
          kind,
          collection,
          csrf,
          signedIn,
          availableActions,
        );
  const body = `${storageState(kind, payload)}${controls}`;

  return pageDocument({
    title,
    eyebrow: records ? "D1 application data" : "D1 metadata and R2 objects",
    heading: title,
    summary:
      item && !collectionPayload
        ? `Work with the ${records ? "record" : "file"} at this exact AittaDB resource URL using your current sign-in or an application's access token.`
        : signedIn
          ? `List your private persistent ${records ? "records" : "files"}, or open an exact item endpoint.`
          : `Sign in to list private persistent ${records ? "records" : "files"}, or use an application's AittaDB access token.`,
    visualEyebrow: records ? "Structured application state" : "Object boundary",
    visualHeading: records
      ? "One local subject. One client boundary."
      : "Logical keys outside. Generated object keys inside.",
    visualSummary: records
      ? "Every record operation is isolated by its immutable AittaDB subject and OAuth client ID."
      : "AittaDB keeps searchable metadata in D1, stores bytes in R2, and never exposes caller-controlled physical object keys.",
    body,
    actions: [
      {
        href: "/session",
        label: signedIn ? "My signed-in session" : "Sign in with ChatGPT",
      },
      {
        href: records ? "/storage/files" : "/storage/records",
        label: records ? "File storage" : "JSON records",
        secondary: true,
      },
      { href: "/docs", label: "API docs", secondary: true },
    ],
    scripts: conditionalFormScript(),
  });
}

function collectionOperations(
  kind: StorageKind,
  collection: string,
  csrf: string,
  signedIn: boolean,
  availableActions?: ReadonlySet<string>,
): string {
  const records = kind === "records";
  const noun = records ? "record" : "file";
  const sections: string[] = [];
  if (actionAvailable(availableActions, `list-${kind}`)) {
    sections.push(
      operationSection({
        method: "GET",
        title: `List ${noun}s`,
        summary: `Read ${records ? "keys and JSON values" : "file metadata"} in the selected identity and client namespace.`,
        form: storageActionForm({
          action: collection,
          method: "GET",
          csrf,
          signedIn,
          prefix: `${kind}_list`,
          submitLabel: `List ${noun}s`,
        }),
      }),
    );
  }
  if (!records && actionAvailable(availableActions, "create-file")) {
    sections.push(
      operationSection({
        method: "POST",
        title: "Upload new file",
        summary:
          "Create a file with a server-generated logical key, then continue at its exact item URL.",
        form: storageActionForm({
          action: collection,
          method: "POST",
          csrf,
          signedIn,
          prefix: "files_create",
          submitLabel: "Upload new file",
          extraFields: fileUploadField("files_create_file"),
          multipart: true,
        }),
      }),
    );
  }
  if (
    actionAvailable(availableActions, `open-${noun}`) ||
    availableActions?.has(`create-or-replace-${noun}`)
  ) {
    sections.push(
      operationSection({
        method: "GET",
        title: records
          ? "Open or create one record"
          : "Open or upload one file",
        summary: records
          ? "Move to the exact record URL to read an existing value or create a missing record."
          : "Move to the exact file URL to download an existing file or upload a missing file.",
        form: `<form method="get" action="${collection}" class="stacked-form" data-fallback-action="${collection}" data-key-action-template="${collection}/{key}"><label for="${kind}_navigate_key">Logical ${noun} key</label><input id="${kind}_navigate_key" name="key" data-resource-key maxlength="240" autocomplete="off" required><div class="actions"><button type="submit">Continue to ${noun} endpoint</button></div></form>`,
      }),
    );
  }
  return `<section class="resource-workbench" aria-labelledby="collection-actions-heading"><h2 id="collection-actions-heading">Collection actions</h2>${sections.join("") || `<p class="empty-state">No collection actions are available for the current authorization.</p>`}</section><p class="note">The collection URL owns listing and item navigation. Item operations live only at <code>${collection}/{key}</code>. Current-session mode uses your durable private AittaDB namespace; access-token mode uses the token's separate OAuth client namespace.</p>`;
}

function itemOperations(
  kind: StorageKind,
  item: string,
  key: string,
  csrf: string,
  signedIn: boolean,
  availableActions?: ReadonlySet<string>,
): string {
  const records = kind === "records";
  const noun = records ? "record" : "file";
  const readLabel = records ? "Read record" : "Download file";
  const creating = availableActions?.has(`create-${noun}`) ?? false;
  const writeLabel = creating
    ? records
      ? "Create record"
      : "Upload file"
    : records
      ? "Update record"
      : "Update file";
  const writeField = records
    ? recordValueField()
    : fileUploadField("files_write_file");
  const sections: string[] = [];
  const readAction = records ? "read-record" : "download-file";
  if (actionAvailable(availableActions, readAction)) {
    sections.push(
      operationSection({
        method: "GET",
        title: readLabel,
        summary: records
          ? "Read the JSON value at this exact resource URL."
          : "Return the file bytes from this exact resource URL as an attachment.",
        form: storageActionForm({
          action: item,
          method: "GET",
          csrf,
          signedIn,
          prefix: `${kind}_read`,
          submitLabel: readLabel,
        }),
      }),
    );
  }
  if (
    actionAvailable(availableActions, `create-${noun}`) ||
    actionAvailable(availableActions, `replace-${noun}`) ||
    actionAvailable(availableActions, `create-or-replace-${noun}`)
  ) {
    sections.push(
      operationSection({
        method: "PUT",
        title: writeLabel,
        summary: records
          ? "Store a JSON value at this exact resource URL."
          : "Store file bytes and D1 metadata at this exact resource URL.",
        form: storageActionForm({
          action: item,
          method: "PUT",
          csrf,
          signedIn,
          prefix: `${kind}_write`,
          submitLabel: creating
            ? records
              ? "Create record"
              : "Upload file"
            : records
              ? "Update record"
              : "Update file",
          extraFields: writeField,
          multipart: !records,
        }),
      }),
    );
  }
  if (actionAvailable(availableActions, `delete-${noun}`)) {
    sections.push(
      operationSection({
        method: "DELETE",
        title: `Delete ${noun}`,
        summary: `Permanently remove the ${noun} at this exact resource URL.`,
        form: storageActionForm({
          action: item,
          method: "DELETE",
          csrf,
          signedIn,
          prefix: `${kind}_delete`,
          submitLabel: `Delete ${noun}`,
          danger: true,
        }),
      }),
    );
  }
  return `<section class="resource-address" aria-label="Selected storage resource"><span>Logical ${noun} key</span><code>${escapeHtml(key)}</code><span>Resource path</span><code>${escapeHtml(item)}</code></section><section class="resource-workbench" aria-labelledby="item-actions-heading"><h2 id="item-actions-heading">Item actions</h2>${sections.join("") || `<p class="empty-state">No item actions are available for the current authorization.</p>`}</section><p class="note">All browser actions post back to <code>${escapeHtml(item)}</code>, then the protected adapter invokes that resource's canonical <code>GET</code>, <code>PUT</code>, or <code>DELETE</code> operation. The URL key cannot be replaced by a form field.</p>`;
}

function operationSection(options: {
  method: StorageMethod;
  title: string;
  summary: string;
  form: string;
}): string {
  return `<section class="resource-operation"><header><span class="method-badge method-${options.method.toLowerCase()}">${options.method}</span><div><h3>${escapeHtml(options.title)}</h3><p>${escapeHtml(options.summary)}</p></div></header>${options.form}</section>`;
}

function storageActionForm(options: {
  action: string;
  method: StorageMethod;
  csrf: string;
  signedIn: boolean;
  prefix: string;
  submitLabel: string;
  extraFields?: string;
  multipart?: boolean;
  danger?: boolean;
}): string {
  const encoding = options.multipart ? ` enctype="multipart/form-data"` : "";
  return `<form method="post" action="${escapeHtml(options.action)}"${encoding} class="stacked-form" data-conditional-form><input type="hidden" name="ui" value="1"><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrf)}"><input type="hidden" name="_method" value="${options.method}">${authenticationFields(options.prefix, options.signedIn)}${options.extraFields ?? ""}<div class="actions"><button${options.danger ? ` class="danger"` : ""} type="submit">${escapeHtml(options.submitLabel)}</button></div></form>`;
}

function authenticationFields(prefix: string, signedIn: boolean): string {
  return `<label for="${prefix}_auth_mode">Authentication</label><select id="${prefix}_auth_mode" name="auth_mode" required><option value="session"${signedIn ? " selected" : ""}>Current signed-in session${signedIn ? "" : " (sign-in required)"}</option><option value="token"${signedIn ? "" : " selected"}>AittaDB access token</option></select>${conditionalField("auth_mode:token", `<label for="${prefix}_access_token">AittaDB access token</label><textarea id="${prefix}_access_token" name="access_token" class="credential-input" autocomplete="off" spellcheck="false" data-required-when-visible="true"></textarea>`)}`;
}

function recordValueField(): string {
  return `<label for="records_write_value">JSON value <span class="optional">maximum 64 KiB</span></label><textarea id="records_write_value" name="value" class="json-input" spellcheck="false" required>{}</textarea>`;
}

function fileUploadField(id: string): string {
  return `<div class="file-drop-zone" data-file-drop-zone><label for="${id}">File <span class="optional">maximum 10 MiB</span></label><input id="${id}" name="file" type="file" aria-describedby="${id}_status" required><p id="${id}_status" data-file-drop-status>Choose a file, or drag and drop it here.</p></div>`;
}

function encodeStorageKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function storageResultPage(options: {
  kind: StorageKind;
  operation: string;
  payload: unknown;
  resourceHref?: string;
  csrf: string;
  signedIn: boolean;
}): string {
  const payload = objectValue(options.payload) ?? {};
  const key =
    storagePayloadKey(payload) || keyFromResourceHref(options.resourceHref);
  return options.kind === "records"
    ? recordStorageFormPage(options.csrf, key, options.signedIn, payload)
    : fileStorageFormPage(options.csrf, key, options.signedIn, payload);
}

function storageState(
  kind: StorageKind,
  payload?: Record<string, unknown>,
): string {
  if (!payload) return "";
  const type = stringValue(payload.type);
  const data = objectValue(payload.data);
  if (!data)
    return storageStatus(
      "Storage operation completed",
      "The storage resource was updated.",
    );
  if (type === "error") {
    return storageErrorState(data);
  }
  if (type.endsWith("-collection")) return collectionState(kind, data);
  if (type.endsWith("-deletion")) {
    const noun = kind === "records" ? "record" : "file";
    const key = stringValue(data.key);
    return storageStatus(
      `${capitalize(noun)} deleted`,
      `No ${noun} remains at the logical key ${key || "requested"}.`,
    );
  }
  return itemState(kind, data);
}

function storageErrorState(data: Record<string, unknown>): string {
  const description =
    stringValue(data.error_description) || "The storage request failed.";
  return `<section class="storage-state storage-status" role="alert"><h2>Storage request failed</h2><p>${escapeHtml(description)}</p></section>`;
}

function collectionState(
  kind: StorageKind,
  data: Record<string, unknown>,
): string {
  const records = kind === "records";
  const noun = records ? "record" : "file";
  const items = Array.isArray(data.items)
    ? data.items
        .map(objectValue)
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (items.length === 0) {
    return `<section class="storage-state" aria-labelledby="stored-${kind}-heading"><h2 id="stored-${kind}-heading">Your ${kind}</h2><p class="empty-state">No ${kind} found.</p></section>`;
  }
  const rows = items
    .map((document) => {
      const itemData = objectValue(document.data) ?? {};
      const key = stringValue(itemData.key);
      const href = `/storage/${kind}/${encodeStorageKey(key)}`;
      if (records) {
        return `<tr><td><code>${escapeHtml(key)}</code></td><td><code class="table-value">${escapeHtml(jsonPreview(itemData.value))}</code></td><td>${timeElement(itemData.updated_at)}</td><td><a class="table-link" href="${escapeHtml(href)}">Open ${noun}</a></td></tr>`;
      }
      return `<tr><td><code>${escapeHtml(key)}</code></td><td>${escapeHtml(stringValue(itemData.content_type) || "application/octet-stream")}</td><td>${escapeHtml(formatBytes(numberValue(itemData.size)))}</td><td>${timeElement(itemData.updated_at)}</td><td><a class="table-link" href="${escapeHtml(href)}">Open ${noun}</a></td></tr>`;
    })
    .join("");
  const headings = records
    ? "<th>Key</th><th>Value</th><th>Updated</th><th>Action</th>"
    : "<th>Key</th><th>Content type</th><th>Size</th><th>Updated</th><th>Action</th>";
  return `<section class="storage-state" aria-labelledby="stored-${kind}-heading"><div class="storage-state-heading"><div><h2 id="stored-${kind}-heading">Your ${kind}</h2><p>${items.length} ${items.length === 1 ? noun : kind} found.</p></div></div><div class="table-wrap"><table class="resource-table"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function itemState(kind: StorageKind, data: Record<string, unknown>): string {
  const records = kind === "records";
  const key = stringValue(data.key);
  if (records) {
    return `<section class="storage-state" aria-labelledby="record-details-heading"><h2 id="record-details-heading">Record details</h2><section class="info-grid" aria-label="Record metadata"><div><span>Logical key</span><code>${escapeHtml(key)}</code></div><div><span>Updated</span>${timeElement(data.updated_at)}</div><div><span>Created</span>${timeElement(data.created_at)}</div></section><h3>Stored JSON value</h3><pre class="record-value" aria-label="Stored JSON value">${escapeHtml(JSON.stringify(data.value, null, 2))}</pre></section>`;
  }
  return `<section class="storage-state" aria-labelledby="file-details-heading"><h2 id="file-details-heading">File details</h2><section class="info-grid" aria-label="File metadata"><div><span>Logical key</span><code>${escapeHtml(key)}</code></div><div><span>Content type</span><strong>${escapeHtml(stringValue(data.content_type) || "application/octet-stream")}</strong></div><div><span>Size</span><strong>${escapeHtml(formatBytes(numberValue(data.size)))}</strong></div><div><span>SHA-256</span><code>${escapeHtml(stringValue(data.sha256))}</code></div><div><span>Updated</span>${timeElement(data.updated_at)}</div><div><span>Created</span>${timeElement(data.created_at)}</div></section></section>`;
}

function storageStatus(title: string, message: string): string {
  return `<section class="storage-state storage-status" role="status"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></section>`;
}

function storageActionNames(
  payload: Record<string, unknown>,
): ReadonlySet<string> {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return new Set(
    actions
      .map(objectValue)
      .map((candidate) => stringValue(candidate?.name))
      .filter(Boolean),
  );
}

function actionAvailable(
  available: ReadonlySet<string> | undefined,
  name: string,
): boolean {
  return available === undefined || available.has(name);
}

function isCollectionPayload(payload?: Record<string, unknown>): boolean {
  return stringValue(payload?.type).endsWith("-collection");
}

function storagePayloadKey(payload?: Record<string, unknown>): string {
  return stringValue(objectValue(payload?.data)?.key);
}

function keyFromResourceHref(href?: string): string {
  if (!href) return "";
  try {
    const pathname = new URL(href, "https://aittadb.invalid").pathname;
    const match = pathname.match(/^\/storage\/(?:records|files)\/(.+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonPreview(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (!rendered) return "null";
  return rendered.length > 96 ? `${rendered.slice(0, 93)}...` : rendered;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function timeElement(value: unknown): string {
  const seconds = numberValue(value);
  if (!seconds) return "<span>Unknown</span>";
  const date = new Date(seconds * 1000).toISOString();
  return `<time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>`;
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
