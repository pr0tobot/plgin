# PLGN

AI-powered feature extraction and integration for any programming language.

## Installation

```bash
npm install -g @pr0tobot/plgn
```

## Quick Start

Set your OpenRouter API key:
```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Create a feature pack from a prompt:
```bash
plgn create "Build a user authentication system"
```

Or extract from existing code:
```bash
plgn create ./src/auth --name auth-pack
```

## Commands

- **`plgn create [input]`** - Create a pack from code path, prompt, or current directory
- **`plgn config`** - Configure AI provider, model, and settings
- **`plgn discover`** - Find compatible packs for your project
- **`plgn check <pack>`** - Analyze pack compatibility
- **`plgn add <pack>`** - Integrate a pack into your project
- **`plgn publish <path>`** - Publish a pack to the registry

## Configuration

```bash
plgn config --provider openrouter --model z-ai/glm-4.6 --show
```

Default config:
- Provider: OpenRouter
- Model: `z-ai/glm-4.6`
- Language: Auto-detect
- Security: Vulnerability scanning enabled
- Semantic discovery: Nia MCP contexts (disable with `plgn config --semantic-provider disabled`)

### Semantic Discovery (Nia MCP)

PLGN can enrich discovery and integration with semantic search powered by Nia MCP contexts.

Configure the credentials (already supported via `.env.local`):

```bash
export NIA_API_KEY="nk-..."
export NIA_API_URL="https://apigcp.trynia.ai/"
```

When enabled, `plgn publish` automatically indexes packs into Nia contexts, and `plgn discover` ranks results using semantic similarity plus language filters.

## Features

- **Language-agnostic**: Works with any programming language
- **AI-powered**: Uses advanced LLMs for intelligent code generation and adaptation
- **Secure**: Built-in vulnerability scanning
- **Flexible**: Agentic mode for full feature implementation or code-based extraction

## Options

```bash
plgn create [input] [options]

Options:
  --name <name>        Pack name
  --lang <language>    Target language
  --verbose           Show detailed logs
  --timeout <ms>      Operation timeout
  --agentic          Enable AI-powered mode
```

## Examples

Infer from current directory:
```bash
plgn create --name my-feature
```

Create from path with language hint:
```bash
plgn create ./src/editor --lang typescript --verbose
```

Create from natural language:
```bash
plgn create "REST API with JWT authentication" --name api-auth
```

## License

MIT
