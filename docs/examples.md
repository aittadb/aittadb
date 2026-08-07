# Examples

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

## Browser or Native PKCE

Create a verifier, send `sha256(verifier)` as `code_challenge`, and request:

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

## AittaDB Storage

Register a client that is allowed to request `storage.read`, `storage.write`, and `storage.delete`. After the user approves those local scopes, use the returned access token with the storage API.

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

Store file bytes in R2 with metadata in D1:

```sh
curl -s -X PUT "$ISSUER_URL/storage/files/notes/hello.txt" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: text/plain' \
  --data-binary @hello.txt
```

The logical key in the URL is application metadata. AittaDB generates the physical R2 key and isolates data by its immutable user UUID and OAuth client ID.
