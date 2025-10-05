"""
PLGN Registry Proxy
Secure serverless proxy for GitHub registry and Nia semantic search
"""

import modal
import os
import hashlib
import time
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta

# Create Modal app
app = modal.App("plgn-registry-proxy")

# Docker image with dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi>=0.104.1",
        "pydantic>=2.5.0",
        "httpx>=0.26.0",
        "PyGithub==2.1.1",
        "python-dotenv>=1.0.0"
    )
)

# Rate limiting storage
rate_limit_store = modal.Dict.from_name("plgn-rate-limits", create_if_missing=True)

# Request models
class RegistryIndexRequest(BaseModel):
    """Request to fetch registry index"""
    org: str = Field(default="PR0TO-IDE", description="GitHub organization")

class SemanticSearchRequest(BaseModel):
    """Request for semantic search"""
    query: str = Field(..., description="Search query")
    languages: Optional[List[str]] = Field(None, description="Filter by languages")
    limit: int = Field(default=10, description="Max results")

class PublishIndexRequest(BaseModel):
    """Request to update registry index (admin only)"""
    entries: List[Dict[str, Any]] = Field(..., description="Registry entries")
    message: str = Field(..., description="Commit message")
    admin_token: str = Field(..., description="Admin authentication token")


def check_rate_limit(ip: str, endpoint: str, limit: int = 100, window: int = 3600) -> bool:
    """
    Rate limiting: 100 requests per hour per IP per endpoint
    Returns True if within limit, False if exceeded
    """
    key = f"{ip}:{endpoint}"
    now = int(time.time())
    window_start = now - window

    # Get current request timestamps
    timestamps = rate_limit_store.get(key, [])

    # Filter to current window
    timestamps = [ts for ts in timestamps if ts > window_start]

    # Check limit
    if len(timestamps) >= limit:
        return False

    # Add current request
    timestamps.append(now)
    rate_limit_store[key] = timestamps

    return True


def verify_plgn_client(user_agent: Optional[str]) -> bool:
    """
    Verify request is from PLGN CLI (basic check)
    More sophisticated verification could use HMAC signatures
    """
    if not user_agent:
        return False

    # Check for PLGN CLI user agent
    return "plgn/" in user_agent.lower() or "plgn-cli" in user_agent.lower()


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("plgn-secrets"),  # GITHUB_TOKEN, NIA_API_KEY, ADMIN_TOKEN
    ],
    timeout=60,
    memory=512
)
@modal.asgi_app()
def proxy_app():
    """FastAPI proxy for PLGN registry operations"""
    from github import Github
    import httpx

    api = FastAPI(
        title="PLGN Registry Proxy",
        description="Secure proxy for PLGN pack registry and semantic search",
        version="1.0.0"
    )

    # CORS for web clients (optional)
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Restrict in production
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @api.get("/")
    async def root():
        """Health check"""
        return {
            "service": "plgn-registry-proxy",
            "status": "healthy",
            "version": "1.0.0"
        }

    @api.get("/registry/index")
    async def get_registry_index(
        request: Request,
        user_agent: Optional[str] = Header(None)
    ):
        """
        Fetch registry index from GitHub (read-only)
        Public endpoint with rate limiting
        """
        client_ip = request.client.host

        # Verify client
        if not verify_plgn_client(user_agent):
            raise HTTPException(status_code=403, detail="Invalid client")

        # Rate limit
        if not check_rate_limit(client_ip, "registry_index", limit=100):
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

        try:
            # Use org GitHub token (read-only)
            github_token = os.environ.get("GITHUB_TOKEN")
            if not github_token:
                raise HTTPException(status_code=500, detail="Server configuration error")

            g = Github(github_token)
            repo = g.get_repo("PR0TO-IDE/plgn-registry")

            try:
                content = repo.get_contents("registry.json")
                import json
                import base64

                registry_data = json.loads(base64.b64decode(content.content).decode('utf-8'))

                return {
                    "entries": registry_data,
                    "cached_at": datetime.utcnow().isoformat()
                }
            except Exception:
                # Registry doesn't exist yet
                return {
                    "entries": [],
                    "cached_at": datetime.utcnow().isoformat()
                }

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to fetch registry: {str(e)}")

    @api.post("/semantic/search")
    async def semantic_search(
        req: SemanticSearchRequest,
        request: Request,
        user_agent: Optional[str] = Header(None)
    ):
        """
        Semantic search via Nia (proxied for security)
        Public endpoint with rate limiting
        """
        client_ip = request.client.host

        # Verify client
        if not verify_plgn_client(user_agent):
            raise HTTPException(status_code=403, detail="Invalid client")

        # Rate limit
        if not check_rate_limit(client_ip, "semantic_search", limit=50):
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

        try:
            nia_api_key = os.environ.get("NIA_API_KEY")
            nia_url = os.environ.get("NIA_API_URL", "https://apigcp.trynia.ai/")

            if not nia_api_key:
                raise HTTPException(status_code=503, detail="Semantic search unavailable")

            # Make request to Nia
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{nia_url}/search",
                    json={
                        "query": req.query,
                        "languages": req.languages,
                        "limit": req.limit
                    },
                    headers={"Authorization": f"Bearer {nia_api_key}"},
                    timeout=10.0
                )

                if response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, detail="Nia search failed")

                return response.json()

        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Nia service error: {str(e)}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

    @api.post("/registry/update")
    async def update_registry_index(
        req: PublishIndexRequest,
        request: Request,
        user_agent: Optional[str] = Header(None)
    ):
        """
        Update registry index (admin only)
        Requires admin token for authentication
        """
        client_ip = request.client.host

        # Verify client
        if not verify_plgn_client(user_agent):
            raise HTTPException(status_code=403, detail="Invalid client")

        # Verify admin token
        admin_token = os.environ.get("ADMIN_TOKEN")
        if not admin_token or req.admin_token != admin_token:
            raise HTTPException(status_code=403, detail="Unauthorized")

        # Rate limit (stricter for write operations)
        if not check_rate_limit(client_ip, "registry_update", limit=10):
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

        try:
            github_token = os.environ.get("GITHUB_TOKEN")
            if not github_token:
                raise HTTPException(status_code=500, detail="Server configuration error")

            g = Github(github_token)
            repo = g.get_repo("PR0TO-IDE/plgn-registry")

            import json
            content_str = json.dumps(req.entries, indent=2)

            try:
                # Get existing file
                existing = repo.get_contents("registry.json")
                repo.update_file(
                    "registry.json",
                    req.message,
                    content_str,
                    existing.sha
                )
            except Exception:
                # File doesn't exist, create it
                repo.create_file(
                    "registry.json",
                    req.message,
                    content_str
                )

            return {"status": "success", "message": "Registry updated"}

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to update registry: {str(e)}")

    return api
