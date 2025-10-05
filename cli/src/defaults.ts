/**
 * Default configuration for org-level services.
 *
 * Security model:
 * - Discovery/Search uses public proxy API (no user credentials needed)
 * - Publishing uses public proxy API (rate-limited, no GitHub token needed)
 * - Semantic search uses proxy to protect org Nia credentials
 * - Users only need OPENROUTER_API_KEY for AI operations
 */

export const ORG_DEFAULTS = {
  /**
   * Organization name for the pack registry
   */
  GITHUB_ORG: 'PR0TO-IDE',

  /**
   * Public proxy API for registry operations (discovery, publishing)
   * Rate-limited: 100 req/hr for reads, 10 req/hr for publishes
   * Deployed via: modal deploy proxy/main.py
   */
  REGISTRY_PROXY_URL: process.env.PLGIN_REGISTRY_URL || 'https://pr0tobot--plgn-registry-proxy-proxy-app.modal.run',

  /**
   * Public proxy API for semantic search
   * This endpoint proxies requests to Nia with org credentials server-side
   * Uses same Modal endpoint as registry
   */
  SEMANTIC_PROXY_URL: process.env.PLGIN_SEMANTIC_URL || 'https://pr0tobot--plgn-registry-proxy-proxy-app.modal.run',

  /**
   * Fallback: direct GitHub API (deprecated, proxy handles all operations)
   */
  GITHUB_API_URL: 'https://api.github.com'
};

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
