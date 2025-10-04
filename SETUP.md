# PLGN Setup & Usage Guide

## Quick Start

### 1. Set Up API Key

The PLGN CLI uses OpenRouter (or xAI) for AI-powered feature extraction and integration. You'll need an API key:

```bash
export OPENROUTER_API_KEY="your-api-key-here"
# OR
export PLGN_API_KEY="your-api-key-here"
```

Get your key from:
- OpenRouter: https://openrouter.ai/keys
- xAI (alternative): https://x.ai/api

### 2. Build the CLI

```bash
npm install
npm run build
```

### 3. Configure PLGN (Optional)

```bash
node dist/index.js config --provider openrouter --model z-ai/glm-4.6 --api-key YOUR_KEY
```

Available providers: `openrouter`, `xai`, `anthropic`
Default model: `z-ai/glm-4.6` (via OpenRouter)

## Basic Usage

### Extract a Feature Pack from Existing Code

```bash
node dist/index.js create ./path/to/feature --name my-feature --lang typescript
```

### Create a Pack from an AI Prompt (Agentic)

```bash
node dist/index.js create --prompt "Build a rate limiter for APIs" --name rate-limiter --lang typescript --agentic
```

### Discover Available Packs

```bash
node dist/index.js discover --language python
```

### Check Pack Compatibility

```bash
node dist/index.js check my-pack@1.0.0 --target-lang java
```

### Integrate a Pack into Your Project

```bash
node dist/index.js add my-pack@1.0.0 --instructions "use PostgreSQL" --dry-run
```

### Publish a Pack

```bash
node dist/index.js publish ./packs/my-pack
```

## Production Quality Features

### ✅ Real AI Integration
- **OpenRouter SDK**: Full integration with OpenAI-compatible API
- **Model Support**: glm-4.6, grok-4-fast, or any OpenRouter model
- **Provider Flexibility**: Switch between OpenRouter, xAI, Anthropic
- **Intelligent Prompting**: Structured prompts for extraction, adaptation, implementation
- **Robust Error Handling**: Graceful fallbacks when AI calls fail

### ✅ Language Agnostic
- Auto-detects languages from file extensions
- Supports JavaScript, TypeScript, Python, Java, Kotlin, Go, Rust, Ruby
- Cross-language adaptation (e.g., Python → Java)
- Language-specific code generation with proper conventions

### ✅ Security
- **AI-Powered Vuln Scanning**: Uses LLM to identify security issues
- **Pattern-Based Fallback**: Regex patterns for eval, hardcoded credentials
- **Severity Classification**: Critical, high, medium, low
- **Remediation Suggestions**: Actionable security fixes

### ✅ Caching
- 10-minute TTL cache for AI responses
- Base64URL key hashing for filesystem safety
- Reduces API costs and improves speed
- Cache invalidation on expiry

### ✅ Production Code Quality
- Full TypeScript strict mode
- Comprehensive error handling
- No placeholder/fake implementations
- ESM module support
- Clean, maintainable architecture

## Architecture Highlights

### Agent System
- `HybridAgent` class implements full `PLGNAgent` interface
- Real OpenAI SDK client initialization with proper base URLs
- Structured JSON responses from AI with fallback parsing
- Confidence scoring for AI outputs

### Pack Structure
```
pack-name/
  manifest.json       # Pack metadata
  /source/           # Multi-language source examples
    typescript/
    python/
    java/
  /patterns/         # Extracted patterns for AI
  /agents/          # AI agent prompts
  /tests/           # Test examples
  /generated/       # Agentic implementations (if created from prompt)
```

### Real AI Methods
1. **extractFeature**: Reads code, calls AI to analyze metadata, generates pack
2. **adaptPack**: Takes source code samples, prompts AI to adapt for target project
3. **implementFeature**: Full agentic code generation from semantic description
4. **scanForVulns**: AI-based security scanning with pattern fallback
5. **planImplementation**: Creates step-by-step implementation plans

## Testing

### Run All Tests
```bash
npm test
```

### Test Coverage
- ✅ Agent configuration and initialization
- ✅ Feature extraction with real file I/O
- ✅ Confidence scoring
- ✅ Vulnerability scanning (pattern-based works without API key)
- ✅ Pack creation from source
- ✅ Agentic pack generation
- ✅ Compatibility checking
- ✅ Pack integration
- ✅ Registry publishing and discovery
- ✅ Multi-language support
- ✅ Caching behavior

**Note**: Tests requiring AI (extraction, adaptation) will fail without a valid API key. Tests for basic operations (config, registry, security patterns) pass without API access.

## Environment Variables

```bash
# Primary API key
OPENROUTER_API_KEY=sk-or-...

# Alternative keys
PLGN_API_KEY=...
PLGN_XAI_API_KEY=...

# Config location
HOME=~  # Config stored in ~/.plgn/
```

## Example Workflow

```bash
# 1. Configure with your API key
export OPENROUTER_API_KEY="sk-or-v1-..."

# 2. Extract feature from existing codebase
node dist/index.js create ./src/auth --name auth-system --lang typescript

# 3. Publish to local registry
node dist/index.js publish ./packs/auth-system

# 4. In another project, discover and integrate
cd ~/other-project
node dist/index.js discover --language typescript
node dist/index.js add auth-system@1.0.0 --instructions "use JWT tokens"

# 5. Or create from scratch with AI
node dist/index.js create --prompt "OAuth2 flow with refresh tokens" \
  --name oauth2-pack --lang python --agentic
```

## Next Steps

1. Set your API key
2. Run `npm run build`
3. Try `node dist/index.js create --help`
4. Extract your first pack!

## Cost Optimization

- Enable caching (enabled by default, 10min TTL)
- Use lower temperature for deterministic tasks (extraction: 0.1, adaptation: 0.3)
- Limit code samples to first 10 files for large codebases
- Choose efficient models (glm-4.6 is cost-effective via OpenRouter)

## Troubleshooting

**401 Auth Error**: Set `OPENROUTER_API_KEY` or `PLGN_API_KEY`
**TypeScript Errors**: Run `npm run clean && npm run build`
**Test Failures**: Expected without API key for AI-dependent tests
**Module Not Found**: Ensure you ran `npm install`
