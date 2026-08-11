# AittaDB Baseline Privacy Policy

This is the baseline notice for the public `GET /privacy` resource. Each deployment operator must review and adapt it to the deployment's actual purposes, clients, users, jurisdiction, and legal obligations before publication. It is not legal advice. The HTML and versioned hypermedia JSON representations describe the same policy.

## Controller and Contact

The operator of the AittaDB deployment is the data controller for personal data collected by that published deployment ("Hosted Data"). The rendered policy identifies the controller and privacy contact from public `PRIVACY_CONTROLLER_*` and `PRIVACY_CONTACT_*` configuration. Blank optional fields are omitted.

If required controller/contact data is not explicitly configured, the deployment may use only the last stored email and optional display name of the first resolvable canonical local UUID in `ADMIN_SUBJECTS`. That fallback does not prove the address remains current or verified. It never publishes the UUID, administrator list, other user fields, or configuration secrets. If no usable controller and contact can be resolved, `/privacy` returns a generic `503`.

## Scope and Data Subjects

This notice covers people who sign in to or use this AittaDB deployment and people whose personal data they lawfully store through it. A client application using AittaDB may have its own controller responsibilities and privacy notice.

## Data Processed

AittaDB may process:

- the email address and optional display name supplied server-side by ChatGPT Sites, plus an immutable local AittaDB UUID and account timestamps;
- OAuth/OIDC client, scope, consent, grant, token-family, token-revocation, and protocol transaction data; bearer-equivalent opaque credentials and client secrets are stored only as hashes;
- JSON records, file metadata, and file content submitted to the authenticated user's client-isolated D1/R2 namespace;
- minimal redacted audit, rate-limit, request, security, and operational metadata needed to protect and operate the service.

AittaDB does not receive or forward ChatGPT credentials, cookies, tokens, sessions, conversations, Projects, Library files, connectors, subscriptions, billing, workspace roles, or API quota.

## Purposes and Legal Basis

The deployment processes data to provide requested identity, session, storage, and security functions; administer registered clients; prevent abuse; diagnose failures; comply with legal obligations; and establish, exercise, or defend legal claims. Depending on the operator's relationship and jurisdiction, processing may rely on performance of a contract, legitimate interests in operating and securing the service, consent for an optional operation, or a legal obligation. The operator must confirm and document the bases that actually apply.

Data comes directly from users and authorized client applications, from the trusted ChatGPT Sites sign-in signal, and from operation of the service. The core service does not use personal data for direct marketing, advertising, automated decision-making, or profiling.

## Sharing and Hosting

An OAuth client receives only claims and access that the user approves within that client's allowed AittaDB scopes. Stored records and files remain isolated by local user and client. The operator may access data only as necessary to operate, secure, support, or comply with law, subject to its own procedures.

OpenAI hosts ChatGPT Sites and processes personal data collected by a published Site as Hosted Data under the applicable [ChatGPT Sites Data Processing Addendum](https://openai.com/policies/chatgpt-sites-data-processing-addendum/) or the operator's organization agreement. OpenAI may use listed sub-processors under those terms. The core does not sell personal data or disclose it for third-party marketing.

No fixed data-residency promise is made. [OpenAI's Sites documentation](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites) currently states that data residency is not supported at launch for deployed Sites, Site code, D1/R2 data and file storage, artifacts, and logs. Processing or transfers are governed by the terms and safeguards applicable to the operator's Sites account.

## Retention and Deletion

Users can delete individual records and files when their current session or approved client has the required permission. An eligible signed-in user can also submit the protected account-deletion request exposed by `/session` for that current local AittaDB account. The operation requires same-origin and CSRF checks, an explicit confirmation phrase, and a short-lived encrypted confirmation bound to the exact current local subject and trusted Sites email; administrators cannot start it. A first accepted request durably starts bounded deletion of that subject's attributed OAuth state, administrator submissions, JSON records, application events, file metadata, R2 objects, and local user row. Every job state immediately blocks new AittaDB sessions and credentials, refresh successors, existing access-token use, storage access, and application-event writes for that subject. Acceptance sets a separate encrypted seven-day status cookie bound to the exact trusted email and former local subject. While that binding remains valid, `GET /account/deletion` reports only pending, running, retry, or completed and one currently valid refresh, recovery, or Sites sign-out control. It never reports an email, UUID, attempt, timestamp, count, client, namespace, credential, or storage identifier. There is no deployment-wide deletion operation; users may contact the published privacy contact about legal rights or unresolved requests.

Records, files, and application events remain until their applicable authorized deletion, retention, account-deletion, or deployment-lifecycle process removes them, subject to provider lifecycle, backups, legal duties, and technical recovery periods. OAuth access-token, authorization-code, device-code, and refresh-token lifetimes are configurable; expired protocol state becomes eligible for bounded cleanup. One-time administrator submission hashes become cleanup-eligible after 15 minutes, audit events after 90 days, and one-minute rate counters after five minutes. During account deletion, owned administrator submissions and application events are removed explicitly. Audit events remain under ordinary retention, but their structured subject-derived actor attribution is cleared in deterministic batches before the local user is removed; unrelated audit data and attributions remain. Storage rate keys are SHA-256 owner hashes and remain only until the five-minute cleanup threshold. Neither audit events nor rate state is enriched with deletion details.

The completed deletion-job row is a permanent pseudonymous security/idempotency exception. It retains the former local UUID, coarse state, attempt, and timestamps so old credentials stay invalid and repeat deletion remains terminal. It has no email, display name, content, client identifier, credential, logical or physical storage key, subject-derived content hash, or repair detail, and it has no direct public representation; the status resource maps only its coarse state. This UUID remains linkable and is not anonymous. After completion, a later identity-resolving request using the same email creates one new UUID and empty record, file, and event namespaces; repeat requests retain that new UUID, while the old status handle remains bound only to the tombstone. AittaDB endpoints reject old access tokens immediately, old refresh tokens cannot rotate, and neither can reconnect the new identity. Previously issued access and ID JWTs remain self-contained and can still verify for the former subject until their signed expiration when an external resource server performs signature-only validation. Because Sites supplies only email, AittaDB cannot determine whether a later holder is the same person; email reassignment remains an upstream-identity limitation. Revocation rows created before subject attribution cannot be safely assigned to an account, so deletion retains them until ordinary expiry cleanup. Cleanup is bounded, scheduled outside responses, and depends on traffic and platform execution, so eligibility is not a guarantee of immediate physical deletion.

Event deletion accepts only an exact actively claimed human-account job and removes immutable events across that subject's client namespaces in finite batches; service principals and other subjects remain untouched. File deletion uses the same claimed-subject boundary, removes metadata in finite batches, and routes object deletion through private persistent repair state. In-flight uploads reserve durable fences before R2 writes; deletion waits until each fence clears or atomically becomes repair work. R2 physical keys and custom metadata contain no subject, client, or logical key. Foreign-owner references and unresolved retirement block final user removal. Finalization removes personal fields and the local user only after every attributed row, application event, fence, and repair is gone.

## Cookies

AittaDB core uses a strictly necessary host-only, secure, `HttpOnly`, `SameSite=Lax` CSRF cookie for browser forms. It expires after 15 minutes and is not an authoritative login session. The first accepted account-deletion request sets a distinct encrypted, host-only, `HttpOnly`, `Secure`, `SameSite=Lax` status cookie scoped to `/account/deletion` for at most seven days. It carries the encrypted former local subject and protected timing data, is bound to the issuer, key ID/material, and exact trusted email, and authorizes only the coarse deletion-status read; it is not an AittaDB or ChatGPT login session. After a successful administrator mutation, AittaDB may also use a secure, `HttpOnly`, `SameSite=Strict` encrypted result cookie for up to five minutes. The redirected page atomically consumes it once; any confidential or service client secret in that result is never put in a URL or durable plaintext storage. The core sets no analytics or advertising cookies. ChatGPT Sites may use its own cookies for platform access and ChatGPT sign-in under OpenAI's notices and settings.

## Rights

Depending on applicable law, a person may have rights to access, correct, erase, restrict, object to, or receive a portable copy of personal data; withdraw consent without affecting earlier lawful processing; and complain to a competent supervisory authority. Requests should identify the relevant deployment and be sent to its published privacy contact. The operator may need to verify the requester's identity and may retain data when law permits or requires it.

## Changes

The operator should review this notice whenever AittaDB, configured clients, processing purposes, retention, provider terms, or contact details change. The policy served by the deployment is the notice applicable to that deployment at the time it is viewed.
