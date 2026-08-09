import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import type { AittaDBApp } from "../../src/handler";
import { authUiJs } from "../../src/pages";
import { MemoryAuthStore } from "../../src/store/memory";
import { createTestAittaDB, form, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const VENDOR = "application/vnd.aittadb+json; version=0.1";
const BROWSER_ONLY_FIELDS = new Set(["ui", "csrf_token"]);

interface HypermediaField {
  name: string;
  location: "path" | "query" | "header" | "body";
  required?: boolean;
  secret?: boolean;
  value?: unknown;
  min_length?: number;
  max_length?: number;
  options?: Array<{ value: string; title: string }>;
  visible_when?: { field: string; value: string };
}

interface HypermediaAction {
  name: string;
  method: string;
  href: string;
  type?: string;
  authorization?: { scheme: string; scopes?: string[] };
  fields: HypermediaField[];
}

interface HypermediaDocument {
  api_version: string;
  type: string;
  data: { protocol_response: string };
  actions: HypermediaAction[];
}

interface HtmlControl {
  name: string;
  tag: "input" | "select" | "textarea";
  type: string;
  className: string;
  value?: string;
  required: boolean;
  requiredWhenVisible: boolean;
  condition?: string;
  minLength?: number;
  maxLength?: number;
  options: string[];
}

interface HtmlForm {
  method: string;
  action: string;
  encoding: string;
  conditional: boolean;
  controls: HtmlControl[];
}

test("OAuth entry resources keep HTML forms equivalent to hypermedia actions", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
  );
  const cases = [
    {
      path: "/authorize",
      type: "authorization-endpoint",
      action: "begin-authorization-code",
    },
    {
      path: "/oauth/device_authorization",
      type: "device-authorization-endpoint",
      action: "create-device-authorization",
    },
    {
      path: "/oauth/token",
      type: "token-endpoint",
      action: "exchange-oauth-grant",
    },
    {
      path: "/oauth/revoke",
      type: "revocation-endpoint",
      action: "revoke-token",
    },
  ] as const;

  for (const entry of cases) {
    const { html, document } = await entryRepresentations(app, entry.path);
    assert.equal(document.type, entry.type);
    assert.match(document.data.protocol_response, /standards-defined/);
    const action = requiredAction(document, entry.action);
    const htmlForm = requiredForm(html, entry.path);
    assertActionFormParity(action, htmlForm);
  }
});

test("token entry represents every grant and progressively requires only its active fields", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
  );
  const { html, document } = await entryRepresentations(app, "/oauth/token");
  const action = requiredAction(document, "exchange-oauth-grant");
  const htmlForm = requiredForm(html, "/oauth/token");
  const grantType = requiredControl(htmlForm, "grant_type");
  const grants = [
    "urn:ietf:params:oauth:grant-type:device_code",
    "authorization_code",
    "refresh_token",
    "client_credentials",
  ];

  assert.deepEqual(
    action.fields
      .find((field) => field.name === "grant_type")
      ?.options?.map((option) => option.value),
    grants,
  );
  assert.deepEqual(grantType.options, grants);

  const expectedConditions = new Map([
    ["device_code", "grant_type:urn:ietf:params:oauth:grant-type:device_code"],
    ["code", "grant_type:authorization_code"],
    ["redirect_uri", "grant_type:authorization_code"],
    ["code_verifier", "grant_type:authorization_code"],
    ["refresh_token", "grant_type:refresh_token"],
  ]);
  for (const [name, condition] of expectedConditions) {
    const control = requiredControl(htmlForm, name);
    const field = requiredField(action, name);
    assert.equal(control.condition, condition);
    assert.equal(control.required, false);
    assert.equal(control.requiredWhenVisible, true);
    assert.equal(field.required, true);
    assert.deepEqual(field.visible_when, splitCondition(condition));
  }

  const conditional = conditionalHarness(htmlForm);
  vm.runInNewContext(authUiJs(), {
    document: conditional.document,
    encodeURIComponent,
    window: { location: { assign() {} } },
  });

  const activeByGrant: Record<string, string[]> = {
    "urn:ietf:params:oauth:grant-type:device_code": ["device_code"],
    authorization_code: ["code", "redirect_uri", "code_verifier"],
    refresh_token: ["refresh_token"],
    client_credentials: ["scope"],
  };
  for (const grant of [...grants, "unsupported_grant"]) {
    conditional.grantType.value = grant;
    conditional.form.dispatch("change");
    for (const [name, control] of conditional.controls) {
      const active = activeByGrant[grant]?.includes(name) ?? false;
      const required = active && name !== "scope";
      assert.equal(
        isFieldRequiredForGrant(requiredField(action, name), grant),
        required,
        `${name} hypermedia requirement for ${grant}`,
      );
      assert.equal(control.disabled, !active, `${name} disabled for ${grant}`);
      assert.equal(control.required, required, `${name} required for ${grant}`);
      assert.equal(
        conditional.fields.get(name)?.hidden,
        !active,
        `${name} visibility for ${grant}`,
      );
    }
  }
  assert.equal(conditional.form.dataset.conditionalReady, "true");
});

test("introspection preserves Basic authentication while its HTML adapter uses body credentials", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
  );
  const { html, document } = await entryRepresentations(
    app,
    "/oauth/introspect",
  );
  const action = requiredAction(document, "introspect-token");
  const htmlForm = requiredForm(html, "/oauth/introspect");

  assert.equal(action.method, "POST");
  assert.equal(action.href, `${ISSUER}/oauth/introspect`);
  assert.equal(action.type, "application/x-www-form-urlencoded");
  assert.equal(action.authorization?.scheme, "basic");
  assert.deepEqual(
    action.fields.map((field) => field.name),
    ["token", "token_type_hint"],
  );
  assert.equal(htmlForm.method, "POST");
  assert.equal(new URL(htmlForm.action, ISSUER).pathname, "/oauth/introspect");

  for (const name of ["token", "token_type_hint"]) {
    assertSharedField(
      requiredField(action, name),
      requiredControl(htmlForm, name),
    );
  }
  const clientId = requiredControl(htmlForm, "client_id");
  const clientSecret = requiredControl(htmlForm, "client_secret");
  assert.equal(clientId.required, true);
  assert.equal(clientSecret.required, true);
  assert.equal(clientSecret.type, "password");
});

test("UserInfo advertises standard bearer GET and equivalent safe browser operations", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
  );
  const { html, document } = await entryRepresentations(app, "/userinfo");
  const htmlForm = requiredForm(html, "/userinfo");
  const bearer = requiredAction(document, "read-userinfo");
  const session = requiredAction(document, "read-userinfo-with-session");

  assert.equal(bearer.method, "GET");
  assert.equal(bearer.href, `${ISSUER}/userinfo`);
  assert.equal(bearer.authorization?.scheme, "bearer");
  assert.deepEqual(bearer.authorization?.scopes, ["openid"]);
  const authorization = requiredField(bearer, "Authorization");
  assert.equal(authorization.location, "header");
  assert.equal(authorization.required, true);
  assert.equal(authorization.secret, true);

  assert.equal(htmlForm.method, "POST");
  assert.equal(new URL(htmlForm.action, ISSUER).pathname, "/userinfo");
  const authMode = requiredControl(htmlForm, "auth_mode");
  assert.deepEqual(authMode.options, ["session", "token"]);
  assert.equal(authMode.value, "session");
  const accessToken = requiredControl(htmlForm, "access_token");
  assert.equal(accessToken.condition, "auth_mode:token");
  assert.equal(accessToken.requiredWhenVisible, true);

  assert.equal(session.method, "POST");
  assert.equal(session.href, `${ISSUER}/userinfo`);
  assert.equal(session.authorization?.scheme, "sites-session");
  assert.deepEqual(
    session.fields.map((field) => field.name),
    ["ui", "csrf_token", "auth_mode"],
  );
  assert.equal(requiredField(session, "auth_mode").value, "session");
  for (const name of ["ui", "csrf_token", "auth_mode"]) {
    assert.ok(requiredControl(htmlForm, name));
  }

  const anonymous = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
    null,
  );
  const anonymousRepresentations = await entryRepresentations(
    anonymous,
    "/userinfo",
  );
  const anonymousForm = requiredForm(
    anonymousRepresentations.html,
    "/userinfo",
  );
  assert.equal(requiredControl(anonymousForm, "auth_mode").value, "token");
  assert.ok(
    anonymousRepresentations.document.actions.some(
      (action) =>
        action.name === "begin-session" &&
        action.method === "GET" &&
        action.href === `${ISSUER}/session`,
    ),
  );
  assert.equal(
    anonymousRepresentations.document.actions.some(
      (action) => action.name === "read-userinfo-with-session",
    ),
    false,
  );
});

test("protocol errors retain OAuth and OIDC media types and top-level fields", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
    null,
  );
  const requests = [
    new Request(`${ISSUER}/authorize?client_id=unknown`, {
      headers: { accept: VENDOR },
    }),
    protocolPost("/oauth/device_authorization", { client_id: "unknown" }),
    protocolPost("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: "invalid",
      client_id: "unknown",
    }),
    protocolPost("/oauth/revoke", {
      token: "invalid",
      client_id: "unknown",
    }),
    protocolPost("/oauth/introspect", {
      token: "invalid",
      client_id: "unknown",
    }),
    new Request(`${ISSUER}/userinfo`, {
      headers: { accept: VENDOR, authorization: "Bearer invalid" },
    }),
  ];

  for (const request of requests) {
    const response = await requiredResponse(app, request);
    assert.ok(response.status >= 400, `${request.method} ${request.url}`);
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof payload.error, "string");
    assert.equal(payload.api_version, "0.1");
    assert.equal(payload.type, "error");
    assert.equal(
      (payload.data as Record<string, unknown>).error,
      payload.error,
      `${request.method} ${new URL(request.url).pathname}`,
    );
  }
});

test("token hypermedia marks every grant credential conditionally required", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
  );
  const { document } = await entryRepresentations(app, "/oauth/token");
  const action = requiredAction(document, "exchange-oauth-grant");
  for (const name of [
    "device_code",
    "code",
    "redirect_uri",
    "code_verifier",
    "refresh_token",
  ]) {
    const field = requiredField(action, name);
    assert.equal(field.required, true, name);
    assert.ok(field.visible_when, `${name} remains conditional`);
  }
});

test("PKCE HTML fields expose their exact hypermedia length constraints", async () => {
  const app = createTestAittaDB(
    await testEnv({ FEATURE_OAUTH_APPS_ENABLED: "true" }),
    new MemoryAuthStore(),
  );
  for (const [path, actionName, fieldName, minLength, maxLength] of [
    ["/authorize", "begin-authorization-code", "code_challenge", 43, 43],
    ["/oauth/token", "exchange-oauth-grant", "code_verifier", 43, 128],
  ] as const) {
    const { html, document } = await entryRepresentations(app, path);
    const field = requiredField(
      requiredAction(document, actionName),
      fieldName,
    );
    const control = requiredControl(requiredForm(html, path), fieldName);
    assert.equal(field.min_length, minLength);
    assert.equal(field.max_length, maxLength);
    assert.equal(control.minLength, minLength);
    assert.equal(control.maxLength, maxLength);
  }
});

async function entryRepresentations(
  app: AittaDBApp,
  path: string,
): Promise<{ html: string; document: HypermediaDocument }> {
  const [htmlResponse, hypermediaResponse] = await Promise.all([
    requiredResponse(
      app,
      new Request(`${ISSUER}${path}`, { headers: { accept: "text/html" } }),
    ),
    requiredResponse(
      app,
      new Request(`${ISSUER}${path}`, { headers: { accept: VENDOR } }),
    ),
  ]);
  assert.equal(htmlResponse.status, 200, `${path} HTML`);
  assert.match(htmlResponse.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(hypermediaResponse.status, 200, `${path} hypermedia`);
  assert.match(
    hypermediaResponse.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );
  assert.equal(hypermediaResponse.headers.get("aittadb-api-version"), "0.1");
  return {
    html: await htmlResponse.text(),
    document: (await hypermediaResponse.json()) as HypermediaDocument,
  };
}

async function requiredResponse(
  app: AittaDBApp,
  request: Request,
): Promise<Response> {
  const response = await app.fetch(request);
  assert.ok(response, `${request.method} ${request.url} returned a response`);
  return response;
}

function protocolPost(path: string, values: Record<string, string>): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    headers: {
      accept: VENDOR,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form(values),
  });
}

function requiredAction(
  document: HypermediaDocument,
  name: string,
): HypermediaAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `expected action ${name}`);
  return action;
}

function requiredField(
  action: HypermediaAction,
  name: string,
): HypermediaField {
  const field = action.fields.find((candidate) => candidate.name === name);
  assert.ok(field, `expected action field ${name}`);
  return field;
}

function requiredForm(html: string, path: string): HtmlForm {
  const form = parseForms(html).find(
    (candidate) => new URL(candidate.action, ISSUER).pathname === path,
  );
  assert.ok(form, `expected HTML form for ${path}`);
  return form;
}

function requiredControl(htmlForm: HtmlForm, name: string): HtmlControl {
  const control = htmlForm.controls.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(control, `expected HTML control ${name}`);
  return control;
}

function assertActionFormParity(
  action: HypermediaAction,
  htmlForm: HtmlForm,
): void {
  assert.equal(htmlForm.method, action.method);
  assert.equal(new URL(htmlForm.action, ISSUER).href, action.href);
  if (action.method === "POST") {
    assert.equal(htmlForm.encoding, action.type);
  }
  const actionNames = action.fields.map((field) => field.name).sort();
  const controlNames = htmlForm.controls
    .map((control) => control.name)
    .filter((name) => !BROWSER_ONLY_FIELDS.has(name))
    .sort();
  assert.deepEqual(controlNames, actionNames, `${action.name} field names`);
  for (const field of action.fields) {
    const control = requiredControl(htmlForm, field.name);
    assert.equal(
      field.location,
      action.method === "GET" ? "query" : "body",
      `${field.name} location`,
    );
    assertSharedField(field, control);
  }
}

function assertSharedField(field: HypermediaField, control: HtmlControl): void {
  if (field.required) {
    assert.equal(
      control.required ||
        control.requiredWhenVisible ||
        (control.type === "hidden" && control.value !== undefined),
      true,
      `${field.name} required`,
    );
  }
  if (field.value !== undefined) {
    assert.equal(control.value, String(field.value), `${field.name} value`);
  }
  if (field.options) {
    const representedOptions =
      control.options.length > 0
        ? control.options
        : control.type === "hidden" && control.value !== undefined
          ? [control.value]
          : [];
    assert.deepEqual(
      representedOptions,
      field.options.map((option) => option.value),
      `${field.name} options`,
    );
  }
  if (field.visible_when) {
    assert.deepEqual(
      splitCondition(control.condition ?? ""),
      field.visible_when,
      `${field.name} condition`,
    );
  }
  if (field.secret) {
    assert.equal(
      control.type === "password" ||
        control.className.includes("credential-input"),
      true,
      `${field.name} secret control`,
    );
  }
}

function splitCondition(condition: string): { field: string; value: string } {
  const separator = condition.indexOf(":");
  assert.ok(separator > 0, `valid condition ${condition}`);
  return {
    field: condition.slice(0, separator),
    value: condition.slice(separator + 1),
  };
}

function isFieldRequiredForGrant(
  field: HypermediaField,
  grantType: string,
): boolean {
  if (!field.required) return false;
  if (!field.visible_when) return true;
  return (
    field.visible_when.field === "grant_type" &&
    field.visible_when.value === grantType
  );
}

function parseForms(html: string): HtmlForm[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(
    (match) => {
      const attributes = parseAttributes(match[1] ?? "");
      const body = match[2] ?? "";
      const conditions = new Map<string, string>();
      for (const conditional of body.matchAll(
        /<div\b([^>]*\bdata-show-when="[^"]+"[^>]*)>([\s\S]*?)<\/div>/gi,
      )) {
        const conditionalAttributes = parseAttributes(conditional[1] ?? "");
        const condition = conditionalAttributes.get("data-show-when") ?? "";
        for (const control of parseControls(conditional[2] ?? "", new Map())) {
          conditions.set(control.name, condition);
        }
      }
      return {
        method: (attributes.get("method") ?? "GET").toUpperCase(),
        action: decodeHtml(attributes.get("action") ?? ""),
        encoding:
          attributes.get("enctype") ?? "application/x-www-form-urlencoded",
        conditional: attributes.has("data-conditional-form"),
        controls: parseControls(body, conditions),
      };
    },
  );
}

function parseControls(
  html: string,
  conditions: ReadonlyMap<string, string>,
): HtmlControl[] {
  const controls: Array<HtmlControl & { offset: number }> = [];
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1] ?? "");
    const name = attributes.get("name");
    if (!name) continue;
    controls.push({
      ...controlFromAttributes("input", name, attributes, conditions),
      value: attributes.has("value")
        ? decodeHtml(attributes.get("value") ?? "")
        : undefined,
      options: [],
      offset: match.index,
    });
  }
  for (const match of html.matchAll(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi,
  )) {
    const attributes = parseAttributes(match[1] ?? "");
    const name = attributes.get("name");
    if (!name) continue;
    controls.push({
      ...controlFromAttributes("textarea", name, attributes, conditions),
      value: decodeHtml(match[2] ?? ""),
      options: [],
      offset: match.index,
    });
  }
  for (const match of html.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/gi,
  )) {
    const attributes = parseAttributes(match[1] ?? "");
    const name = attributes.get("name");
    if (!name) continue;
    const optionElements = [
      ...(match[2] ?? "").matchAll(/<option\b([^>]*)>/gi),
    ].map((option) => parseAttributes(option[1] ?? ""));
    const selected =
      optionElements.find((option) => option.has("selected")) ??
      optionElements[0];
    controls.push({
      ...controlFromAttributes("select", name, attributes, conditions),
      value: selected?.get("value"),
      options: optionElements.map((option) => option.get("value") ?? ""),
      offset: match.index,
    });
  }
  controls.sort((left, right) => left.offset - right.offset);
  return controls;
}

function controlFromAttributes(
  tag: HtmlControl["tag"],
  name: string,
  attributes: ReadonlyMap<string, string>,
  conditions: ReadonlyMap<string, string>,
): Omit<HtmlControl, "value" | "options"> {
  return {
    name,
    tag,
    type: attributes.get("type") ?? (tag === "textarea" ? "textarea" : tag),
    className: attributes.get("class") ?? "",
    required: attributes.has("required"),
    requiredWhenVisible:
      attributes.get("data-required-when-visible") === "true",
    condition: conditions.get(name),
    minLength: optionalInteger(attributes.get("minlength")),
    maxLength: optionalInteger(attributes.get("maxlength")),
  };
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(
    /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*"([^"]*)")?/g,
  )) {
    attributes.set(match[1]!.toLowerCase(), decodeHtml(match[2] ?? ""));
  }
  return attributes;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

interface FakeControl {
  value: string;
  disabled: boolean;
  required: boolean;
  dataset: Record<string, string>;
}

class FakeConditionalField {
  readonly dataset: Record<string, string>;
  hidden = false;
  readonly attributes = new Map<string, string>();

  constructor(
    condition: string,
    private readonly control: FakeControl,
  ) {
    this.dataset = { showWhen: condition };
  }

  querySelectorAll(): readonly FakeControl[] {
    return [this.control];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeConditionalForm {
  readonly dataset: Record<string, string> = {};
  readonly elements: { namedItem: (name: string) => FakeControl | null };
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(
    grantType: FakeControl,
    private readonly fields: readonly FakeConditionalField[],
  ) {
    this.elements = {
      namedItem: (name) => (name === "grant_type" ? grantType : null),
    };
  }

  querySelectorAll(selector: string): readonly FakeConditionalField[] {
    return selector === "[data-show-when]" ? this.fields : [];
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

function conditionalHarness(htmlForm: HtmlForm): {
  document: { querySelectorAll(selector: string): readonly unknown[] };
  form: FakeConditionalForm;
  grantType: FakeControl;
  fields: Map<string, FakeConditionalField>;
  controls: Map<string, FakeControl>;
} {
  assert.equal(htmlForm.conditional, true);
  const controls = new Map<string, FakeControl>();
  const fields = new Map<string, FakeConditionalField>();
  const grantType: FakeControl = {
    value: requiredControl(htmlForm, "grant_type").value ?? "",
    disabled: false,
    required: true,
    dataset: {},
  };
  for (const htmlControl of htmlForm.controls.filter(
    (control) => control.condition,
  )) {
    const control: FakeControl = {
      value: htmlControl.value ?? "",
      disabled: false,
      required: false,
      dataset: {
        requiredWhenVisible: String(htmlControl.requiredWhenVisible),
      },
    };
    controls.set(htmlControl.name, control);
    fields.set(
      htmlControl.name,
      new FakeConditionalField(htmlControl.condition ?? "", control),
    );
  }
  const form = new FakeConditionalForm(grantType, [...fields.values()]);
  const document = {
    querySelectorAll(selector: string): readonly unknown[] {
      return selector === "form[data-conditional-form]" ? [form] : [];
    },
  };
  return { document, form, grantType, fields, controls };
}
