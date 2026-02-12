/**
 * Shared matcher for routes that require admin-key authentication
 * instead of JWT authentication. Used by both admin-auth and jwt-auth
 * middleware to stay in sync.
 */

const ADMIN_PROTECTED_PREFIXES = ["/v1/admin/"];

const ADMIN_PROTECTED_EXACT_PREFIXES = [
  "/v1/contracts",
  "/v1/bundles",
];

export function isAdminRoute(url: string, routePath?: string): boolean {
  for (const prefix of ADMIN_PROTECTED_PREFIXES) {
    if (url.startsWith(prefix) || (routePath && routePath.startsWith(prefix))) {
      return true;
    }
  }

  for (const prefix of ADMIN_PROTECTED_EXACT_PREFIXES) {
    if (
      url === prefix ||
      url.startsWith(prefix + "/") ||
      (routePath && (routePath === prefix || routePath.startsWith(prefix + "/")))
    ) {
      return true;
    }
  }

  return false;
}
