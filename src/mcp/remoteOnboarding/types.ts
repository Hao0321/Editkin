import { CANDIDATE_SCHEMA, LEGACY_PENDING_SCHEMA, REMOTE_SCHEMA, RUNTIME_SCHEMA, VERIFICATION_SCHEMA } from "./constants";

export type RemoteTransport = "https-tunnel" | "cloud-relay";

export interface RemoteSetupPaths {
  root: string;
  config: string;
  candidate: string;
  pending: string;
  pendingRenewing: string;
  verification: string;
  runtime: string;
}

export interface LegacyPendingRemoteSetup {
  schema: typeof LEGACY_PENDING_SCHEMA;
  confirmationId: string;
  transport: RemoteTransport;
  providerId: string;
  costResponsibility: "end-user";
  autoDeploy: false;
  preparedAt: string;
  remoteAgentJobId?: string;
  remoteAgentConsentRevision?: string;
}

export interface UserRemoteConfig {
  schema: typeof REMOTE_SCHEMA;
  schemaVersion: 1;
  mode: "user-owned-byo";
  transport: RemoteTransport;
  origin: string;
  providerId: string;
  costResponsibility: "end-user";
  userConfirmedCostsAndPermissions: true;
  configuredAt: string;
  configurationId: string;
}

export interface PendingRemoteConfigCandidate {
  schema: typeof CANDIDATE_SCHEMA;
  candidateRevision: string;
  expectedConfigurationId: string | null;
  preparedAtMs: number;
  expiresAtMs: number;
  configuration: UserRemoteConfig;
}

export interface RemoteRouteVerification {
  schema: typeof VERIFICATION_SCHEMA;
  configurationId: string;
  status: "PARTIAL";
  verified: false;
  verifiedAt: string;
  verifiedAtMs: number;
  probeId: string;
  runtimeInstanceId: string;
  processId: number;
  startedAtMs: number;
  endpointKind: "editkin-tunnel";
  successfulTlsConnections: 2;
  latencyMs: [number, number];
  latencyP50Ms: number;
  jitterMs: number;
  routeEvidence: "two-pinned-independent-tls-connections-succeeded";
  reconnectVerified: false;
  requiresActiveMobileProof: true;
}

export interface RemoteRuntimeIdentity {
  schema: typeof RUNTIME_SCHEMA;
  transport: RemoteTransport;
  configurationId: string;
  probeId: string;
  runtimeInstanceId: string;
  processId: number;
  startedAtMs: number;
}

export interface ConfigureRemoteAccessInput {
  confirmationId: string;
  origin: string;
  userConfirmedDeployment: true;
  userConfirmedProviderCosts: true;
  userConfirmedProviderPermissions: true;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type LookupLike = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export interface RemoteJsonReadHooks {
  afterHandleOpened?: (path: string) => Promise<void>;
}
