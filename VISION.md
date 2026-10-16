# Where Staleproof goes next

Docs drift because nothing connects a merge to the paragraphs it falsifies, and the paragraph is usually in another
repository. Staleproof's graph makes that connection; the plan is to make it routine.

**Month 1 — run it where it hurts.** The GitHub Action on FalkorDB's client, SDK and docs repositories and on five
open-source libraries with separate docs repositories. Measure verdict precision against what maintainers accept and
reject (`staleproof verdict accept|reject` already records it on the graph) and publish the number.

**Month 3 — the demand side.** Link GitHub issues and discussions to the symbols they ask about. "Asked about but
undocumented" is the same graph walked from the other end: symbols with many questions and no doc within three hops.
Staleproof opens those docs PRs too.

**Month 6 — hosted for teams.** staleproof.dev already indexes any public repository on first use into a graph of
its own, and the CLI and the GitHub Action already read private repositories with a token. TypeScript/JavaScript and
Sphinx docs are indexed since 0.3 (the same resolver over a second tree-sitter grammar), and docs are audited with no
pull request at all. Next: private repositories on the hosted service with one graph per organisation on managed
FalkorDB, running JavaScript examples, more languages (Go, Java), and decisions imported from ADRs and PR review
threads.

**Business.** Free for open source. Per-repository subscription for private repositories; devtools companies already
pay developer-relations teams to do this by hand after every release.
