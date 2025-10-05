# plgin Registry Setup

## GitHub Repository

**Repository**: `PR0TO-IDE/plgin-registry` (Private)
**URL**: https://github.com/PR0TO-IDE/plgin-registry
**Status**: ✅ Initialized and ready

## Structure

```
plgin-registry/
├── index.json          # Main registry index
├── packs/              # Published pack tarballs
│   └── README.md
└── README.md           # Registry documentation
```

## Registry Schema

### index.json
```json
{
  "version": "1.0.0",
  "updated_at": "ISO-8601 timestamp",
  "entries": [
    {
      "name": "pack-name",
      "version": "1.0.0",
      "description": "Pack description",
      "languages": ["typescript", "javascript"],
      "frameworks": ["react"],
      "author": "username",
      "published_at": "ISO-8601 timestamp",
      "semantic_tags": {
        "architecture": ["patterns", "styles"],
        "patterns": ["code patterns"],
        "ui_ux": ["components"],
        "components": ["modules"],
        "dependencies": ["packages"],
        "conventions": ["naming"],
        "features": ["capabilities"]
      },
      "tarball_url": "https://github.com/PR0TO-IDE/plgin-registry/raw/main/packs/pack-name-1.0.0.tgz",
      "checksum": "sha256-hash"
    }
  ]
}
```

## Modal Proxy Requirements

The Modal proxy needs to:

1. **Read Registry** (`GET /registry/index`):
   - Fetch `index.json` from GitHub via authenticated API
   - GitHub API endpoint: `GET /repos/PR0TO-IDE/plgin-registry/contents/index.json`
   - Parse base64 content and return as JSON
   - Cache for performance (15 min recommended)

2. **Publish Pack** (`POST /registry/publish`):
   - Accept pack metadata + tarball (base64)
   - Validate pack structure
   - Create new entry in `index.json`
   - Upload tarball to `packs/` directory
   - Commit changes to GitHub
   - Return success with URLs

### Environment Variables for Modal

```python
GITHUB_TOKEN=ghp_...  # GitHub PAT with repo scope
GITHUB_ORG=PR0TO-IDE
GITHUB_REPO=plgin-registry
```

### GitHub API Access Pattern

```python
import base64
from github import Github

g = Github(GITHUB_TOKEN)
repo = g.get_repo(f"{GITHUB_ORG}/{GITHUB_REPO}")

# Read index.json
contents = repo.get_contents("index.json")
index_data = json.loads(base64.b64decode(contents.content))

# Update index.json
repo.update_file(
    "index.json",
    "Add pack-name@1.0.0",
    json.dumps(updated_index, indent=2),
    contents.sha
)

# Upload tarball
repo.create_file(
    f"packs/{pack_name}-{version}.tgz",
    f"Publish {pack_name}@{version}",
    tarball_bytes
)
```

## Testing the Registry

### Test Read Access
```bash
gh api repos/PR0TO-IDE/plgin-registry/contents/index.json --jq '.content' | base64 -d
```

### Expected Output
```json
{
  "version": "1.0.0",
  "updated_at": "2025-10-05T21:32:00Z",
  "entries": []
}
```

## CLI Integration

The plgin CLI expects:

1. **Discovery** (`plgin discover`):
   - Calls `GET [proxy]/registry/index`
   - Filters entries by language/query
   - Uses Nia MCP for semantic ranking

2. **Publishing** (`plgin publish`):
   - Calls `POST [proxy]/registry/publish`
   - Payload includes `semantic_tags`
   - Expects: `{status, url, version, checksum, downloadUrl}`

## Security

- ✅ Repository is **private** (not publicly accessible)
- ✅ Access only via authenticated Modal proxy
- ✅ GitHub token stored securely in Modal secrets
- ✅ Rate limiting on proxy endpoints (100 req/hr read, 10 req/hr write)

## Status

- ✅ Repository created
- ✅ Initial structure committed
- ✅ Schema documented
- ⏳ Modal proxy needs updating to use this repo
- ⏳ Test publish/discover flow end-to-end
