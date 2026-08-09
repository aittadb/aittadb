export const HYPERMEDIA_API_VERSION = "0.1";
export const HYPERMEDIA_CONTRACT_STATUS = "preview";
export const HYPERMEDIA_MEDIA_TYPE = "application/vnd.aittadb+json";

export type HypermediaRepresentation = "html" | "json" | "hypermedia";

export interface AcceptMediaRange {
  type: string;
  subtype: string;
  parameters: Readonly<Record<string, string>>;
  quality: number;
  order: number;
}

export type HypermediaMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HypermediaFieldLocation = "path" | "query" | "header" | "body";
export type HypermediaFieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "file";

export interface HypermediaLink {
  rel: string[];
  href: string;
  type?: string;
  title?: string;
  templated?: boolean;
}

export interface HypermediaFieldOption {
  value: string;
  title: string;
}

export interface HypermediaFieldCondition {
  field: string;
  value: string;
}

export interface HypermediaField {
  name: string;
  title: string;
  type: HypermediaFieldType;
  location: HypermediaFieldLocation;
  required?: boolean;
  secret?: boolean;
  value?: unknown;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  max_bytes?: number;
  options?: HypermediaFieldOption[];
  visible_when?: HypermediaFieldCondition;
  description?: string;
}

export interface HypermediaAuthorization {
  scheme: "none" | "bearer" | "basic" | "sites-session";
  scopes?: string[];
  description?: string;
}

export interface HypermediaAction {
  name: string;
  title: string;
  method: HypermediaMethod;
  href: string;
  type?: string;
  accept?: string;
  templated?: boolean;
  fields: HypermediaField[];
  authorization?: HypermediaAuthorization;
  description?: string;
}

export interface HypermediaDocument<T> {
  api_version: typeof HYPERMEDIA_API_VERSION;
  type: string;
  id?: string;
  data: T;
  links: HypermediaLink[];
  actions: HypermediaAction[];
}

export function resourceDocument<T>(options: {
  type: string;
  id?: string;
  data: T;
  links?: readonly HypermediaLink[];
  actions?: readonly HypermediaAction[];
}): HypermediaDocument<T> {
  return {
    api_version: HYPERMEDIA_API_VERSION,
    type: options.type,
    ...(options.id === undefined ? {} : { id: options.id }),
    data: options.data,
    links: [...(options.links ?? [])],
    actions: [...(options.actions ?? [])],
  };
}

export function link(
  rel: string | readonly string[],
  href: string,
  options: Omit<HypermediaLink, "rel" | "href"> = {},
): HypermediaLink {
  return {
    rel: typeof rel === "string" ? [rel] : [...rel],
    href,
    ...options,
  };
}

export function action(
  name: string,
  title: string,
  method: HypermediaMethod,
  href: string,
  options: Omit<
    HypermediaAction,
    "name" | "title" | "method" | "href" | "fields"
  > & { fields?: readonly HypermediaField[] } = {},
): HypermediaAction {
  return {
    name,
    title,
    method,
    href,
    ...options,
    fields: [...(options.fields ?? [])],
  };
}

export function field(
  name: string,
  title: string,
  type: HypermediaFieldType,
  location: HypermediaFieldLocation,
  options: Omit<HypermediaField, "name" | "title" | "type" | "location"> = {},
): HypermediaField {
  return { name, title, type, location, ...options };
}

export function findLink(
  document: Pick<HypermediaDocument<unknown>, "links">,
  relation: string,
): HypermediaLink | undefined {
  return document.links.find((candidate) => candidate.rel.includes(relation));
}

export function findAction(
  document: Pick<HypermediaDocument<unknown>, "actions">,
  name: string,
): HypermediaAction | undefined {
  return document.actions.find((candidate) => candidate.name === name);
}

export function endpointActions(issuer: string): {
  authorize: HypermediaAction;
  deviceAuthorization: HypermediaAction;
  token: HypermediaAction;
  revoke: HypermediaAction;
  introspect: HypermediaAction;
  userInfo: HypermediaAction;
} {
  return {
    authorize: action(
      "begin-authorization-code",
      "Begin authorization code flow",
      "GET",
      `${issuer}/authorize`,
      {
        authorization: { scheme: "none" },
        fields: [
          field("response_type", "Response type", "string", "query", {
            required: true,
            value: "code",
            options: [{ value: "code", title: "Authorization code" }],
          }),
          field("client_id", "Client ID", "string", "query", {
            required: true,
          }),
          field("redirect_uri", "Exact redirect URI", "string", "query", {
            required: true,
          }),
          field("scope", "Local scopes", "string", "query", {
            value: "openid email profile",
          }),
          field("state", "State", "string", "query"),
          field("nonce", "OIDC nonce", "string", "query"),
          field("code_challenge", "S256 code challenge", "string", "query", {
            required: true,
            min_length: 43,
            max_length: 43,
          }),
          field(
            "code_challenge_method",
            "Code challenge method",
            "string",
            "query",
            {
              required: true,
              value: "S256",
              options: [{ value: "S256", title: "S256" }],
            },
          ),
        ],
      },
    ),
    deviceAuthorization: action(
      "create-device-authorization",
      "Create device authorization",
      "POST",
      `${issuer}/oauth/device_authorization`,
      {
        type: "application/x-www-form-urlencoded",
        authorization: {
          scheme: "none",
          description:
            "Public clients send client_id; confidential clients authenticate. Service clients cannot use this interactive grant.",
        },
        fields: [
          field("client_id", "Client ID", "string", "body", {
            required: true,
          }),
          field("client_secret", "Client secret", "string", "body", {
            secret: true,
            description: "Confidential clients only.",
          }),
          field("scope", "Local scopes", "string", "body", {
            value: "openid email profile offline_access",
          }),
        ],
      },
    ),
    token: action(
      "exchange-oauth-grant",
      "Exchange OAuth grant",
      "POST",
      `${issuer}/oauth/token`,
      {
        type: "application/x-www-form-urlencoded",
        authorization: {
          scheme: "none",
          description:
            "Public clients send client_id; confidential and service clients authenticate with Basic or body credentials.",
        },
        fields: [
          field("grant_type", "Grant type", "string", "body", {
            required: true,
            options: [
              {
                value: "urn:ietf:params:oauth:grant-type:device_code",
                title: "Device code",
              },
              { value: "authorization_code", title: "Authorization code" },
              { value: "refresh_token", title: "Refresh token" },
              { value: "client_credentials", title: "Client credentials" },
            ],
          }),
          field("client_id", "Client ID", "string", "body", {
            required: true,
          }),
          field("client_secret", "Client secret", "string", "body", {
            secret: true,
            description: "Confidential and service clients only.",
          }),
          field("device_code", "Device code", "string", "body", {
            required: true,
            secret: true,
            visible_when: {
              field: "grant_type",
              value: "urn:ietf:params:oauth:grant-type:device_code",
            },
          }),
          field("code", "Authorization code", "string", "body", {
            required: true,
            secret: true,
            visible_when: { field: "grant_type", value: "authorization_code" },
          }),
          field("redirect_uri", "Redirect URI", "string", "body", {
            required: true,
            visible_when: { field: "grant_type", value: "authorization_code" },
          }),
          field("code_verifier", "PKCE code verifier", "string", "body", {
            required: true,
            secret: true,
            min_length: 43,
            max_length: 128,
            visible_when: { field: "grant_type", value: "authorization_code" },
          }),
          field("refresh_token", "Refresh token", "string", "body", {
            required: true,
            secret: true,
            visible_when: { field: "grant_type", value: "refresh_token" },
          }),
          field("scope", "Service storage scopes", "string", "body", {
            value: "storage.read storage.write storage.delete",
            visible_when: {
              field: "grant_type",
              value: "client_credentials",
            },
            description:
              "Optional subset of the service client's registered storage scopes.",
          }),
        ],
      },
    ),
    revoke: action(
      "revoke-token",
      "Revoke token",
      "POST",
      `${issuer}/oauth/revoke`,
      {
        type: "application/x-www-form-urlencoded",
        fields: [
          field("token", "Token", "string", "body", {
            required: true,
            secret: true,
          }),
          field("token_type_hint", "Token type hint", "string", "body", {
            options: [
              { value: "refresh_token", title: "Refresh token" },
              { value: "access_token", title: "Access token" },
            ],
          }),
          field("client_id", "Client ID", "string", "body", {
            required: true,
          }),
          field("client_secret", "Client secret", "string", "body", {
            secret: true,
          }),
        ],
      },
    ),
    introspect: action(
      "introspect-token",
      "Introspect token",
      "POST",
      `${issuer}/oauth/introspect`,
      {
        type: "application/x-www-form-urlencoded",
        authorization: { scheme: "basic" },
        fields: [
          field("token", "Access token", "string", "body", {
            required: true,
            secret: true,
          }),
          field("token_type_hint", "Token type hint", "string", "body", {
            value: "access_token",
          }),
        ],
      },
    ),
    userInfo: action(
      "read-userinfo",
      "Read UserInfo",
      "GET",
      `${issuer}/userinfo`,
      {
        authorization: {
          scheme: "bearer",
          scopes: ["openid"],
        },
        fields: [
          field("Authorization", "Bearer access token", "string", "header", {
            required: true,
            secret: true,
          }),
        ],
      },
    ),
  };
}

export function requestedHypermediaVersion(
  request: Request,
): { requested: false } | { requested: true; version: string | null } {
  const requested = parseAcceptHeader(request.headers.get("accept"))
    .filter(
      (range) =>
        range.quality > 0 &&
        `${range.type}/${range.subtype}` === HYPERMEDIA_MEDIA_TYPE,
    )
    .sort(
      (left, right) => right.quality - left.quality || left.order - right.order,
    )[0];
  if (requested) {
    return {
      requested: true,
      version: requested.parameters.version ?? null,
    };
  }
  return { requested: false };
}

export function hypermediaVersionError(request: Request): string | null {
  if (negotiateHypermediaRepresentation(request) !== null) return null;
  const requested = requestedHypermediaVersion(request);
  if (!requested.requested) return null;
  if (!requested.version) {
    return `The ${HYPERMEDIA_MEDIA_TYPE} media type requires version=${HYPERMEDIA_API_VERSION}`;
  }
  if (requested.version !== HYPERMEDIA_API_VERSION) {
    return `Unsupported AittaDB API version: ${requested.version}`;
  }
  return null;
}

export function prefersVendorHypermedia(request: Request): boolean {
  return negotiateHypermediaRepresentation(request) === "hypermedia";
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface AvailableRepresentation {
  name: HypermediaRepresentation;
  type: string;
  subtype: string;
  parameters: Readonly<Record<string, string>>;
  preference: number;
}

interface RepresentationMatch {
  representation: HypermediaRepresentation;
  quality: number;
  specificity: number;
  parameterCount: number;
  order: number;
  preference: number;
}

const AVAILABLE_REPRESENTATIONS: readonly AvailableRepresentation[] = [
  {
    name: "json",
    type: "application",
    subtype: "json",
    parameters: { charset: "utf-8" },
    preference: 0,
  },
  {
    name: "hypermedia",
    type: "application",
    subtype: "vnd.aittadb+json",
    parameters: { version: HYPERMEDIA_API_VERSION, charset: "utf-8" },
    preference: 1,
  },
  {
    name: "html",
    type: "text",
    subtype: "html",
    parameters: { charset: "utf-8" },
    preference: 2,
  },
];

/** Parse an HTTP Accept field while retaining q=0 ranges for exclusions. */
export function parseAcceptHeader(value: string | null): AcceptMediaRange[] {
  if (!value?.trim()) return [];
  const parts = splitOutsideQuotes(value, ",");
  if (!parts) return [];

  const ranges: AcceptMediaRange[] = [];
  for (const [order, part] of parts.entries()) {
    const segments = splitOutsideQuotes(part, ";");
    if (!segments) continue;
    const mediaType = segments.shift()?.trim().toLowerCase() ?? "";
    const slash = mediaType.indexOf("/");
    if (slash <= 0 || slash !== mediaType.lastIndexOf("/")) continue;
    const type = mediaType.slice(0, slash);
    const subtype = mediaType.slice(slash + 1);
    if (
      !isMediaRangeToken(type, true) ||
      !isMediaRangeToken(subtype, false) ||
      (type === "*" && subtype !== "*")
    ) {
      continue;
    }

    const parameters: Record<string, string> = {};
    let quality = 1;
    let qualitySeen = false;
    let valid = true;
    for (const rawParameter of segments) {
      if (qualitySeen) continue;
      const separator = rawParameter.indexOf("=");
      if (separator <= 0) {
        valid = false;
        break;
      }
      const name = rawParameter.slice(0, separator).trim().toLowerCase();
      const parameterValue = parseParameterValue(
        rawParameter.slice(separator + 1).trim(),
      );
      if (!HTTP_TOKEN.test(name) || parameterValue === null) {
        valid = false;
        break;
      }
      if (name === "q") {
        const parsedQuality = parseQuality(parameterValue);
        if (parsedQuality === null) {
          valid = false;
          break;
        }
        quality = parsedQuality;
        qualitySeen = true;
        continue;
      }
      if (Object.hasOwn(parameters, name)) {
        valid = false;
        break;
      }
      parameters[name] = parameterValue;
    }
    if (!valid) continue;
    ranges.push({ type, subtype, parameters, quality, order });
  }
  return ranges;
}

/** Select the best representation using the supplied server preference for ties. */
export function negotiateHypermediaRepresentation(
  request: Request,
  serverPreference: HypermediaRepresentation = "json",
): HypermediaRepresentation | null {
  const accept = request.headers.get("accept");
  if (!accept?.trim()) return serverPreference;
  const ranges = parseAcceptHeader(accept);
  let selected: RepresentationMatch | null = null;

  for (const representation of AVAILABLE_REPRESENTATIONS) {
    const match = bestRangeMatch(ranges, representation);
    if (!match || match.quality === 0) continue;
    const candidate: RepresentationMatch = {
      representation: representation.name,
      quality: match.quality,
      specificity: match.specificity,
      parameterCount: match.parameterCount,
      order: match.order,
      preference:
        representation.name === serverPreference
          ? -1
          : representation.preference,
    };
    if (!selected || compareMatches(candidate, selected) < 0) {
      selected = candidate;
    }
  }
  return selected?.representation ?? null;
}

export function hypermediaNegotiationError(request: Request): string | null {
  if (negotiateHypermediaRepresentation(request) !== null) return null;
  const versionError = hypermediaVersionError(request);
  return (
    versionError ??
    "No supported HTML or JSON representation matches the Accept header"
  );
}

function bestRangeMatch(
  ranges: readonly AcceptMediaRange[],
  representation: AvailableRepresentation,
): (AcceptMediaRange & { specificity: number; parameterCount: number }) | null {
  let best:
    | (AcceptMediaRange & { specificity: number; parameterCount: number })
    | null = null;
  for (const range of ranges) {
    const specificity = mediaRangeSpecificity(range, representation);
    if (specificity === null) continue;
    const candidate = {
      ...range,
      specificity,
      parameterCount: Object.keys(range.parameters).length,
    };
    if (
      !best ||
      candidate.specificity > best.specificity ||
      (candidate.specificity === best.specificity &&
        candidate.parameterCount > best.parameterCount) ||
      (candidate.specificity === best.specificity &&
        candidate.parameterCount === best.parameterCount &&
        candidate.order < best.order)
    ) {
      best = candidate;
    }
  }
  return best;
}

function mediaRangeSpecificity(
  range: AcceptMediaRange,
  representation: AvailableRepresentation,
): number | null {
  if (range.type !== "*" && range.type !== representation.type) return null;
  if (range.subtype !== "*" && range.subtype !== representation.subtype) {
    return null;
  }
  if (
    range.type === "application" &&
    range.subtype === "vnd.aittadb+json" &&
    range.quality > 0 &&
    range.parameters.version === undefined
  ) {
    return null;
  }
  for (const [name, value] of Object.entries(range.parameters)) {
    const representedValue = representation.parameters[name];
    if (
      representedValue === undefined ||
      !mediaParameterEquals(name, value, representedValue)
    ) {
      return null;
    }
  }
  if (range.type === "*") return 0;
  if (range.subtype === "*") return 1;
  return 2;
}

function compareMatches(
  left: RepresentationMatch,
  right: RepresentationMatch,
): number {
  return (
    right.quality - left.quality ||
    right.specificity - left.specificity ||
    right.parameterCount - left.parameterCount ||
    left.order - right.order ||
    left.preference - right.preference
  );
}

function isMediaRangeToken(value: string, type: boolean): boolean {
  if (value === "*") return true;
  return (
    HTTP_TOKEN.test(value) && !value.includes("*") && (!type || value !== "")
  );
}

function parseQuality(value: string): number | null {
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return null;
  return Number(value);
}

function parseParameterValue(value: string): string | null {
  if (!value.startsWith('"')) return HTTP_TOKEN.test(value) ? value : null;
  if (value.length < 2 || !value.endsWith('"')) return null;
  let parsed = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      parsed += character;
      continue;
    }
    index += 1;
    if (index >= value.length - 1) return null;
    parsed += value[index];
  }
  return parsed;
}

function splitOutsideQuotes(value: string, separator: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === separator) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
}

function mediaParameterEquals(
  name: string,
  left: string,
  right: string,
): boolean {
  return name === "charset"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
