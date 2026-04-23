# Archivist

Your vault's quiet historian. Versioned vault backups to Dropbox with content-addressed storage, hierarchical retention, and file-level restore.

## Installation

### Community Plugins (after listing)
1. Open Obsidian Settings → Community Plugins
2. Search for "Archivist"
3. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/MMoMM-org/obsidian-archivist/releases/latest)
2. Create folder `<vault>/.obsidian/plugins/obsidian-archivist/`
3. Copy the downloaded files into that folder
4. Restart Obsidian and enable the plugin

### BRAT (Beta)
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. Add beta plugin: `MMoMM-org/obsidian-archivist`

## Usage

<!-- Describe how to use the plugin -->

## Development

```bash
git clone https://github.com/MMoMM-org/obsidian-archivist.git
cd obsidian-archivist
git config core.hooksPath .githooks
npm install
npm run dev       # Watch mode
npm run build     # Production build
npm test          # Run tests
npm run lint      # Lint
```

## License

MIT — see [LICENSE](LICENSE).
