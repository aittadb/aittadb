import { escapeHtml, pageDocument } from "./pages";

export function recordStorageFormPage(
  csrf: string,
  key = "",
  signedIn = false,
): string {
  return pageDocument({
    title: "JSON record storage",
    eyebrow: "D1 application data",
    heading: "JSON record storage",
    summary: signedIn
      ? "Use your current signed-in session or an explicit AittaDB access token to run real record operations."
      : "Sign in for personal browser-session storage or provide an AittaDB access token.",
    visualEyebrow: "Structured application state",
    visualHeading: "One local subject. One client boundary.",
    visualSummary:
      "Every record operation is authorized by the bearer token and isolated by its immutable AittaDB subject and OAuth client ID.",
    body: `<form method="post" action="/storage/records" class="stacked-form"><input type="hidden" name="ui" value="1"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="record_auth_mode">Authentication</label>${authenticationSelect("record_auth_mode", signedIn)}<label for="record_operation">Operation</label><select id="record_operation" name="operation" required><option value="list">List records</option><option value="read"${key ? " selected" : ""}>Read record</option><option value="write">Create or replace record</option><option value="delete">Delete record</option></select><label for="record_access_token">AittaDB access token <span class="optional">only for access-token mode</span></label><textarea id="record_access_token" name="access_token" class="credential-input" autocomplete="off" spellcheck="false"></textarea><label for="record_key">Logical record key</label><input id="record_key" name="key" value="${escapeHtml(key)}" maxlength="240" autocomplete="off"><label for="record_value">JSON value <span class="optional">write operation only, maximum 64 KiB</span></label><textarea id="record_value" name="value" class="json-input" spellcheck="false">{}</textarea><div class="actions"><button type="submit">Run record operation</button></div></form><p class="note">Current-session mode keeps data in your personal browser-session namespace, isolated by your immutable AittaDB UUID and the internal browser client. Access-token mode uses that token's separate OAuth client namespace and requires the matching storage scope. Tokens are never retained or copied into result pages.</p>`,
    actions: [
      {
        href: signedIn ? "/session" : "/session",
        label: signedIn ? "My signed-in session" : "Sign in with ChatGPT",
      },
      { href: "/storage/files", label: "File storage", secondary: true },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function fileStorageFormPage(
  csrf: string,
  key = "",
  signedIn = false,
): string {
  return pageDocument({
    title: "File object storage",
    eyebrow: "D1 metadata and R2 objects",
    heading: "File object storage",
    summary: signedIn
      ? "Use your current signed-in session or an explicit AittaDB access token to run real file operations."
      : "Sign in for personal browser-session files or provide an AittaDB access token.",
    visualEyebrow: "Object boundary",
    visualHeading: "Logical keys outside. Generated object keys inside.",
    visualSummary:
      "AittaDB keeps searchable metadata in D1, stores bytes in R2, and never uses a caller-controlled physical object key.",
    body: `<form method="post" action="/storage/files" enctype="multipart/form-data" class="stacked-form"><input type="hidden" name="ui" value="1"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="file_auth_mode">Authentication</label>${authenticationSelect("file_auth_mode", signedIn)}<label for="file_operation">Operation</label><select id="file_operation" name="operation" required><option value="list">List files</option><option value="download"${key ? " selected" : ""}>Download file</option><option value="upload">Upload or replace file</option><option value="delete">Delete file</option></select><label for="file_access_token">AittaDB access token <span class="optional">only for access-token mode</span></label><textarea id="file_access_token" name="access_token" class="credential-input" autocomplete="off" spellcheck="false"></textarea><label for="file_key">Logical file key</label><input id="file_key" name="key" value="${escapeHtml(key)}" maxlength="240" autocomplete="off"><label for="file_upload">File <span class="optional">upload operation only, maximum 10 MiB</span></label><input id="file_upload" name="file" type="file"><div class="actions"><button type="submit">Run file operation</button></div></form><p class="note">Current-session mode stores files in your personal browser-session namespace. Access-token mode uses the token's separate OAuth client namespace and matching storage scope. Uploads still pass through the canonical D1 metadata and R2 byte operation; no credential or physical object key reaches the result page.</p>`,
    actions: [
      {
        href: "/session",
        label: signedIn ? "My signed-in session" : "Sign in with ChatGPT",
      },
      { href: "/storage/records", label: "JSON records", secondary: true },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

function authenticationSelect(id: string, signedIn: boolean): string {
  return `<select id="${escapeHtml(id)}" name="auth_mode" required><option value="session"${signedIn ? " selected" : ""}>Current signed-in session${signedIn ? "" : " (sign-in required)"}</option><option value="token"${signedIn ? "" : " selected"}>AittaDB access token</option></select>`;
}

export function storageResultPage(options: {
  kind: "records" | "files";
  operation: string;
  payload: unknown;
}): string {
  const records = options.kind === "records";
  const title = records ? "Record operation result" : "File operation result";
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
        href: records ? "/storage/records" : "/storage/files",
        label: `Run another ${records ? "record" : "file"} operation`,
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
