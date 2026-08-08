# Hypermedia JSON REST API

## Definition

A Hypermedia JSON REST API returns both resource state and the controls that are available from that state. A client starts from a stable entry URI, reads semantic links and actions, and follows the targets supplied by the server. It does not need to hard-code AittaDB's route tree or reconstruct workflow URLs.

Hypermedia does not make an API unpredictable. A published API version has a stable document structure, field meanings, resource types, link relations, action names, and error format. What can vary at runtime is which controls are present for a particular resource, authenticated principal, permission set, and workflow state.

## One Resource, Multiple Representations

An AittaDB URI identifies an application resource rather than an HTML page or a JSON endpoint. HTTP content negotiation selects its representation:

```http
GET /storage/records/preferences HTTP/1.1
Accept: application/vnd.aittadb+json; version=0.1
```

returns hypermedia JSON, while:

```http
GET /storage/records/preferences HTTP/1.1
Accept: text/html
```

returns the human interface for the same record and currently available operations.

`Accept` selects the response representation. `Content-Type` identifies a submitted request body's format, such as JSON, form data, or file bytes. AittaDB never selects HTML by inspecting `User-Agent` or guessing whether the caller is a browser.

The HTML and JSON do not need identical layout. They expose equivalent business state and capabilities:

| Application concept  | JSON                          | HTML                                       |
| -------------------- | ----------------------------- | ------------------------------------------ |
| Resource state       | `data`                        | Text, lists, tables, and values            |
| Relationship         | `links` entry                 | Link                                       |
| Available transition | `actions` entry               | Form, button, or task link                 |
| Accepted input       | Action fields and constraints | Labeled controls and validation attributes |

Both representations invoke the same authorization, validation, domain operation, and durable repository. HTML is not a mock client and JSON is not a reduced data feed.

## AittaDB Document Contract

AittaDB application resources use this shape during the `0.1` preview:

```json
{
  "api_version": "0.1",
  "type": "storage-record",
  "id": "preferences",
  "data": {
    "key": "preferences",
    "value": { "theme": "dark" },
    "updated_at": 1786118400
  },
  "links": [
    {
      "rel": ["self"],
      "href": "https://aittadb.com/storage/records/preferences"
    },
    {
      "rel": ["collection"],
      "href": "https://aittadb.com/storage/records"
    }
  ],
  "actions": [
    {
      "name": "replace-record",
      "title": "Replace record",
      "method": "PUT",
      "href": "https://aittadb.com/storage/records/preferences",
      "type": "application/json",
      "fields": [
        {
          "name": "value",
          "title": "JSON value",
          "type": "object",
          "location": "body",
          "required": true,
          "max_bytes": 65536,
          "value": { "theme": "dark" }
        }
      ]
    }
  ]
}
```

`data` is current resource state. `links` identify the resource and its relationships. Every link has one or more stable semantic `rel` values and a server-supplied `href`. `actions` describe currently available state transitions, including a stable semantic name, human title, HTTP method, request media type, target, and typed fields.

Fields may state where a value belongs (`path`, `query`, `header`, or `body`), whether it is required or sensitive, its current/default value, valid choices, conditional availability, and length, numeric, or byte constraints. When a field has both `required: true` and `visible_when`, it is required only while that condition matches; an inactive field is omitted or disabled and is not required. Templated action targets use RFC 6570-style `{field}` variables and declare the matching path fields. Clients substitute only variables advertised by the action; they do not infer other URL patterns.

Link relations and action names are API semantics. A generic hypermedia client needs to understand only this document format to display and invoke controls. A domain-aware client may attach richer behavior to stable names such as `open-record`, `replace-record`, or `delete-file`.

## State and Authorization

Controls describe what the current caller can do now. A read-only storage token receives read controls but no write or delete action. A non-admin session does not receive client-administration controls. An operation that no longer applies after a state transition disappears from the next representation.

Omission is not the only authorization control: the server always enforces identity, scopes, ownership, state, CSRF, origin, and input rules when a request arrives. Hypermedia prevents clients from being invited to perform unavailable work; it never replaces server-side authorization.

Storage representations expose only logical application data inside the authenticated local-user and OAuth-client namespace. They never expose AittaDB's internal tables, physical R2 keys, owner columns, bindings, environment values, signing material, credentials, or deployment secrets.

## Difference From a Hard-Coded JSON API

A conventional fixed JSON API can have a stable schema but still require callers to learn route construction and workflows elsewhere. Its payload might contain only values, leaving a client to know that a draft is submitted at another path or that a storage key must be appended to a collection URL.

A hypermedia API can be equally stable and versioned, but it carries navigation and transition controls at runtime. The client follows returned links, selects actions by semantic name, and submits the declared fields to the declared target. It does not assume which operation follows a state or whether that operation is available.

This is the machine-facing equivalent of browsing an HTML application. A person can follow links and fill forms without knowing its internal route map. A hypermedia client can traverse AittaDB in the same way.

## Stability and Versioning

The canonical media type is `application/vnd.aittadb+json`. Its required `version` parameter selects the contract. AittaDB also accepts `application/json` as a compatibility request and reports the selected contract in the `AittaDB-API-Version` response header and `api_version` document member.

Version `0.1` is an unreleased preview contract and may change while the initial design is completed. Publication of a stable `1.0` freezes its structures and semantics. Compatible additions may be made within a stable version, but breaking changes require a new version. A request that explicitly asks for an unsupported AittaDB media-type version receives `406 Not Acceptable` rather than silently receiving a different contract.

The set of controls may change between two responses without an API version change because resource state, authentication, or permissions changed. That is application behavior, not contract instability.

## Relationship With OpenAPI

OpenAPI and hypermedia are complementary.

OpenAPI statically describes every operation a version can support: paths, methods, schemas, authentication schemes, and possible responses. It is useful for reference, validation, and generated tooling.

Hypermedia describes the current resource and what this caller can do next. A particular response supplies the actual target and only the controls valid in that context. A client can use AittaDB from its entry resource without first loading OpenAPI.

Collection clients follow the concrete `next` link returned by the current representation rather than constructing cursor URLs. For an unchanged record or file collection, this produces bounded forward traversal in which every authorized logical item appears exactly once; HTML exposes the same transition as its next-page link. File collection controls expose logical metadata and item URLs, never physical object-store keys.

## Protocol Representations

OAuth 2.0 and OpenID Connect endpoints have standards-defined wire formats. Authorization responses, token responses, introspection, revocation, UserInfo, issuer discovery, and JWKS preserve those formats and media types. AittaDB does not wrap a token response in an application-resource envelope or add controls where that would break protocol interoperability.

The surrounding endpoint resources and browser forms remain discoverable through AittaDB hypermedia. Standards-permitted extension members may advertise transitions on Device Authorization or OAuth error responses, but required protocol members stay at their specified top level. OpenID discovery remains the authoritative machine-readable map for OAuth/OIDC protocol endpoints.
