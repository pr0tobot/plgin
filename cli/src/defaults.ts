/**
 * Default configuration for org-level services.
 *
 * Security model:
 * - Discovery/Search uses public proxy API (no user credentials needed)
 * - Publishing requires user's own GITHUB_TOKEN
 * - Semantic search uses proxy to protect org Nia credentials
 */

export const ORG_DEFAULTS = {
  /**
   * Organization name for the pack registry
   */
  GITHUB_ORG: 'PR0TO-IDE',

  /**
   * Public proxy API for registry operations (discovery, download)
   * This endpoint is rate-limited and read-only
   * Set after Modal deployment: modal deploy proxy/main.py
   */
  REGISTRY_PROXY_URL: process.env.PLGN_REGISTRY_URL || 'https://pr0tobot--plgn-registry-proxy-proxy-app.modal.run',

  /**
   * Public proxy API for semantic search
   * This endpoint proxies requests to Nia with org credentials server-side
   * Uses same Modal endpoint as registry
   */
  SEMANTIC_PROXY_URL: process.env.PLGN_SEMANTIC_URL || 'https://pr0tobot--plgn-registry-proxy-proxy-app.modal.run',

  /**
   * Fallback: direct GitHub API (requires user's GITHUB_TOKEN)
   */
  GITHUB_API_URL: 'https://api.github.com'
};

/**
 * Get GitHub token for write operations (publish only)
 * Users must provide their own token for publishing
 */
export function resolveGitHubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not found. Publishing requires authentication.');
  }
  return token;
}

/**
 * Check if user has write access for publishing
 */
export function canPublish(): boolean {
  return Boolean(resolveGitHubToken());
}

/**
 * Discovery uses public proxy, no authentication required
 */
export function getRegistryEndpoint(): string {
  return ORG_DEFAULTS.REGISTRY_PROXY_URL;
}

/**
 * Semantic search uses public proxy, no authentication required
 */
export function getSemanticEndpoint(): string {
  return ORG_DEFAULTS.SEMANTIC_PROXY_URL;
}
