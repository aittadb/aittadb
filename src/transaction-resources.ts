import {
  HYPERMEDIA_MEDIA_TYPE,
  action,
  field,
  link,
  resourceDocument,
} from "./hypermedia";
import type {
  AuthorizationRequest,
  ClientView,
  DeviceGrant,
  DeviceGrantStatus,
} from "./types";

export function deviceEntryDocument(
  issuer: string,
  csrf: string,
  userCode: string,
) {
  return resourceDocument({
    type: "device-code-entry",
    id: `${issuer}/device`,
    data: { user_code: userCode },
    links: transactionLinks(issuer, "/device"),
    actions: [
      action(
        "review-device-request",
        "Review device request",
        "POST",
        `${issuer}/device`,
        {
          type: "application/x-www-form-urlencoded",
          authorization: { scheme: "sites-session" },
          fields: [
            csrfField(csrf),
            field("user_code", "User code", "string", "body", {
              required: true,
              value: userCode,
              min_length: 8,
              max_length: 9,
            }),
          ],
        },
      ),
    ],
  });
}

export function deviceApprovalDocument(
  issuer: string,
  grant: DeviceGrant,
  client: ClientView,
  csrf: string,
) {
  return resourceDocument({
    type: "device-request",
    id: `${issuer}/device/${encodeURIComponent(grant.userCodeDisplay)}`,
    data: {
      client_name: client.name,
      user_code: grant.userCodeDisplay,
      scopes: grant.scope.split(" ").filter(Boolean),
      status: grant.status,
      expires_at: grant.expiresAt,
    },
    links: transactionLinks(issuer, "/device"),
    actions:
      grant.status === "pending"
        ? [
            deviceDecisionAction(
              issuer,
              grant.userCodeDisplay,
              csrf,
              "approve",
            ),
            deviceDecisionAction(issuer, grant.userCodeDisplay, csrf, "deny"),
          ]
        : [],
  });
}

export function deviceDecisionDocument(
  issuer: string,
  status: Exclude<DeviceGrantStatus, "pending">,
) {
  return resourceDocument({
    type: "device-request-decision",
    data: { status },
    links: [
      link("service", issuer, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("device-entry", `${issuer}/device`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("documentation", `${issuer}/docs`, { type: "text/html" }),
    ],
  });
}

export function authorizationConsentDocument(
  issuer: string,
  request: AuthorizationRequest,
  client: ClientView,
  csrf: string,
) {
  return resourceDocument({
    type: "authorization-consent",
    id: `${issuer}/consent?request_id=${encodeURIComponent(request.id)}`,
    data: {
      client_name: client.name,
      scopes: request.scope.split(" ").filter(Boolean),
      redirect_uri: request.redirectUri,
      status: request.status,
      expires_at: request.expiresAt,
    },
    links: transactionLinks(
      issuer,
      `/consent?request_id=${encodeURIComponent(request.id)}`,
    ),
    actions:
      request.status === "pending"
        ? [
            consentDecisionAction(issuer, request.id, csrf, "approve"),
            consentDecisionAction(issuer, request.id, csrf, "deny"),
          ]
        : [],
  });
}

function transactionLinks(issuer: string, self: string) {
  return [
    link("self", `${issuer}${self}`, { type: HYPERMEDIA_MEDIA_TYPE }),
    link("service", issuer, { type: HYPERMEDIA_MEDIA_TYPE }),
    link("documentation", `${issuer}/docs`, { type: "text/html" }),
  ];
}

function deviceDecisionAction(
  issuer: string,
  userCode: string,
  csrf: string,
  decision: "approve" | "deny",
) {
  return action(
    `${decision}-device-request`,
    decision === "approve" ? "Approve device request" : "Deny device request",
    "POST",
    `${issuer}/device/decision`,
    {
      type: "application/x-www-form-urlencoded",
      authorization: { scheme: "sites-session" },
      fields: [
        csrfField(csrf),
        field("user_code", "User code", "string", "body", {
          required: true,
          value: userCode,
        }),
        field("decision", "Decision", "string", "body", {
          required: true,
          value: decision,
          options: [{ value: decision, title: capitalize(decision) }],
        }),
      ],
    },
  );
}

function consentDecisionAction(
  issuer: string,
  requestId: string,
  csrf: string,
  decision: "approve" | "deny",
) {
  return action(
    `${decision}-authorization`,
    decision === "approve" ? "Approve authorization" : "Deny authorization",
    "POST",
    `${issuer}/consent`,
    {
      type: "application/x-www-form-urlencoded",
      authorization: { scheme: "sites-session" },
      fields: [
        csrfField(csrf),
        field("request_id", "Authorization request", "string", "body", {
          required: true,
          value: requestId,
        }),
        field("decision", "Decision", "string", "body", {
          required: true,
          value: decision,
          options: [{ value: decision, title: capitalize(decision) }],
        }),
      ],
    },
  );
}

function csrfField(value: string) {
  return field("csrf_token", "CSRF token", "string", "body", {
    required: true,
    secret: true,
    value,
  });
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
