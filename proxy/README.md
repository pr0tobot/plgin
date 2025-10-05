# PLGN Registry Proxy

Secure serverless proxy for PLGN pack registry and semantic search operations.

## Purpose

This proxy securely handles org-level credentials server-side, allowing PLGN CLI users to discover and search packs without providing their own GitHub or Nia API keys.

## Deployment

### Prerequisites

- Modal account: https://modal.com
- Modal CLI installed: `pip install modal`
- Modal authenticated: `modal token new`

### Setup

1. Create environment file:
```bash
cp .env.example .env
# Edit .env with your credentials
```

2. Create Modal secret:
```bash
modal secret create plgn-secrets --env-file=proxy/.env
```

3. Deploy proxy:
```bash
modal deploy main.py
```

4. Get deployment URL:
```bash
modal app show plgn-registry-proxy
```

5. Update CLI with proxy URL:
```bash
# In cli/src/defaults.ts, set REGISTRY_PROXY_URL to the Modal URL
```

## Endpoints

### GET /
Health check

### GET /registry/index
Fetch pack registry index (public, rate-limited)

**Headers:**
- `User-Agent`: Must contain "plgn/"

**Response:**
```json
{
  "entries": [...],
  "cached_at": "2025-10-05T06:00:00"
}
```

### POST /semantic/search
Semantic pack search via Nia (public, rate-limited)

**Headers:**
- `User-Agent`: Must contain "plgn/"

**Body:**
```json
{
  "query": "authentication system",
  "languages": ["typescript"],
  "limit": 10
}
```

### POST /registry/update
Update registry index (admin only)

**Headers:**
- `User-Agent`: Must contain "plgn/"

**Body:**
```json
{
  "entries": [...],
  "message": "Publish pack-name@1.0.0",
  "admin_token": "your_admin_token"
}
```

## Security

- **Rate Limiting**: 100 req/hr for reads, 10 req/hr for writes per IP
- **Client Verification**: Requires PLGN CLI user agent
- **Credential Isolation**: Org tokens never exposed to clients
- **Admin Auth**: Write operations require admin token

## Local Development

```bash
modal serve main.py
```

This starts a local dev server at `https://your-username--plgn-registry-proxy-proxy-app-dev.modal.run`
