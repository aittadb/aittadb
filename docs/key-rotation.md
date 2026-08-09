# Signing-Key Generation and Rotation

AittaDB uses one configured ES256 P-256 signing key and publishes only that key's public JWK. The local commands in this document are Node-only operator tools. They are not Worker routes, do not read hosted secrets, and never print a private JWK. Generated files live under the Git-ignored `.secrets/signing-keys/` directory, use unique names, are created with exclusive no-clobber writes, and have mode `0600`; the directory has mode `0700`.

The protected file is a deployment bundle containing `JWT_KEY_ID`, the serialized `JWT_PRIVATE_JWK`, and its public JWK. Treat the whole file as a secret even though two of those values are public. Do not use `cat`, shell tracing, command substitution, CI artifacts, chat, issue text, or logs to move its values. Use only an approved hosted-secret/configuration interface or operator tool that does not disclose the private value.

## Local Commands

Generate a new candidate for initial setup:

```sh
npm run --silent keys:generate
# Optional public identifier: npm run --silent keys:generate -- --kid example-key-id
```

The command prints only the candidate path and public key ID. It cannot select a fixed output file and never writes the bundle to stdout. `make generate-local-jwt-key` invokes the same operation.

Validate a protected file against the key ID intended for configuration:

```sh
npm run --silent keys:validate -- \
  --key-file .secrets/signing-keys/<candidate-file> \
  --kid <configured-key-id>
```

The only result is `valid` or `invalid`. Validation requires the private and public P-256 members, exact `ES256` signing/verification operations, internal and configured key-ID agreement, matching public coordinates, an in-memory sign/verify round trip, and exact file mode `0600`. Missing, malformed, oversized, symbolic-link, or differently permissioned files fail closed.

Prepare a rotation from a protected local copy of the currently deployed key:

```sh
npm run --silent keys:prepare-rotation -- \
  --current-file .secrets/signing-keys/<current-file> \
  --current-kid <current-key-id>
# Optional: --candidate-kid <new-key-id>
```

This validates the current bundle first, then creates one unique rollback copy and one unique candidate. It never modifies the current file. If candidate creation fails, the just-created rollback copy is removed; pre-existing files are never changed.

Compare a protected local bundle with the public key currently served by an issuer:

```sh
npm run --silent keys:preflight -- \
  --current-file .secrets/signing-keys/<current-or-candidate-file> \
  --kid <configured-key-id> \
  --jwks-url https://aittadb.example/.well-known/jwks.json
```

The only result is `match` or `non-match`. The command validates the local bundle, performs a bounded unauthenticated HTTPS GET of the exact JWKS path, and compares only public members for exactly one matching `kid`. It follows no redirects, accepts no URL credentials/query/fragment, and never sends or returns local key material. A network, status, media-type, size, JSON, duplicate-key, permission, key-ID, or key mismatch returns `non-match`.

## Single-Key Cutover

AittaDB has no overlapping verification-key set. A key change is an abrupt security boundary, not a gradual rollover.

1. Obtain explicit deployment and secret-rotation approval. Confirm the source revision and configuration revision to preserve.
2. Keep a protected local bundle for the current key. Run `keys:validate`, then require `keys:preflight` to report `match`. Stop if it does not; a guessed or newly generated key is not rollback material.
3. Privately inspect operational state. Do not rotate while account-deletion jobs need their existing status handles or while a one-time administrator result still needs to be claimed.
4. Run `keys:prepare-rotation`. Record the printed paths and public candidate key ID without opening either private bundle in a terminal.
5. Configure the candidate's `JWT_PRIVATE_JWK` and matching `JWT_KEY_ID` together through the approved hosted secret/configuration interface. Publish only the exact approved committed source and preserve all D1/R2 bindings and unrelated secrets.
6. After the approved deployment, run `keys:preflight` with the candidate. Also verify discovery/JWKS availability and a newly issued token through the normal acceptance procedure. A `non-match` is a failed cutover.
7. Retain both protected files only for the approved rollback window. Keep them outside backups, synchronization, Git, and artifacts unless those systems are explicitly approved for signing-key custody.

## Effects and Rollback

Changing either the private key or `JWT_KEY_ID` has these immediate consequences:

| State                                         | Cutover effect                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access, ID, and internal browser-session JWTs | Old JWTs fail AittaDB verification and disappear from the single-key JWKS verification set. New JWTs use the candidate. Rolling back invalidates JWTs minted during the candidate window.                                                                                                                                                   |
| Opaque refresh tokens                         | Durable hashes and token families remain valid unless expired, used, or revoked. A successful post-cutover refresh receives JWTs signed by the currently configured key. Rotation is not refresh-token revocation.                                                                                                                          |
| Authorization codes and device grants         | Opaque durable credentials retain their ordinary expiry/one-time rules and exchange into JWTs under the currently configured key.                                                                                                                                                                                                           |
| Storage cursors                               | Existing record and file cursors become invalid. Restart pagination from the collection URI. Rolling back may make an old cursor cryptographically readable again, so callers must still treat pre-cutover cursors as retired.                                                                                                              |
| Account deletion                              | Open confirmation values and seven-day status handles become invalid. A durable deletion job is not reversed, but an invalid status handle cannot read or nudge it. Finish or deliberately recover such work before cutover. Rolling back to the exact old key and ID restores cryptographic compatibility for otherwise unexpired handles. |
| Administrator results                         | Unclaimed encrypted one-time result cookies become unreadable; the completed mutation is not undone, and a generated secret may be unrecoverable. Claim or expire results first. A rollback restores only otherwise-valid old-key results.                                                                                                  |
| Rate counters                                 | Per-IP counter keys change because their hash input is key-derived, temporarily starting a new per-IP namespace; global counters do not. Old rows remain under bounded five-minute cleanup. Rolling back can reactivate an unexpired old namespace.                                                                                         |
| D1/R2 application data                        | User records, clients, grants, refresh families, JSON records, file metadata, and file bytes are not re-encrypted or migrated by signing-key rotation.                                                                                                                                                                                      |

If acceptance fails, configure **both** `JWT_PRIVATE_JWK` and `JWT_KEY_ID` from the generated rollback bundle and redeploy the same source/configuration baseline. Run `keys:preflight` against the rollback file and require `match`. Then verify a newly issued token and the affected browser operations. Do not mix the candidate scalar with the rollback key ID, or vice versa. Rollback is another abrupt single-key cutover and therefore invalidates candidate-window JWTs, cursors, handles, administrator results, and per-IP rate-counter continuity as described above.
