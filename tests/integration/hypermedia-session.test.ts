import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAuthStore } from "../../src/store/memory";
import {
  cookieValue,
  createTestAittaDB,
  form,
  MemoryR2Bucket,
  testEnv,
} from "../helpers";

interface ActionField {
  name: string;
  location: string;
  value?: unknown;
}

interface Action {
  name: string;
  method: string;
  href: string;
  type?: string;
  authorization?: { scheme: string };
  fields: ActionField[];
}

interface Document<T = Record<string, unknown>> {
  data: T;
  actions: Action[];
}

const VENDOR = "application/vnd.aittadb+json; version=0.1";

test("application routes reject unacceptable representations without changing OAuth wire errors", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store, null);

  for (const accept of [
    "image/png",
    "application/json;q=0, text/html;q=0",
    "application/vnd.aittadb+json; version=9",
  ]) {
    const response = await app.fetch(
      new Request("https://aittadb.example.test/", { headers: { accept } }),
    );
    assert.equal(response?.status, 406);
    assert.equal(
      response?.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(
      ((await response!.json()) as { error: string }).error,
      "not_acceptable",
    );
  }

  const session = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: VENDOR },
    }),
  );
  assert.equal(session?.status, 401);
  assert.match(session?.headers.get("content-type") ?? "", /vnd\.aittadb/);
  assert.match(session?.headers.get("vary") ?? "", /Accept/i);

  const protocol = await app.fetch(
    new Request("https://aittadb.example.test/oauth/token", {
      method: "POST",
      headers: {
        accept: "application/vnd.aittadb+json; version=9",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ grant_type: "refresh_token", client_id: "unknown" }),
    }),
  );
  assert.equal(protocol?.status, 401);
  assert.equal(
    protocol?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(
    ((await protocol!.json()) as { error: string }).error,
    "invalid_client",
  );
});

test("signed-in hypermedia storage actions execute through their advertised controls", async () => {
  const env = await testEnv({ BUCKET: new MemoryR2Bucket() });
  const app = createTestAittaDB(env, new MemoryAuthStore());

  const records = await app.fetch(
    new Request("https://aittadb.example.test/storage/records", {
      headers: { accept: VENDOR },
    }),
  );
  assert.equal(records?.status, 200);
  const recordCsrf = cookieValue(records!, "aittadb_csrf");
  const recordsDocument = (await records!.json()) as Document<{
    items: unknown[];
  }>;
  const createRecord = requiredAction(
    recordsDocument,
    "create-or-replace-record",
  );
  assert.equal(createRecord.method, "POST");
  assert.equal(createRecord.type, "application/x-www-form-urlencoded");
  assert.equal(createRecord.authorization?.scheme, "sites-session");
  assert.equal(fieldValue(createRecord, "csrf_token"), recordCsrf);
  assert.equal(fieldValue(createRecord, "_method"), "PUT");
  assert.equal(fieldValue(createRecord, "auth_mode"), "session");

  const recordTarget = createRecord.href.replace("{key}", "preferences");
  const recordWrite = await app.fetch(
    new Request(recordTarget, {
      method: createRecord.method,
      headers: {
        accept: VENDOR,
        "content-type": createRecord.type,
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: actionForm(createRecord, {
        value: JSON.stringify({ density: "compact" }),
      }),
    }),
  );
  assert.equal(recordWrite?.status, 200);
  assert.match(recordWrite?.headers.get("content-type") ?? "", /vnd\.aittadb/);
  const recordDocument = (await recordWrite!.json()) as Document<{
    key: string;
    value: { density: string };
  }>;
  assert.equal(recordDocument.data.key, "preferences");
  assert.equal(recordDocument.data.value.density, "compact");

  const deleteRecord = requiredAction(recordDocument, "delete-record");
  assert.equal(deleteRecord.method, "POST");
  assert.equal(fieldValue(deleteRecord, "_method"), "DELETE");
  const recordDelete = await app.fetch(
    new Request(deleteRecord.href, {
      method: deleteRecord.method,
      headers: {
        accept: VENDOR,
        "content-type": deleteRecord.type!,
        cookie: `aittadb_csrf=${recordCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: actionForm(deleteRecord),
    }),
  );
  assert.equal(recordDelete?.status, 200);
  const deletionDocument = (await recordDelete!.json()) as Document<{
    deleted: boolean;
  }>;
  assert.equal(deletionDocument.data.deleted, true);
  const recreate = requiredAction(deletionDocument, "create-record");
  assert.equal(recreate.method, "POST");
  assert.equal(fieldValue(recreate, "csrf_token"), recordCsrf);

  const files = await app.fetch(
    new Request("https://aittadb.example.test/storage/files", {
      headers: { accept: VENDOR },
    }),
  );
  const fileCsrf = cookieValue(files!, "aittadb_csrf");
  const filesDocument = (await files!.json()) as Document;
  const createFile = requiredAction(filesDocument, "create-file");
  assert.equal(createFile.method, "POST");
  assert.equal(createFile.type, "multipart/form-data");
  const upload = new FormData();
  appendActionValues(upload, createFile);
  upload.set(
    "file",
    new File(["hypermedia file"], "note.txt", { type: "text/plain" }),
  );
  const fileCreate = await app.fetch(
    new Request(createFile.href, {
      method: createFile.method,
      headers: {
        accept: VENDOR,
        cookie: `aittadb_csrf=${fileCsrf}`,
        origin: "https://aittadb.example.test",
      },
      body: upload,
    }),
  );
  assert.equal(fileCreate?.status, 201);
  const fileDocument = (await fileCreate!.json()) as Document<{ key: string }>;
  assert.equal(
    fileCreate?.headers.get("location"),
    `https://aittadb.example.test/storage/files/${fileDocument.data.key}`,
  );
  const replaceFile = requiredAction(fileDocument, "replace-file");
  assert.equal(replaceFile.method, "POST");
  assert.equal(replaceFile.type, "multipart/form-data");
});

test("signed-in UserInfo hypermedia action returns standard UserInfo JSON", async () => {
  const env = await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" });
  const app = createTestAittaDB(env, new MemoryAuthStore());
  const session = await app.fetch(
    new Request("https://aittadb.example.test/session", {
      headers: { accept: VENDOR },
    }),
  );
  const sessionCsrf = cookieValue(session!, "aittadb_csrf");
  const sessionDocument = (await session!.json()) as Document;
  const sessionUserInfo = requiredAction(
    sessionDocument,
    "read-userinfo-with-session",
  );
  assert.equal(sessionUserInfo.method, "POST");
  assert.equal(fieldValue(sessionUserInfo, "csrf_token"), sessionCsrf);

  const descriptor = await app.fetch(
    new Request("https://aittadb.example.test/userinfo", {
      headers: { accept: VENDOR },
    }),
  );
  assert.equal(descriptor?.status, 200);
  const csrf = cookieValue(descriptor!, "aittadb_csrf");
  const document = (await descriptor!.json()) as Document;
  const sessionAction = requiredAction(document, "read-userinfo-with-session");
  assert.equal(sessionAction.method, "POST");
  assert.equal(sessionAction.authorization?.scheme, "sites-session");
  assert.equal(fieldValue(sessionAction, "csrf_token"), csrf);

  const response = await app.fetch(
    new Request(sessionAction.href, {
      method: sessionAction.method,
      headers: {
        accept: "application/json",
        "content-type": sessionAction.type!,
        cookie: `aittadb_csrf=${csrf}`,
        origin: "https://aittadb.example.test",
      },
      body: actionForm(sessionAction),
    }),
  );
  assert.equal(response?.status, 200);
  assert.equal(
    response?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const claims = (await response!.json()) as { sub: string; email: string };
  assert.match(claims.sub, /^[0-9a-f-]{36}$/);
  assert.equal(claims.email, "user@example.test");
});

function requiredAction(document: Document, name: string): Action {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `expected action ${name}`);
  return action;
}

function fieldValue(action: Action, name: string): unknown {
  return action.fields.find((candidate) => candidate.name === name)?.value;
}

function actionForm(
  action: Action,
  overrides: Record<string, string> = {},
): string {
  const values: Record<string, string> = {};
  for (const field of action.fields) {
    if (field.location === "body" && field.value !== undefined) {
      values[field.name] = String(field.value);
    }
  }
  return form({ ...values, ...overrides });
}

function appendActionValues(target: FormData, action: Action): void {
  for (const field of action.fields) {
    if (field.location === "body" && field.value !== undefined) {
      target.set(field.name, String(field.value));
    }
  }
}
