/**
 * Placeholder entitlement service for V1.
 * Triggers entitlement recomputation after subscription state changes.
 * Full implementation will be added in the entitlements task.
 */
export class EntitlementService {
  /**
   * Recompute entitlements for a team after a subscription state change.
   * In V1, this is a simple no-op placeholder that logs the refresh request.
   * Future versions will cache and resolve entitlements from plans/bundles/contracts.
   */
  async refreshEntitlements(teamId: string): Promise<void> {
    // V1: No-op — entitlement resolution happens on-demand via GET /entitlements.
    // This hook exists so webhook handlers can trigger recomputation when
    // the full caching layer is implemented.
    void teamId;
  }
}
