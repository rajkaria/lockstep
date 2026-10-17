# Staleproof for Zed

A Zed extension that starts `staleproof lsp` for Markdown, Python, TypeScript, TSX, JavaScript and Go
files: stale docs references as diagnostics, verified fixes as code actions, hover and go to definition
from docs code spans to the code. Zed adds language servers through extensions, so this one does only
that: it runs a `staleproof` on your PATH, or `npx -y staleproof@<version>`.

Install it as a dev extension until it is published: install Rust with rustup, then in Zed run
`zed: install dev extension` and pick this folder (`editors/zed`). Setup for every editor:
[staleproof.dev/#/docs/editors](https://staleproof.dev/#/docs/editors).
