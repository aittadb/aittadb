import { BOUNDED_RECORD_MEDIA_TYPE } from "./bounded-record-protocol";
import { HYPERMEDIA_API_VERSION, resourceDocument } from "./hypermedia";
import type { AppConfig } from "./types";

export const ACCEPTANCE_PROOF_SAFETY_PATH = "/.well-known/aittadb-proof-safety";

const CANONICAL_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// This assertion is an operational proof control, not a generic preview feature.
// Add an issuer here only through a reviewed task for that disposable deployment.
const APPROVED_ACCEPTANCE_ISSUERS = new Set(["https://test.aittadb.com"]);

export function isAcceptanceProofSafetyIssuer(issuerUrl: string): boolean {
  const url = new URL(issuerUrl);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    APPROVED_ACCEPTANCE_ISSUERS.has(url.origin)
  );
}

export function acceptanceProofSafetyResponse(
  request: Request,
  url: URL,
  config: AppConfig,
): Response {
  if (!config.acceptanceProofSafetyEnabled) return noStoreStatus(404);
  if (request.method !== "GET") return noStoreStatus(405, { allow: "GET" });
  if (request.headers.get("accept") !== BOUNDED_RECORD_MEDIA_TYPE) {
    return noStoreStatus(406, { vary: "Accept" });
  }

  const challenge = canonicalChallenge(url);
  if (!challenge) return noStoreStatus(404);

  const id = new URL(ACCEPTANCE_PROOF_SAFETY_PATH, config.issuerUrl);
  id.searchParams.set("challenge", challenge);
  const document = resourceDocument({
    type: "acceptance-proof-safety",
    id: id.toString(),
    data: {
      challenge,
      environment: "disposable-acceptance",
      issuer: config.issuerUrl,
      storage_contract_proofs: "allowed",
    },
    links: [],
    actions: [],
  });
  return new Response(JSON.stringify(document), {
    headers: {
      "aittadb-api-version": HYPERMEDIA_API_VERSION,
      "cache-control": "no-store",
      "content-type": BOUNDED_RECORD_MEDIA_TYPE,
      vary: "Accept",
    },
  });
}

function canonicalChallenge(url: URL): string | null {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "challenge" ||
    !CANONICAL_UUID_V4.test(entries[0][1])
  ) {
    return null;
  }
  return entries[0][1];
}

function noStoreStatus(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
