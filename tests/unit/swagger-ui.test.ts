import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

interface SwaggerRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  credentials?: string;
}

interface SwaggerOptions extends Record<string, unknown> {
  requestInterceptor?: (request: SwaggerRequest) => SwaggerRequest;
}

interface ImmutableValue<T> {
  toJS(): T;
}

interface SwaggerSystem {
  oas3Actions: {
    setResponseContentType(selection: {
      value: string;
      path: string;
      method: string;
    }): void;
  };
  specActions: {
    executeRequest(request: Record<string, unknown>): Promise<unknown>;
  };
  specSelectors: {
    operationWithMeta(path: string, method: string): ImmutableValue<unknown>;
    responseFor(
      path: string,
      method: string,
    ): ImmutableValue<Record<string, unknown>> | null;
  };
}

interface SwaggerUiInstance {
  getSystem(): SwaggerSystem;
}

type SwaggerUiFactory = (options: SwaggerOptions) => SwaggerUiInstance;

test("Swagger Try it out uses the current deployment origin and JSON", async () => {
  const source = await readFile(
    new URL("../../public/swagger-ui/aittadb-swagger.js", import.meta.url),
    "utf8",
  );
  let ready: (() => void) | undefined;
  let options: SwaggerOptions | undefined;
  const window = {
    location: { origin: "https://preview.example.test" },
    addEventListener(name: string, listener: () => void): void {
      if (name === "DOMContentLoaded") ready = listener;
    },
    SwaggerUIBundle(value: SwaggerOptions): void {
      options = value;
    },
  };

  vm.runInNewContext(source, { URL, window });
  assert.ok(ready);
  ready();
  assert.ok(options);
  assert.equal(options.url, "/openapi.json?format=json");
  assert.equal(options.persistAuthorization, false);
  assert.equal(options.tryItOutEnabled, true);

  const intercept = options.requestInterceptor;
  assert.ok(intercept);
  const request = intercept({
    url: "https://aittadb.com/statistics",
    method: "GET",
    headers: {},
  });
  assert.equal(request.url, "https://preview.example.test/statistics");
  assert.equal(request.headers?.Accept, "application/json");
  assert.equal(request.credentials, "same-origin");

  const explicit = intercept({
    url: "https://aittadb.com/storage/files/demo.txt",
    method: "GET",
    headers: { Accept: "application/octet-stream" },
  });
  assert.equal(explicit.headers?.Accept, "application/octet-stream");
});

test("pinned Swagger executes and accepts a same-origin JSON GET response", async () => {
  const source = await readFile(
    new URL("../../public/swagger-ui/aittadb-swagger.js", import.meta.url),
    "utf8",
  );
  const payload = {
    api_version: "0.1",
    type: "service-statistics",
    data: { identity_count: 3 },
    links: [],
    actions: [],
  };
  const specification = {
    openapi: "3.1.0",
    info: { title: "AittaDB acceptance fixture", version: "0.1.0" },
    servers: [{ url: "https://aittadb.com" }],
    paths: {
      "/statistics": {
        get: {
          operationId: "getStatistics",
          responses: {
            "200": {
              description: "Aggregate statistics",
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          },
        },
      },
    },
  };
  const location = new URL("https://preview.example.test/docs");
  let ready: (() => void) | undefined;
  let ui: SwaggerUiInstance | undefined;
  let fetchedUrl = "";
  let fetchedInit: RequestInit | undefined;
  const require = createRequire(import.meta.url);
  const { SwaggerUIBundle } = require("swagger-ui-dist") as {
    SwaggerUIBundle: SwaggerUiFactory;
  };
  const browserWindow = {
    location,
    history: { replaceState(): void {} },
    localStorage: {
      getItem(): null {
        return null;
      },
      setItem(): void {},
      removeItem(): void {},
    },
    File,
    Blob,
    FormData,
    URL,
    URLSearchParams,
    addEventListener(name: string, listener: () => void): void {
      if (name === "DOMContentLoaded") ready = listener;
    },
    removeEventListener(): void {},
    SwaggerUIBundle(options: SwaggerOptions): void {
      ui = SwaggerUIBundle({
        ...options,
        url: undefined,
        spec: specification,
        dom_id: null,
        domNode: null,
      });
    },
  };
  const document = {
    baseURI: location.href,
    cookie: "",
    location,
    querySelector(): null {
      return null;
    },
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    fetchedUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    fetchedInit = init;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/vnd.aittadb+json; version=0.1",
      },
    });
  };
  const restore = installGlobals({
    document,
    fetch: fakeFetch,
    File,
    location,
    window: browserWindow,
  });

  try {
    vm.runInNewContext(source, { URL, window: browserWindow });
    assert.ok(ready);
    ready();
    assert.ok(ui);
    const system = ui.getSystem();
    const operation = system.specSelectors.operationWithMeta(
      "/statistics",
      "get",
    );
    assert.ok(operation);
    system.oas3Actions.setResponseContentType({
      value: "application/json",
      path: "/statistics",
      method: "get",
    });

    await system.specActions.executeRequest({
      spec: specification,
      pathName: "/statistics",
      method: "get",
      operation,
    });

    assert.equal(fetchedUrl, "https://preview.example.test/statistics");
    assert.equal(fetchedInit?.credentials, "same-origin");
    assert.equal(
      new Headers(fetchedInit?.headers).get("accept"),
      "application/json",
    );
    const response = system.specSelectors
      .responseFor("/statistics", "get")
      ?.toJS();
    assert.equal(response?.status, 200);
    assert.deepEqual(response?.body, payload);
    assert.equal(
      (response?.headers as Record<string, string> | undefined)?.[
        "content-type"
      ],
      "application/vnd.aittadb+json; version=0.1",
    );
    // Swagger resolves OpenAPI subtrees on a deferred pass after execution.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  } finally {
    restore();
  }
});

function installGlobals(values: Record<string, unknown>): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}
