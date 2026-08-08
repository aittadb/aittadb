import type { ClientView } from "./types";

export const ADMIN_CLIENT_OPERATIONS = [
  "enable",
  "disable",
  "rotate_secret",
  "revoke_grants",
] as const;

export type AdminClientOperation = (typeof ADMIN_CLIENT_OPERATIONS)[number];

export interface AdminClientControl {
  operation: AdminClientOperation;
  name:
    | "enable-client"
    | "disable-client"
    | "rotate-client-secret"
    | "revoke-client-grants";
  label: string;
}

export type AdminMutationOperation = "create" | AdminClientOperation;

export interface AdminMutationResult {
  operation: AdminMutationOperation;
  clientId: string;
  secret?: string;
}

export function parseAdminClientOperation(
  value: string | null,
): AdminClientOperation | null {
  return ADMIN_CLIENT_OPERATIONS.includes(value as AdminClientOperation)
    ? (value as AdminClientOperation)
    : null;
}

export function adminClientControls(
  client: ClientView,
): readonly AdminClientControl[] {
  return [
    client.disabledAt
      ? { operation: "enable", name: "enable-client", label: "Enable" }
      : { operation: "disable", name: "disable-client", label: "Disable" },
    ...(client.type === "confidential"
      ? [
          {
            operation: "rotate_secret" as const,
            name: "rotate-client-secret" as const,
            label: "Rotate secret",
          },
        ]
      : []),
    {
      operation: "revoke_grants",
      name: "revoke-client-grants",
      label: "Revoke grants",
    },
  ];
}

export function hasAdminClientControl(
  client: ClientView,
  operation: AdminClientOperation,
): boolean {
  return adminClientControls(client).some(
    (control) => control.operation === operation,
  );
}
