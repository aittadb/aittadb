# Examples

## Browser Interfaces

Open `/docs` for the self-hosted Swagger UI or follow the operation links from the public service root. Swagger "Try it out" sends requests to the origin serving the viewer, including on a custom domain. The direct HTML forms at `/authorize`, `/oauth/device_authorization`, `/oauth/token`, `/oauth/revoke`, `/oauth/introspect`, and `/userinfo` invoke the same production operations shown below. They do not create mock users, grants, tokens, or storage.

Credential-bearing browser forms send values in a same-origin request body and do not persist them in browser storage. UserInfo and storage forms can instead use the current signed-in session; AittaDB creates a minimal short-lived internal access token, calls the canonical endpoint, and never displays or persists that token. A successful browser token exchange deliberately displays newly issued credentials once in a `Cache-Control: no-store` response. Do not put access tokens, refresh tokens, device codes, authorization codes, client secrets, or PKCE verifiers in query strings.

The public root offers sign-in or sign-out according to the trusted ChatGPT Sites identity signal. Its compact product label is **Identity / Data / Files / Events**; Events is planned and is not an available API in the MVP.

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

The private JWK is written to `.secrets/jwt-signing-key.json`; that directory is ignored by Git.

To enable administration, sign in at `/session`, copy the deployment-local AittaDB UUID shown there, and add that canonical UUIDv4 to `ADMIN_SUBJECTS` through Sites configuration. The current trusted Sites session can then open `/admin/clients`; no separate administrator password or key is used. Keep the list narrow. UUID allowlisting does not eliminate reassignment risk because AittaDB still locates that UUID by upstream email.

Request `/admin/clients` with `Accept: text/html` for the human interface or `Accept: application/vnd.aittadb+json; version=0.1` for machine controls. Both expose create, the currently valid enable/disable transition, confidential-only secret rotation, and grant revocation. Follow the returned action target and fields, including the one-time submission token, rather than constructing an operation. JSON returns a no-store mutation result directly. HTML returns `303 See Other`, then displays the result once on the redirected collection GET so refreshing does not repeat the POST. Save a returned confidential secret immediately; it never enters the URL or durable plaintext storage and later collection reads never repeat it.

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
