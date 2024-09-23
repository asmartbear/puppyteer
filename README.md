# Puppyteer

System built on `puppeteer`, for simulatenous jobs that watch for things, do things, simultaneously,
but with a non-headless browser, ensuring that actions happen when a page is active.

## Development Usage

Build:

```bash
npm run build
```

Unit tests:

```bash
npm run test
```

Unit tests, refreshed live:

```bash
npm run watch
```

Prepare for release (e.g. run tests and bump version number), then publish to npm:

```bash
npm run release && npm publish
```
