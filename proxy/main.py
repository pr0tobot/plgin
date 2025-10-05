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
        "python-dotenv>=1.0.0",
        "requests>=2.31.0"
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

class PublishPackRequest(BaseModel):
    """Request to publish a pack"""
    name: str = Field(..., description="Pack name")
    version: str = Field(..., description="Pack version (semver)")
    languages: List[str] = Field(..., description="Supported languages")
    description: str = Field(..., description="Pack description")
    tarball_base64: str = Field(..., description="Base64-encoded tarball")
    author: str = Field(default="community", description="Author name")


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

    @api.post("/registry/publish")
    async def publish_pack(
        req: PublishPackRequest,
        request: Request,
        user_agent: Optional[str] = Header(None)
    ):
        """
        Publish a pack to the registry
        No auth required (rate-limited to 10 req/hr per IP)
        """
        client_ip = request.client.host

        # Verify client
        if not verify_plgn_client(user_agent):
            raise HTTPException(status_code=403, detail="Invalid client")

        # Rate limit (strict for publishing)
        if not check_rate_limit(client_ip, "registry_publish", limit=10):
            raise HTTPException(status_code=429, detail="Rate limit exceeded (10 publishes/hour)")

        try:
            import base64
            import hashlib
            from github import Github
            import json

            # Decode tarball
            try:
                tarball_bytes = base64.b64decode(req.tarball_base64)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid base64 tarball")

            # Compute checksum
            checksum = hashlib.sha256(tarball_bytes).hexdigest()

            # Use org GitHub token
            github_token = os.environ.get("GITHUB_TOKEN")
            if not github_token:
                raise HTTPException(status_code=500, detail="Server configuration error")

            g = Github(github_token)
            repo = g.get_repo("PR0TO-IDE/plgn-registry")

            # Create release
            tag_name = f"{req.name}@{req.version}"
            try:
                release = repo.create_git_release(
                    tag=tag_name,
                    name=f"{req.name} v{req.version}",
                    message=f"Pack release for {req.name} v{req.version}\n\nChecksum (SHA256): `{checksum}`\nAuthor: {req.author}"
                )
            except Exception as e:
                # Release might already exist
                if "already_exists" in str(e).lower() or "already exists" in str(e).lower():
                    raise HTTPException(status_code=409, detail=f"Release {tag_name} already exists")
                raise

            # Upload tarball as release asset
            filename = f"{req.name}-{req.version}.tgz"
            try:
                asset = release.upload_asset(
                    path="",  # Not used when content_type is provided
                    label=filename,
                    content_type="application/gzip",
                    name=filename
                )
                # PyGithub doesn't support direct bytes upload well, use requests
                import requests
                upload_url = release.upload_url.replace("{?name,label}", f"?name={filename}")
                headers = {
                    "Authorization": f"token {github_token}",
                    "Content-Type": "application/gzip"
                }
                upload_response = requests.post(upload_url, headers=headers, data=tarball_bytes)

                if upload_response.status_code not in [200, 201]:
                    raise Exception(f"Asset upload failed: {upload_response.text}")

                asset_data = upload_response.json()
                download_url = asset_data["browser_download_url"]
            except Exception as e:
                # Clean up release if asset upload fails
                try:
                    release.delete_release()
                except:
                    pass
                raise HTTPException(status_code=500, detail=f"Failed to upload asset: {str(e)}")

            # Update registry.json
            try:
                # Get current registry
                try:
                    content = repo.get_contents("registry.json")
                    entries = json.loads(base64.b64decode(content.content).decode('utf-8'))
                    registry_sha = content.sha
                except Exception:
                    entries = []
                    registry_sha = None

                # Create new entry
                new_entry = {
                    "name": req.name,
                    "version": req.version,
                    "languages": req.languages,
                    "description": req.description,
                    "downloadUrl": download_url,
                    "checksum": checksum,
                    "publishedAt": datetime.utcnow().isoformat() + "Z",
                    "author": req.author
                }

                # Check if pack version already exists
                existing_index = next(
                    (i for i, e in enumerate(entries) if e.get("name") == req.name and e.get("version") == req.version),
                    None
                )

                if existing_index is not None:
                    entries[existing_index] = new_entry
                else:
                    entries.append(new_entry)

                # Update registry.json
                content_str = json.dumps(entries, indent=2)
                if registry_sha:
                    repo.update_file(
                        "registry.json",
                        f"Publish {req.name}@{req.version}",
                        content_str,
                        registry_sha
                    )
                else:
                    repo.create_file(
                        "registry.json",
                        f"Publish {req.name}@{req.version}",
                        content_str
                    )

            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to update registry: {str(e)}")

            return {
                "status": "success",
                "url": release.html_url,
                "version": req.version,
                "checksum": checksum,
                "downloadUrl": download_url
            }

        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Publish failed: {str(e)}")

    return api
