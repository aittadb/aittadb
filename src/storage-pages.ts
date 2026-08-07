import {
  conditionalField,
  conditionalFormScript,
  escapeHtml,
  pageDocument,
} from "./pages";

type StorageKind = "records" | "files";
type StorageMethod = "GET" | "PUT" | "DELETE";

export function recordStorageFormPage(
  csrf: string,
  key = "",
  signedIn = false,
): string {
  return storageFormPage("records", csrf, key, signedIn);
}

export function fileStorageFormPage(
  csrf: string,
  key = "",
  signedIn = false,
): string {
  return storageFormPage("files", csrf, key, signedIn);
}

function storageFormPage(
  kind: StorageKind,
  csrf: string,
  key: string,
  signedIn: boolean,
): string {
  const records = kind === "records";
  const collection = `/storage/${kind}`;
  const item = key ? `${collection}/${encodeStorageKey(key)}` : "";
  const title = records ? "JSON record storage" : "File object storage";
  const body = key
    ? itemOperations(kind, item, key, csrf, signedIn)
    : collectionOperations(kind, collection, csrf, signedIn);

  return pageDocument({
    title,
    eyebrow: records ? "D1 application data" : "D1 metadata and R2 objects",
    heading: title,
    summary: key
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
): string {
  const records = kind === "records";
  const noun = records ? "record" : "file";
  return `<section class="resource-workbench" aria-labelledby="collection-actions-heading"><h2 id="collection-actions-heading">Collection actions</h2>${operationSection(
    {
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
    },
  )}${operationSection({
    method: "GET",
    title: `Open one ${noun}`,
    summary: `Move to the exact item URL before reading, replacing, or deleting that ${noun}.`,
    form: `<form method="get" action="${collection}" class="stacked-form" data-fallback-action="${collection}" data-key-action-template="${collection}/{key}"><label for="${kind}_navigate_key">Logical ${noun} key</label><input id="${kind}_navigate_key" name="key" data-resource-key maxlength="240" autocomplete="off" required><div class="actions"><button type="submit">Open ${noun} endpoint</button></div></form>`,
  })}</section><p class="note">The collection URL owns listing and item navigation. Item operations live only at <code>${collection}/{key}</code>. Current-session mode uses your durable private AittaDB namespace; access-token mode uses the token's separate OAuth client namespace.</p>`;
}

function itemOperations(
  kind: StorageKind,
  item: string,
  key: string,
  csrf: string,
  signedIn: boolean,
): string {
  const records = kind === "records";
  const noun = records ? "record" : "file";
  const readLabel = records ? "Read record" : "Download file";
  const writeLabel = records
    ? "Create or replace record"
    : "Upload or replace file";
  const writeField = records ? recordValueField() : fileUploadField();
  return `<section class="resource-address" aria-label="Selected storage resource"><span>Logical ${noun} key</span><code>${escapeHtml(key)}</code><span>Resource path</span><code>${escapeHtml(item)}</code></section><section class="resource-workbench" aria-labelledby="item-actions-heading"><h2 id="item-actions-heading">Item actions</h2>${operationSection(
    {
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
    },
  )}${operationSection({
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
      submitLabel: records ? "Save record" : "Upload file",
      extraFields: writeField,
      multipart: !records,
    }),
  })}${operationSection({
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
  })}</section><p class="note">All browser actions post back to <code>${escapeHtml(item)}</code>, then the protected adapter invokes that resource's canonical <code>GET</code>, <code>PUT</code>, or <code>DELETE</code> operation. The URL key cannot be replaced by a form field.</p>`;
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

function fileUploadField(): string {
  return `<label for="files_write_file">File <span class="optional">maximum 10 MiB</span></label><input id="files_write_file" name="file" type="file" required>`;
}

function encodeStorageKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function storageResultPage(options: {
  kind: StorageKind;
  operation: string;
  payload: unknown;
  resourceHref?: string;
}): string {
  const records = options.kind === "records";
  const title = records ? "Record operation result" : "File operation result";
  const collection = records ? "/storage/records" : "/storage/files";
  const retryHref = options.resourceHref ?? collection;
  return pageDocument({
    title,
    eyebrow: records ? "D1 application data" : "D1 metadata and R2 objects",
    heading: title,
    summary: `The production ${options.kind} endpoint completed the ${options.operation} operation.`,
    tone: "success",
    visualEyebrow: "Storage result",
    visualHeading: "The scoped operation completed inside AittaDB.",
    visualSummary:
      "The readable result comes from the same client-isolated repository operation used by REST API callers.",
    body: `<pre class="json-output" aria-label="Storage operation result">${escapeHtml(JSON.stringify(options.payload, null, 2))}</pre>`,
    actions: [
      {
        href: retryHref,
        label:
          retryHref === collection
            ? `Return to ${records ? "records" : "files"}`
            : `Return to this ${records ? "record" : "file"}`,
      },
      {
        href: records ? "/storage/files" : "/storage/records",
        label: records ? "File storage" : "JSON records",
        secondary: true,
      },
      { href: "/session", label: "My session", secondary: true },
    ],
  });
}
