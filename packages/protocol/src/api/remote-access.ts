/** `/api/node/remote-access`: the node's remote address (docs/remote-access.md). Times are ISO 8601. */

/** In order: the first that holds. `starting` is everything before the first successful self-check. */
export type RemoteAccessState = "off" | "error" | "denied" | "on" | "degraded" | "starting";

export type RemoteErrorCode =
  /** A network error, a timeout or a 5xx from the remote-access service. */
  | "service_unreachable"
  /** A 4xx from the service; `service_code` is its own code. */
  | "service_refused"
  /** The service has refused this node's key for more than a day. */
  | "binding_rejected"
  | "upgrade_required"
  | "denied"
  | "retired"
  /** A restore code moved the address to another computer: off here, and unbound until a new code. */
  | "moved"
  | "issuance_budget"
  | "acme_rate_limited"
  | "acme_challenge_failed"
  | "dns_not_visible"
  | "acme_action_required"
  | "acme_error"
  /** The self-check could not reach this node's own address through the relay. */
  | "connector_unreachable"
  /** The self-check reached a certificate that is not this node's. */
  | "wrong_certificate"
  | "remote_dir_unusable"
  | "socket_path_too_long"
  /** Worked out from the state rather than kept: the certificate ran out and no new one is here yet. */
  | "certificate_expired"
  /**
   * Worked out from the connector's status: it failed for a reason that passes, or has not started
   * since it was asked, and is asked again at `retry_at`.
   */
  | "connector_failed"
  /** Worked out from the connector's status: the packaging refused to run it, until an administrator retries. */
  | "connector_refused"
  /** Worked out from the connector's status: this installation has no connector. */
  | "connector_unavailable";

/** What the packaging that runs the connector last reported (docs/remote-access.md). */
export type ConnectorState = "installing" | "running" | "stopped" | "refused" | "failed" | "unavailable";

export interface ConnectorStatus {
  state: ConnectorState;
  message: string;
  at: string;
  /** The sha-256 of the connector it runs, and of the settings it was started with. */
  connector_sha: string | null;
  config_sha: string | null;
}

export interface RemoteError {
  code: RemoteErrorCode;
  message: string;
  at: string;
  retry_at?: string;
  service_code?: string;
  reason?: string;
}

export type RemoteAccessStatus =
  /** The packaging offers no remote access. */
  | { available: false }
  | {
      available: true;
      enabled: boolean;
      state: RemoteAccessState;
      /** `https://<hostname>`, once bound, on or off. */
      address: string | null;
      certificate: { expires_at: string; renew_at: string | null } | null;
      credential: { expires_at: string } | null;
      connector: {
        /** The packaging runs the connector; nobody runs it by hand. */
        managed: boolean;
        /** Where `managed`, what the packaging last reported; null before it has. */
        status: ConnectorStatus | null;
        /** The first relay's connector config, for running the connector by hand; null where a helper runs it. */
        config_path: string | null;
        config_changed_at: string | null;
        /** Whether the last self-check reached this node through the relay. */
        reachable: boolean;
        checked_at: string | null;
      } | null;
      ca_terms: { accepted_by: string | null; accepted_at: string; url: string | null } | null;
      last_error: RemoteError | null;
    };

/** `POST /api/node/remote-access/enable`. */
export interface RemoteAccessEnableRequest {
  /** Required until the node is bound; afterwards it restores the address, or takes a new one. */
  code?: string;
  /** The certificate authority's subscriber agreement; must be true. */
  accept_ca_terms: boolean;
}

export type RemoteAccessEnableErrorCode =
  | "unavailable"
  | "code_required"
  | "enroll_code_invalid"
  | "enroll_code_used"
  | "enroll_code_expired"
  | "denied"
  | "retired"
  | "upgrade_required"
  | "service_unreachable"
  | "remote_dir_unusable"
  | "socket_path_too_long";

/** A refused enable: an English sentence and, where the page has something to key on, a code. */
export interface RemoteAccessEnableError {
  error: string;
  code?: RemoteAccessEnableErrorCode;
}
