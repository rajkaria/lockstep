"""Staleproof for MkDocs: a "checked" stamp on every docs page.

Each page gets ``<meta name="staleproof:source">`` naming its source file in the
repository, a placeholder where the stamp goes, and the stamp script from the
Staleproof server. The script fetches which pages were checked, against which commit
and when, and renders one line; it sets no cookies, uses no storage and sends no
referrer.

    plugins:
      - staleproof:
          repo: owner/name          # default: from repo_url
          server: https://staleproof.dev
          docs_path: docs           # docs_dir relative to the repository root (default: worked out)
          placement: top            # top (under the page title) | bottom | none
"""

from __future__ import annotations

import os
import re
from html import escape

from mkdocs.config import config_options
from mkdocs.plugins import BasePlugin, get_plugin_logger

log = get_plugin_logger(__name__)

GITHUB_REPO = re.compile(r"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")
REPO_NAME = re.compile(r"^[\w.-]+/[\w.-]+$")


def repo_from_url(url: str | None) -> str | None:
    """`owner/name` of a GitHub repository URL."""
    m = GITHUB_REPO.search(url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


def repository_root(start: str) -> str | None:
    """The nearest folder at or above `start` that holds a `.git`."""
    here = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(here, ".git")):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            return None
        here = parent


class StaleproofPlugin(BasePlugin):
    config_scheme = (
        ("repo", config_options.Type(str, default="")),
        ("server", config_options.Type(str, default="https://staleproof.dev")),
        ("docs_path", config_options.Type(str, default="")),
        ("placement", config_options.Choice(("top", "bottom", "none"), default="top")),
    )

    def __init__(self) -> None:
        super().__init__()
        self.repo: str | None = None
        self.prefix = ""

    def on_config(self, config):
        repo = self.config["repo"] or repo_from_url(config.get("repo_url"))
        if not repo or not REPO_NAME.match(repo):
            log.warning("staleproof: set `repo: owner/name` (or repo_url to a GitHub repository); no stamp is added")
            self.repo = None
            return config
        self.repo = repo
        prefix = self.config["docs_path"]
        if not prefix:
            config_dir = os.path.dirname(os.path.abspath(config["config_file_path"] or "mkdocs.yml"))
            root = repository_root(config_dir) or config_dir
            prefix = os.path.relpath(os.path.abspath(config["docs_dir"]), root)
        self.prefix = "" if prefix in (".", "") else prefix.replace(os.sep, "/").strip("/")
        return config

    def source_path(self, page) -> str | None:
        f = getattr(page, "file", None)
        if f is None:
            return None
        rel = getattr(f, "src_uri", None) or f.src_path.replace(os.sep, "/")
        return f"{self.prefix}/{rel}" if self.prefix else rel

    def on_page_content(self, html, page, config, files):
        path = self.repo and self.source_path(page)
        if not path or self.config["placement"] == "none":
            return html
        slot = f'<div class="staleproof-stamp-slot" data-staleproof-stamp data-path="{escape(path)}"></div>'
        if self.config["placement"] == "bottom":
            return f"{html}\n{slot}"
        # Under the page title when the page has one in its content, else at the top.
        m = re.search(r"</h1\s*>", html, re.IGNORECASE)
        return f"{html[: m.end()]}\n{slot}{html[m.end():]}" if m else f"{slot}\n{html}"

    def on_post_page(self, output, page, config):
        path = self.repo and self.source_path(page)
        if not path:
            return output
        server = self.config["server"].rstrip("/")
        meta = f'<meta name="staleproof:source" content="{escape(path)}">'
        script = (
            f'<script src="{escape(server)}/api/verified/{self.repo}/stamp.js" async referrerpolicy="no-referrer"></script>'
            # Material's instant navigation swaps pages without a load: render again after each.
            "<script>window.document$&&document$.subscribe&&document$.subscribe(function(){window.StaleproofStamp&&StaleproofStamp()})</script>"
        )
        output = re.sub(r"</head\s*>", lambda m: f"{meta}\n{m.group(0)}", output, count=1, flags=re.IGNORECASE)
        return re.sub(r"</body\s*>", lambda m: f"{script}\n{m.group(0)}", output, count=1, flags=re.IGNORECASE)
