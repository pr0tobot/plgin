# plgin v2.0.3 Release Notes

## 🎉 Major Features

### Semantic Duplicate Prevention
- **Similarity Check Before Publishing**: Automatically checks if new packs are >98% similar to existing packs in the registry
- **Dynamic Semantic Tags**: AI-generated tags during pack creation (not hardcoded)
- **Jaccard Similarity Algorithm**: Fallback similarity detection using word overlap analysis
- **Clear Error Messages**: Tells you which pack is too similar and shows the similarity score

### Registry Download Support
- **Apply Packs from Registry**: Use `plgin apply <pack-name>` to download and apply packs directly from the registry
- **Automatic Version Resolution**: Downloads latest version if no version specified
- **Public Registry**: plgin-registry is now public for seamless downloads without authentication

### Fast Mode by Default
- **Fast Mode is Default**: Quick semantic analysis is now the default behavior
- **New `--detailed` Flag**: Use `--detailed` for comprehensive analysis (previously the default)
- **Better UX**: Faster pack creation and integration workflows

## 🔧 Improvements

### Proxy Endpoints
- **`POST /registry/similarity`**: Check semantic similarity before publishing
- **`GET /registry/download/{pack_name}`**: Get pack metadata and download URL
- **Rate Limiting**: 100 req/hr for reads, 10 req/hr for publishes
- **User-Agent Verification**: Ensures requests come from plgin CLI

### CLI Enhancements
- **Better Error Handling**: `safeJSONParse` helper for graceful JSON parsing failures
- **Enhanced Error Messages**: Authentication and API errors provide actionable guidance
- **Tarball Extraction Fix**: Fixed tar extraction for registry downloads
- **Version Consistency**: All endpoints use `plgin-cli/2.0.3` User-Agent

### Security & Reliability
- **No Secrets in Packs**: Validated that pack creation never includes .env files or secrets
- **Public Registry**: Safe to make public as packs contain only code, not credentials
- **SHA256 Checksums**: All published packs include checksums for verification

## 📋 Testing Results

### End-to-End Validation
✅ **Create**: Dynamic semantic tag generation working
✅ **Publish**: Similarity check blocks >98% duplicates
✅ **Discover**: Semantic search returns relevant packs
✅ **Apply**: Downloads from registry and integrates successfully

### Example Tests
```bash
# Test 1: Duplicate Prevention
$ plgin publish hero-component
✖ Pack too similar to existing pack "hero-component" (similarity score: 1.000)

# Test 2: Semantic Discovery
$ plgin discover --query "react components"
hero-component@0.1.0 - Full-screen hero banner component
netflix-header@0.1.0 - Fixed header with navigation menu

# Test 3: Registry Download
$ plgin apply netflix-header --dry-run
✔ Integration prepared with confidence 90.0%
```

## 🐛 Bug Fixes
- Fixed tar extraction to work without file filter argument
- Fixed proxy async function scoping issues
- Fixed release creation with proper tag naming (`name-version` instead of `name@version`)
- Updated all User-Agent strings to consistent version

## 📦 Package Details
- **Package Name**: `plgin` (unscoped for professional appearance)
- **Version**: 2.0.3
- **npm**: https://www.npmjs.com/package/plgin
- **GitHub**: https://github.com/PR0TO-IDE/plgin
- **Registry**: https://github.com/PR0TO-IDE/plgin-registry

## 🚀 Upgrade Guide

### From v2.0.2 → v2.0.3
```bash
npm install -g plgin@latest
```

**Breaking Changes**: None

**New Behavior**:
- Fast mode is now default (use `--detailed` for old behavior)
- Duplicate packs will be rejected during publish
- Registry packs can now be applied directly by name

## 📚 Documentation Updates
- README now uses "semantic" terminology instead of "AI-powered"
- Added troubleshooting section for common errors
- Updated CLI reference with new flags
- Documented similarity check threshold

## 🙏 Credits
Built with Claude Code and powered by:
- **Nia AI** for semantic search capabilities
- **OpenRouter** for LLM inference
- **Modal** for serverless proxy deployment
- **GitHub Releases** for pack distribution

---

**Full Changelog**: https://github.com/PR0TO-IDE/plgin/compare/v2.0.2...v2.0.3
