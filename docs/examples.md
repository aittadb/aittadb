# Examples

## Browser Interfaces

Open `/docs` for the self-hosted Swagger UI or follow the operation links from the public service root. Swagger "Try it out" sends requests to the origin serving the viewer, including on a custom domain. The direct HTML forms at `/authorize`, `/oauth/device_authorization`, `/oauth/token`, `/oauth/revoke`, `/oauth/introspect`, and `/userinfo` invoke the same production operations shown below. They do not create mock users, grants, tokens, or storage.

Credential-bearing browser forms send values in a same-origin request body and do not persist them in browser storage. UserInfo and storage forms can instead use the current signed-in session; AittaDB creates a minimal short-lived internal access token, calls the canonical endpoint, and never displays or persists that token. A successful browser token exchange deliberately displays newly issued credentials once in a `Cache-Control: no-store` response. Do not put access tokens, refresh tokens, device codes, authorization codes, client secrets, or PKCE verifiers in query strings.

## Service Client Credentials

An administrator first registers a `service` client with only the required AittaDB data scopes and saves the displayed secret once in the caller's server-side secret configuration. The server can then obtain a renewable short-lived token without a browser:

```sh
curl --user "$AITTADB_CLIENT_ID:$AITTADB_CLIENT_SECRET" \
  --request POST https://aittadb.com/oauth/token \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=storage.read storage.write'
```

The response contains `access_token`, `token_type`, `expires_in`, and `scope`; it contains no ID token, refresh token, email, or display name. Request another token before expiry. The token authorizes only the service client's stable isolated namespace, and must stay in server-side memory or secret handling rather than URLs, logs, or browser storage.

When `FEATURE_EVENTS_ENABLED=true`, public, confidential, service, and the private current-session client may use `events.publish`, `events.read`, and `events.subscribe`. These are AittaDB permissions only; they grant no access to ChatGPT or OpenAI data. For example, a service client intended to publish and later read its own namespace may request:

```sh
curl --user "$AITTADB_CLIENT_ID:$AITTADB_CLIENT_SECRET" \
  --request POST https://aittadb.com/oauth/token \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=events.publish events.read'
```

`events.publish` authorizes immutable append, while `events.read` authorizes bounded collection and item reads. `events.subscribe` remains reserved until bounded delivery is released. If Events is disabled, registration and every grant path reject its scopes and the entire route family fails closed; existing storage and OIDC scopes are unchanged.

## Event Publication

Register or use a client allowed to request `events.publish`, obtain its AittaDB access token, and append one immutable event:

```sh
curl -i --request POST "$ISSUER_URL/events" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/vnd.aittadb+json; version=0.1' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: example-order-ready-42' \
  --data '{"type":"orders.ready","data":{"order_id":"example-42","ready":true}}'
```

The first accepted append returns `201 Created`, an absolute event `Location`, and only the public UUID, type, data, creation time, and expiry. Repeating the exact type and data with the same key returns the original event with `200 OK` and `Idempotency-Replayed: true`; changing the content returns `409 idempotency_conflict`. The key is scoped to the verified subject/client namespace and only its hash is durable. Omit it when independent duplicate-looking events are intentional.

For a human check, sign in and open `/events`. The HTML collection includes a publication form backed by the same canonical append logic. It uses same-origin and CSRF protection and never displays or stores the short-lived internal AittaDB token. The operation accepts only a 1-128 character event type and a JSON object no larger than 64 KiB; clients must treat `413`, `429`, and `507` as bounded admission failures. Publication triggers no callback or fan-out.

## Event Reads

Read the first page and then follow the returned semantic `next` or `resume` link rather than constructing a cursor:

```sh
curl -s "$ISSUER_URL/events?page_size=50&type=example.created" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Accept: application/vnd.aittadb+json; version=0.1'
```

The optional `type` is one exact case-sensitive event type. The opaque cursor is short-lived and bound to the token's principal, client, and filter. Browsers can open the same `/events` URI with `Accept: text/html` and use the current ChatGPT-signed-in AittaDB session without handling its internal token.

Follow an event's `self` link, or read an already-known identifier from the same exact namespace:

```sh
curl -s "$ISSUER_URL/events/$EVENT_ID" \
  --header 'Accept: application/vnd.aittadb+json; version=0.1' \
  --header "Authorization: Bearer $ACCESS_TOKEN"
```

The response contains only the immutable public event fields plus self and collection links. A ChatGPT-signed-in user can open the same URL with `Accept: text/html`; AittaDB invokes the canonical read through its reserved current-session namespace without exposing the internal token. `events.subscribe` is reserved for bounded delivery and will also require `events.read` at the operation boundary.

The public root offers sign-in or sign-out according to the trusted ChatGPT Sites identity signal. Its compact product label is **Identity / Data / Files / Events**; publication and bounded collection/item reads are available only when Events is enabled, while long polling remains planned.

## Hypermedia Traversal

Request the versioned machine representation from the same URI used by the HTML application:

```sh
curl -s "$ISSUER_URL/" \
  -H 'accept: application/vnd.aittadb+json; version=0.1'
```

The response contains `data`, semantic `links`, and only the `actions` available in the current state. Follow their supplied `href` values instead of constructing route URLs. `Accept: text/html` returns the equivalent human interface; `Accept: application/json` selects the compatibility JSON representation. The selected contract is also reported in `AittaDB-API-Version`.

Read the public, privacy-preserving service count:

```sh
curl -s "$ISSUER_URL/statistics" -H 'accept: application/json'
```

This resource contains only the deployment's aggregate `identity_count`, never identity records or personal fields.

## Device Authorization CLI

```sh
curl -s -X POST "$ISSUER_URL/oauth/device_authorization" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "scope=openid email profile offline_access"
```

Print `user_code` and open `verification_uri`. Poll:

```sh
curl -s -X POST "$ISSUER_URL/oauth/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "device_code=$DEVICE_CODE"
```

The response contains the short user code and `verification_uri_complete` as required by the Device Grant. AittaDB persists only hashes of the device code and short user code. The verification browser supplies the matching user code back in a same-origin form so consent can display it without a durable plaintext copy.

## Browser or Native PKCE

Create a 43-128 character verifier, send its base64url-encoded SHA-256 digest as `code_challenge`, and request:

```text
GET /authorize?response_type=code&client_id=...&redirect_uri=...&scope=openid%20email&state=...&nonce=...&code_challenge=...&code_challenge_method=S256
```

Exchange the returned code:

```sh
curl -s -X POST "$ISSUER_URL/oauth/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$VERIFIER"
```

## Downstream JWT Verification

Fetch `$ISSUER_URL/.well-known/jwks.json`, select the configured `kid`, require `alg` `ES256`, and validate `iss`, `aud`, `exp`, `iat`, optional `nbf`, signature, and `jti` revocation policy.

## Local Key Generation

```sh
make generate-local-jwt-key
```

The private bundle is written under ignored `.secrets/signing-keys/` with a unique filename and mode `0600`; the command prints only its path and public key ID. It does not print or overwrite private material. See `docs/key-rotation.md` for validation, protected rollback preparation, and the boolean JWKS preflight.

To enable administration, sign in at `/session`, copy the deployment-local AittaDB UUID shown there, and add that canonical UUIDv4 to `ADMIN_SUBJECTS` through Sites configuration. The current trusted Sites session can then open `/admin/clients`; no separate administrator password or key is used. Keep the list narrow. UUID allowlisting does not eliminate reassignment risk because AittaDB still locates that UUID by upstream email.

Request `/admin/clients` with `Accept: text/html` for the human interface or `Accept: application/vnd.aittadb+json; version=0.1` for machine controls. Both expose create, the currently valid enable/disable transition, secret rotation for confidential/service clients, and grant revocation. Follow the returned action target and fields, including the one-time submission token, rather than constructing an operation. JSON returns a no-store mutation result directly. HTML returns `303 See Other`, then displays the result once on the redirected collection GET so refreshing does not repeat the POST. Save a returned secret immediately; it never enters the URL or durable plaintext storage and later collection reads never repeat it.

## AittaDB Storage

Register a client that is allowed to request `storage.read`, `storage.write`, and `storage.delete`. After the user approves those local scopes, use the returned access token with the storage API.

For a browser-operated check, sign in and open `/storage/records` or `/storage/files`. Current-session mode works immediately and stores data under the local user's reserved browser-client namespace. Access-token mode submits a token in a CSRF-protected same-origin body and operates on that token's separate OAuth-client namespace. Both call the same operations as the curl examples. Collection pages show a list or explicit empty state. The file collection includes an accessible upload form; drag and drop selects the native file input, and the user still submits explicitly. Item pages show readable details plus only the valid read/download, update, and delete operations. Explicit tokens are not kept between responses, so enter one again for each deliberate token-mode operation.

Open `/userinfo` to read the current signed-in session's local claims through the production UserInfo validator, or choose access-token mode to inspect a third-party application's granted claims. Device approval, Authorization Code consent, and allowlisted client administration also use the current signed-in identity, but sign-in never substitutes for registered client details, PKCE, client authentication, grants, or scopes.

Store a JSON record in D1:

```sh
curl -s -X PUT "$ISSUER_URL/storage/records/app/settings" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"theme":"midnight","compact":true}'
```

Read it back:

```sh
curl -s "$ISSUER_URL/storage/records/app/settings" \
  -H "authorization: Bearer $ACCESS_TOKEN"
```

List a bounded page and follow the server-provided `next` link. This example uses `jq` only to select that link; clients should not decode or construct cursors:

```sh
PAGE=$(curl -s "$ISSUER_URL/storage/records?page_size=25" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'accept: application/vnd.aittadb+json; version=0.1')

NEXT=$(printf '%s' "$PAGE" | jq -r \
  '.links[]? | select(.rel | index("next")) | .href' | head -n 1)

if [ -n "$NEXT" ]; then
  curl -s "$NEXT" \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    -H 'accept: application/vnd.aittadb+json; version=0.1'
fi
```

The collection's `usage` object combines record and file item/byte usage only for the access token's current local-user/client namespace. It does not expose the deployment-wide or per-user totals used internally for enforcement. The default page size is 50 and the initial maximum is 100; an invalid size or a cursor from another resource kind, user, or client returns `400 invalid_request`.

Create a file with a server-generated logical key:

```sh
curl -i -X POST "$ISSUER_URL/storage/files" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: text/plain' \
  --data-binary @hello.txt
```

The response is `201 Created`; its `Location` header is the exact item URI containing the generated key. Follow that URI for subsequent operations.

Create or update a file at an application-selected logical key:

```sh
curl -s -X PUT "$ISSUER_URL/storage/files/notes/hello.txt" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: text/plain' \
  --data-binary @hello.txt
```

The logical key in the URL is application metadata. AittaDB generates the physical R2 key and isolates every list, read, write, and delete by its immutable user UUID and OAuth client ID. Neither storage mode can enumerate AittaDB tables, other users or clients, physical R2 keys, bindings, configuration, or deployment secrets.

## Capacity and Rate Responses

Clients must treat these responses as state, not infer Sites provider capacity from them. The relevant error fields are duplicated at the top level and under `data`; the complete response also contains the standard AittaDB hypermedia envelope.

A rate counter returns `429` and a recovery interval:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json; charset=utf-8

{
  "error": "slow_down",
  "error_description": "Rate limit exceeded",
  "type": "error",
  "data": {
    "error": "slow_down",
    "error_description": "Rate limit exceeded"
  }
}
```

When the deployment kill switch is off, creates and replacements return `503`; authorized reads and deletes remain available:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json; charset=utf-8

{
  "error": "storage_writes_disabled",
  "error_description": "Storage writes are temporarily disabled by this AittaDB deployment"
}
```

When an AittaDB-configured item or byte ceiling is reached, the write returns `507`. Deleting items can make room again:

```http
HTTP/1.1 507 Insufficient Storage
Content-Type: application/json; charset=utf-8

{
  "error": "storage_limit_exceeded",
  "error_description": "A configured AittaDB storage limit has been reached"
}
```
