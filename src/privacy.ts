import type { AppConfig, AuthStore } from "./types";

export const SITES_DPA_URL =
  "https://openai.com/policies/chatgpt-sites-data-processing-addendum/";
export const SITES_TERMS_URL =
  "https://openai.com/policies/chatgpt-sites-terms/";
export const EU_PRIVACY_RIGHTS_URL =
  "https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en";

export interface PrivacyContact {
  controllerName: string;
  controllerIdentifier?: string;
  contactName?: string;
  email: string;
  phone?: string;
  address?: string;
}

export interface PrivacyPolicySection {
  id: string;
  title: string;
  paragraphs: readonly string[];
  items?: readonly string[];
}

export interface PrivacyPolicyReference {
  title: string;
  href: string;
}

export interface PrivacyPolicyData {
  title: string;
  deployment: string;
  controller: {
    name: string;
    identifier?: string;
    contact_name?: string;
    email: string;
    phone?: string;
    postal_address?: string;
  };
  sections: readonly PrivacyPolicySection[];
  references: readonly PrivacyPolicyReference[];
}

export async function resolvePrivacyContact(
  config: AppConfig,
  store: AuthStore | null,
): Promise<PrivacyContact | null> {
  if (!config.privacy.valid) return null;

  const needsFallback =
    !config.privacy.contactEmail ||
    (!config.privacy.controllerName && !config.privacy.contactName);
  const fallbackSubject = config.adminSubjects[0];
  const fallbackUser =
    needsFallback && fallbackSubject && store
      ? await store.getUser(fallbackSubject)
      : null;
  const email = config.privacy.contactEmail ?? fallbackUser?.email ?? null;
  const contactName =
    config.privacy.contactName ?? fallbackUser?.displayName ?? undefined;
  const controllerName = config.privacy.controllerName ?? contactName ?? null;

  if (!email || !controllerName || !isContactEmail(email)) return null;
  return {
    controllerName,
    ...(config.privacy.controllerIdentifier
      ? { controllerIdentifier: config.privacy.controllerIdentifier }
      : {}),
    ...(contactName ? { contactName } : {}),
    email,
    ...(config.privacy.contactPhone
      ? { phone: config.privacy.contactPhone }
      : {}),
    ...(config.privacy.contactAddress
      ? { address: config.privacy.contactAddress }
      : {}),
  };
}

export function buildPrivacyPolicy(
  config: AppConfig,
  contact: PrivacyContact,
): PrivacyPolicyData {
  return {
    title: "Privacy Policy",
    deployment: config.issuerUrl,
    controller: {
      name: contact.controllerName,
      ...(contact.controllerIdentifier
        ? { identifier: contact.controllerIdentifier }
        : {}),
      ...(contact.contactName ? { contact_name: contact.contactName } : {}),
      email: contact.email,
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(contact.address ? { postal_address: contact.address } : {}),
    },
    sections: privacySections(config),
    references: [
      { title: "ChatGPT Sites Terms", href: SITES_TERMS_URL },
      { title: "ChatGPT Sites Data Processing Addendum", href: SITES_DPA_URL },
      {
        title: "European Commission privacy rights",
        href: EU_PRIVACY_RIGHTS_URL,
      },
    ],
  };
}

function privacySections(config: AppConfig): readonly PrivacyPolicySection[] {
  return [
    {
      id: "scope",
      title: "Scope and operator",
      paragraphs: [
        "This policy describes personal data processed by this AittaDB deployment. The named operator decides why and how Hosted Data is processed and is responsible for this deployment's privacy practices.",
        "AittaDB is reusable software. Other deployments and third-party applications using this service can have different operators, purposes, and privacy notices.",
      ],
    },
    {
      id: "data",
      title: "Data we process",
      paragraphs: [
        "AittaDB core collects the identity, authorization, security, and operational information needed to provide the service. Application content is stored when you or an authorized client chooses to submit it.",
      ],
      items: [
        "The email address and optional display name supplied server-side by ChatGPT Sites when you sign in, together with a separate locally generated UUID and timestamps.",
        "OAuth clients, requested scopes, authorization and consent state, token metadata, hashed opaque credentials, and access-token revocation identifiers.",
        "JSON records, logical keys, files, file metadata, and other content that you or an authorized application choose to store.",
        "Redacted audit events and pseudonymous rate-limit identifiers used for security, abuse prevention, and reliability.",
      ],
    },
    {
      id: "sources",
      title: "Where data comes from",
      paragraphs: [
        "ChatGPT Sites supplies the signed-in email signal and optional name through trusted server-side identity headers. AittaDB's current adapter does not read or store a profile photo, ChatGPT credentials, conversations, Projects, Library files, connectors, subscriptions, billing, or API quota.",
        "Stored application content comes from you or an application you authorize. Protocol, security, and timestamp data is generated when the service handles requests.",
      ],
    },
    {
      id: "purposes",
      title: "Purposes and legal bases",
      paragraphs: [
        "The operator uses this data to create and protect your local AittaDB identity; issue AittaDB sessions; perform approved OAuth and OpenID Connect operations; provide isolated records and files; prevent abuse; investigate security and reliability problems; and meet applicable legal obligations.",
        "Where the GDPR applies, the operator generally relies on processing necessary to provide the service you request and on legitimate interests in operating, securing, and preventing abuse of this deployment. Other legal bases can apply when required by the deployment's circumstances. OAuth approval is an authorization control and is not, by itself, a statement that consent is the data-protection legal basis.",
      ],
    },
    {
      id: "sharing",
      title: "Recipients and authorized applications",
      paragraphs: [
        "OpenAI hosts ChatGPT Sites and may process Hosted Data to host, maintain, and support this deployment under the terms and data-processing agreement applicable to the operator's account.",
        "An authorized application receives the local subject and only claims covered by approved AittaDB scopes. Email and name are released only through the corresponding approved scopes. Records and files stay isolated to the signed-in user and the application client that owns that namespace.",
        "The core service does not sell personal data or use advertising or analytics services. Information may also be disclosed where required or permitted by law. Third-party applications remain responsible for their own processing and privacy notices.",
      ],
    },
    {
      id: "retention",
      title: "Retention and deletion",
      paragraphs: [
        `Access tokens normally expire after ${formatDuration(config.accessTokenTtlSeconds)}, authorization codes after ${formatDuration(config.authCodeTtlSeconds)}, device grants after ${formatDuration(config.deviceCodeTtlSeconds)}, and refresh tokens after ${formatDuration(config.refreshTokenTtlSeconds)}. These periods are deployment-configurable. Expired protocol rows become eligible for bounded, traffic-dependent cleanup and may remain until cleanup runs.`,
        "Audit events become eligible for bounded cleanup after 90 days. One-minute rate-limit counters become eligible after five minutes. Local identities, remembered consents, client metadata, and application content do not share one automatic expiry period.",
        "Authorized users and applications can delete individual records and files. Other data is retained while needed to provide or secure the deployment, until the deployment is removed, or until the operator completes an applicable deletion request. The current MVP has no self-service whole-account deletion workflow.",
      ],
    },
    {
      id: "cookies",
      title: "Cookies and browser storage",
      paragraphs: [
        "AittaDB sets one strictly necessary secure, HttpOnly, SameSite=Lax CSRF cookie for up to 15 minutes when browser forms need protection. Core AittaDB uses no advertising or analytics cookies and stores no authoritative state in localStorage or sessionStorage.",
        "ChatGPT Sites and ChatGPT sign-in may use separate platform cookies governed by OpenAI's applicable terms and privacy information.",
      ],
    },
    {
      id: "security",
      title: "Security and appropriate use",
      paragraphs: [
        "AittaDB separates users and application clients, hashes bearer-equivalent opaque credentials, uses short-lived signed credentials, redacts credential-like audit data, and applies request, rate, and storage limits. No Internet service can guarantee absolute security.",
        "Do not store payment-card data or protected health information in this service. Applications handling other sensitive personal data must establish an appropriate legal basis, safeguards, and notices before using AittaDB for that data.",
      ],
    },
    {
      id: "international",
      title: "Hosting and international processing",
      paragraphs: [
        "This deployment runs on ChatGPT Sites. Information may be processed in locations where OpenAI and any provider added by the operator operate, subject to the agreements and safeguards applicable to the deployment. AittaDB does not promise a particular hosting country or data-residency option.",
      ],
    },
    {
      id: "rights",
      title: "Your rights",
      paragraphs: [
        "Depending on applicable law, you may have rights to access, correct, erase, restrict, or object to processing; receive a portable copy; withdraw consent where consent is the legal basis; and complain to a data-protection authority. These rights can be subject to legal conditions and exceptions.",
        "Contact the operator using the details above. The operator may need to verify your identity before acting on a request.",
      ],
    },
    {
      id: "automation",
      title: "Automated decisions and changes",
      paragraphs: [
        "AittaDB does not perform automated decision-making that produces legal or similarly significant effects. Automated security, quota, and rate-limit controls may temporarily reject requests.",
        "The operator should review this policy whenever the deployment's data use, applications, providers, or configuration changes.",
      ],
    },
  ];
}

function isContactEmail(value: string): boolean {
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(
    value,
  );
}

function formatDuration(seconds: number): string {
  const units = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ] as const;
  for (const [unitSeconds, label] of units) {
    if (seconds % unitSeconds === 0) {
      const value = seconds / unitSeconds;
      return `${value} ${label}${value === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
