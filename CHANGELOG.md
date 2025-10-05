# Changelog

## [2.0.4] - 2025-10-05

### Fixed
- Similarity check 500 error during publish by implementing robust Jaccard similarity fallback (no external embeddings required)
- Improved CLI error handling to parse and display JSON error details from proxy responses

## [2.0.3] - 2025-10-05

### Added
- Dynamic pack naming to prevent duplicates by appending UUID suffix if name conflicts with existing registry packs
- Semantic similarity check during publish: blocks packs with >98% similarity to existing packs based on description and tags using OpenRouter embeddings
- Apply command now supports downloading packs directly from the registry (requires GITHUB_TOKEN for private repos)
- Enhanced error handling for registry downloads with optional GitHub authentication

### Fixed
- Pack download from private GitHub releases now uses GitHub token if available
- User-Agent updated to plgin-cli/2.0.3 across all requests

### Improved
- Similarity check integrates with proxy endpoint for secure embedding computation
- Better logging for similarity scores and name conflicts during publish

## [2.0.2] - Previous release
- Initial production release with semantic feature extraction
- Fast mode default, --detailed flag for comprehensive analysis
- Dynamic semantic tag generation via AI
- Modal proxy for private registry operations
- npm unscoped package naming

[Unreleased]
- Your next features here