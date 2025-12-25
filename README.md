# Internet Offline (IOL)

Reconstruct the web from memory. IOL is a local, offline web server that uses a local LLM to rebuild requested pages on the fly, complete with layout, typography, and dense content. Every click and search stays inside IOL and triggers a new offline reconstruction.

## Highlights

- Offline-only page reconstruction using a local model (Ollama)
- Link and form interception keeps navigation inside IOL
- Disk cache prevents re-generation for previously visited pages
- Single transparent placeholder image for all assets
- Clean, simple server with zero front-end dependencies

## How It Works

1. You request a URL in the IOL UI.
2. IOL shows a loading page and calls the local LLM.
3. The LLM returns a full HTML document constructed from memory.
4. IOL injects a navigation script to intercept links and forms.
5. The page is cached on disk for instant reuse.

## Requirements

- Node.js 18+ (for built-in fetch)
- Ollama running locally
- The model `gpt-oss:20b` (or set `OLLAMA_MODEL`)

## Setup

```bash
npm install
```

Ensure Ollama is running and the model is available:

```bash
ollama run gpt-oss:20b
```

## Run

```bash
npm start
```

Open `http://localhost:3000` and enter any URL.

## Environment Variables

- `OLLAMA_MODEL` (default: `gpt-oss:20b`)
- `OLLAMA_URL` (default: `http://localhost:11434/api/chat`)
- `PORT` (default: `3000`)

## Cache

- HTML is cached in `cache/` using a SHA-256 hash of the URL.
- The model, URL, and timestamp are stored alongside the HTML.
- Delete a file in `cache/` to force regeneration.

## Offline Safety

IOL never fetches external resources. The prompt forbids external CSS/JS and inline event handlers. Navigation is handled by IOL and routed through `/navigate` and `/page`.

## Project Layout

- `server.js` - Express server, LLM prompt, caching, navigation injection
- `public/img/blank.png` - Transparent placeholder image
- `cache/` - Generated HTML and metadata

## Troubleshooting

- If generation fails, confirm Ollama is running at `OLLAMA_URL`.
- If pages look outdated, delete the corresponding cached HTML in `cache/`.
- For more detail in pages, adjust the prompt in `server.js`.

## Limitations

- Reconstructions are best-effort, based on model memory.
- No external assets are loaded; images are placeholders.
- Some dynamic behaviors are approximated or omitted.

## License

Private project. All rights reserved.
