
<img width="4096" height="2192" alt="4779A80B-BB3B-407B-97A0-0FEF6C30F41E" src="https://github.com/user-attachments/assets/562df85f-236b-41a0-a454-39d4aceb5b0d" />

[![npm version](https://img.shields.io/npm/v/plgin.svg)](https://www.npmjs.com/package/plgin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/node/v/plgin.svg)](https://www.npmjs.com/package/plgin)

Semantic feature extraction and integration across any programming language.

**plgin** extracts code features from any codebase and makes them discoverable and reusable through semantic understanding. Using vector embeddings, it enables intelligent feature discovery, compatibility assessment, and context-aware code integration—all without manual translation.

## Features

- 🔍 **Semantic Discovery** - Find compatible features using embedding-based search
- 🌐 **Language-Agnostic** - Works with TypeScript, Python, Go, Rust, and any programming language
- 🎯 **Intelligent Matching** - Vector similarity scoring for compatibility assessment
- 🔒 **Secure** - Built-in vulnerability scanning with configurable scanners
- ⚡ **Fast by Default** - Optimized semantic hints and efficient operations
- 🚀 **Zero-Config Discovery** - Managed semantic search with no setup required

## Installation

```bash
npm install -g plgin
```

**Requirements:**
- Node.js 18 or higher
- OpenRouter API key (for code generation and adaptation)

## Quick Start

1. **Set your API key** in `.env` or `.env.local`:
   ```bash
   OPENROUTER_API_KEY=sk-or-...
   ```

2. **Create a feature pack from your code:**
   ```bash
   plgin create ./src/auth --name auth-system
   ```

3. **Or create from natural language:**
   ```bash
   plgin create "user authentication with JWT" --name jwt-auth
   ```

4. **Discover compatible packs:**
   ```bash
   plgin discover --query "authentication"
   ```

5. **Apply a feature to your project:**
   ```bash
   plgin apply auth-system
   ```

6. **Publish your pack:**
   ```bash
   plgin publish ./packs/auth-system
   ```

## Usage

### Creating Feature Packs

Extract reusable features from your codebase:

```bash
# Extract from a specific file or directory
plgin create ./src/components/Hero.tsx --lang typescript

# Create from current directory
plgin create --name my-feature

# Generate from natural language (agentic mode)
plgin create "REST API with rate limiting" --agentic

# Use detailed mode for comprehensive analysis
plgin create ./src/utils --detailed
```

### Discovering Packs

Find compatible feature packs using semantic search:

```bash
# Search by description
plgin discover --query "react components"

# Filter by programming language
plgin discover --lang typescript

# Combine query and language
plgin discover --query "authentication" --lang python
```

### Checking Compatibility

Analyze pack compatibility with your project:

```bash
plgin check ./packs/hero-component --lang typescript
```

### Applying Packs

Integrate feature packs into your project:

```bash
# Preview changes without applying
plgin apply hero-component --dry-run

# Apply with custom instructions
plgin apply auth-pack --instructions "Use bcrypt for password hashing"

# Use detailed mode for thorough integration
plgin apply ui-library --detailed
```

### Publishing Packs

Share your feature packs with others:

```bash
plgin publish ./packs/my-feature
```

## CLI Reference

### `plgin create [input] [options]`

Create a feature pack from code, a prompt, or the current directory.

**Arguments:**
- `input` - (Optional) Path to code, natural language prompt, or omit to use current directory

**Options:**
- `--name <name>` - Specify pack name
- `--lang <language>` - Target programming language
- `--agentic` - Enable autonomous code generation mode
- `--out-dir <path>` - Output directory (default: `packs`)
- `--detailed` - Use comprehensive analysis (slower, more thorough)
- `--verbose` - Show detailed operation logs

**Examples:**
```bash
# Create from current directory (fast mode by default)
plgin create --name my-feature

# Create from code path
plgin create ./src/editor --lang typescript

# Create from natural language
plgin create "dark mode toggle component" --agentic

# Use detailed mode for complex features
plgin create ./src/api --detailed
```

---

### `plgin discover [options]`

Discover compatible packs using semantic search.

**Options:**
- `--query <query>` - Search query
- `--lang <language>` - Target language filter
- `--registry <url>` - Custom registry endpoint

**Examples:**
```bash
plgin discover --query "react components"
plgin discover --lang typescript
plgin discover --query "authentication" --lang python
```

---

### `plgin check <packRef> [options]`

Analyze pack compatibility with your current project.

**Arguments:**
- `packRef` - Path to pack or pack name

**Options:**
- `--lang <language>` - Target language override

**Example:**
```bash
plgin check ./packs/hero-component --lang typescript
```

---

### `plgin apply <packRef> [options]`

Apply a pack into the current project. (Alias: `add` for backward compatibility)

**Arguments:**
- `packRef` - Path to pack or pack name

**Options:**
- `--instructions <text>` - Custom integration instructions
- `--dry-run` - Preview without writing changes
- `--lang <language>` - Target language override
- `--detailed` - Use comprehensive analysis
- `--verbose` - Show detailed integration logs

**Examples:**
```bash
# Preview integration
plgin apply hero-component --dry-run

# Apply with custom instructions
plgin apply auth-pack --instructions "Use async/await syntax"

# Backward compatible alias
plgin add ui-components --dry-run
```

---

### `plgin publish <path> [options]`

Publish a pack to the registry.

**Arguments:**
- `path` - Path to pack directory

**Options:**
- `--registry <url>` - Target registry endpoint

**Example:**
```bash
plgin publish ./packs/my-feature
```

---

### `plgin config [options]`

Configure defaults and credentials.

**Options:**
- `--show` - Display current configuration
- `--provider <provider>` - Set provider (`openrouter`, `xai`, `anthropic`, `custom`)
- `--model <model>` - Set default model
- `--temperature <value>` - Set temperature (0-1)
- `--language <language>` - Set default language
- `--security-scanner <scanner>` - Set scanner (`snyk`, `trivy`, `custom`, `none`)

**Examples:**
```bash
# Show current config
plgin config --show

# Update settings
plgin config --provider openrouter --model z-ai/glm-4.6
```

---

### `plgin status`

Show workspace status, cache information, and configuration.

```bash
plgin status
```

---

### `plgin clean [options]`

Clean cache and preview directories.

**Options:**
- `--cache` - Clean cache only
- `--previews` - Clean previews only

**Examples:**
```bash
# Clean both cache and previews
plgin clean

# Clean cache only
plgin clean --cache
```

## Configuration

Configure plgin using environment variables or the CLI:

```bash
plgin config --provider openrouter --model z-ai/glm-4.6 --show
```

### Environment Variables

Place these in `.env` or `.env.local` in your project root or `~/.plgin/`:

- `OPENROUTER_API_KEY` - **Required** for code generation and adaptation

### Default Settings

- **Provider**: OpenRouter
- **Model**: `z-ai/glm-4.6` (configurable)
- **Semantic Discovery**: Enabled by default (managed embeddings service)
- **Language Detection**: Automatic (override with `--lang`)
- **Security Scanning**: Enabled by default
- **Operation Mode**: Fast by default (use `--detailed` for comprehensive analysis)

### Configuration File

Config is stored in `~/.plgin/config.json`. You can also use project-specific config in `.plgin/config.json`.

## How It Works

plgin uses vector embeddings to create semantic representations of code features. When you create a feature pack, the code is analyzed and converted into dense vectors that capture its semantic meaning. During discovery, your project's context is similarly embedded, and plgin uses cosine similarity to rank compatible feature packs.

This embedding-based approach enables:
- **Cross-language feature matching** - Find equivalent patterns across languages
- **Context-aware code adaptation** - Intelligently adapt features to your project
- **Semantic search without keywords** - Discover features by concept, not exact terms
- **Similarity scoring** - Quantify compatibility between features and projects

### Semantic Tagging

Feature packs are automatically tagged with semantic metadata:
- **Architecture**: Design patterns, architectural styles
- **UI/UX**: Interface components, design systems
- **Patterns**: Code patterns, idioms, best practices
- **Components**: Reusable modules, functions, classes
- **Dependencies**: Required packages, frameworks
- **Conventions**: Naming conventions, code style
- **Features**: Capabilities provided by the pack

These tags enhance discoverability through embedding-based search.

## Examples

### Extract a React Component

```bash
plgin create ./src/components/Button.tsx --name button-component
```

This creates a feature pack with:
- Source code and dependencies
- Semantic tags (React, component, UI)
- Language and framework requirements
- Adaptation strategy for other projects

### Create from Natural Language

```bash
plgin create "middleware for request logging" --lang typescript --agentic
```

plgin will:
1. Generate the feature implementation
2. Create tests and documentation
3. Package it as a reusable pack
4. Tag it with semantic metadata

### Discover and Apply

```bash
# Find authentication features
plgin discover --query "JWT authentication middleware"

# Check compatibility
plgin check auth-middleware --lang typescript

# Preview integration
plgin apply auth-middleware --dry-run

# Apply to your project
plgin apply auth-middleware
```

## Security

plgin includes built-in vulnerability scanning. Each pack is scanned for:
- Hardcoded credentials
- Injection vulnerabilities
- Insecure dependencies
- Common security anti-patterns

Results are displayed during integration:

```
Security findings:
  PLGIN-XXX-001 (medium) - Potential XSS via Dynamic Content
  PLGIN-XXX-002 (low) - Missing Input Validation
```

## Fast vs Detailed Mode

By default, plgin operates in **fast mode** for optimal performance:
- Prioritizes key files based on semantic relevance
- Uses fewer AI iterations for quicker results
- Leverages semantic hints for smarter decisions
- Suitable for most use cases

Use **detailed mode** (`--detailed`) when you need:
- Exhaustive analysis of large codebases
- Maximum accuracy for complex features
- Comprehensive dependency tracking

```bash
# Fast mode (default)
plgin create ./src/components

# Detailed mode
plgin create ./src/components --detailed
```

## Troubleshooting

### Authentication Error

```
Error: Please ensure OPENROUTER_API_KEY is set in your environment
```

**Solution**: Add `OPENROUTER_API_KEY=sk-or-...` to `.env` or `.env.local` in your project root.

### Empty Discovery Results

```
No packs matched.
```

**Solution**: The registry may be empty or your query is too specific. Try broader terms or check your language filter.

### JSON Parse Error

```
AI provider returned malformed response
```

**Solution**: This is usually a temporary API issue. Wait a moment and try again.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT © pr0tobot

---

**Made with semantic understanding** 🔍
