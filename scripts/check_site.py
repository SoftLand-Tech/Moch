#!/usr/bin/env python3
"""Verify (and optionally stage) the public Moch website.

Paths in scripts/site-publish-allowlist.txt are relative to docs/, because docs/
is the VPS web root. Normal mode is the strict release gate. --bootstrap checks
only the foundation and publishing policy so this script can land before the
redesigned HTML/CSS/JS exists; it deliberately does not inspect the old site.

Examples:
    python3 scripts/check_site.py --bootstrap
    python3 scripts/check_site.py
    python3 scripts/check_site.py --stage /tmp/moch-site

The verifier uses only the Python standard library and never accesses the
network. External navigation links are allowed, but external resource loads
(fonts, stylesheets, scripts, images, analytics, and CSS url()/import requests)
are not. /Moch.apk is the one permitted repository-absent URL: it already lives
on the VPS and deployment must leave it in place.
"""

from __future__ import annotations

import argparse
import html
import html.parser
import os
import posixpath
import re
import shutil
import struct
import sys
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional
from urllib.parse import unquote, urlsplit

REPO_ROOT = Path(__file__).resolve().parents[1]
SITE_ORIGIN = "https://moch.softland.tech"

REQUIRED_FILES = (
    "index.html",
    "setup.html",
    "moch.css",
    "site.js",
    "install.sh",
    "assets/logo.png",
    "assets/favicon.png",
    "assets/og-image.png",
)
REQUIRED_ALLOWLIST_ENTRIES = {
    "index.html",
    "setup.html",
    "moch.css",
    "site.js",
    "install.sh",
    "assets/**",
}
FORBIDDEN_EXACT = {"screens-inventory.html", "SITE-SPEC.md"}
FORBIDDEN_SEGMENTS = {"redesign", "bug-hunter", "tests"}

HEADLINE = "Moch — your agent runs on your phone. Your model is your choice."
SUPPORTING_COPY = (
    "An open-source AI workspace with Hermes built in and OpenCode inside an "
    "optional Ubuntu Linux guest. No Moch account, relay or remote gateway required."
)
NETWORK_CAVEAT = (
    "Local-first means the agent and your workspace live on the phone. Hosted "
    "models, OpenCode’s free hosted models, downloads, OTA updates, web browsing "
    "and optional services can still use the internet. Connect a local model for "
    "on-device inference."
)

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
IGNORED_TEXT_TAGS = {"script", "style", "template", "noscript"}
RESOURCE_LINK_RELS = {
    "stylesheet", "icon", "apple-touch-icon", "manifest", "preload",
    "modulepreload", "prefetch", "preconnect", "dns-prefetch", "prerender",
}
# Network APIs may use a literal relative/same-site URL (for example a HEAD
# request to /Moch.apk for download metadata). Dynamic or third-party URLs fail.
JS_NETWORK_CALLS = (
    ("fetch", r"\bfetch\s*\(\s*(?:(['\"`])(.*?)\1)?", 2),
    ("XMLHttpRequest.open", r"\.open\s*\(\s*(['\"`])[^'\"`]+\1\s*,\s*(?:(['\"`])(.*?)\2)?", 3),
    ("WebSocket", r"\bWebSocket\s*\(\s*(?:(['\"`])(.*?)\1)?", 2),
    ("EventSource", r"\bEventSource\s*\(\s*(?:(['\"`])(.*?)\1)?", 2),
    ("sendBeacon", r"\bsendBeacon\s*\(\s*(?:(['\"`])(.*?)\1)?", 2),
    ("dynamic import", r"\bimport\s*\(\s*(?:(['\"`])(.*?)\1)?", 2),
    ("require", r"\brequire\s*\(\s*(?:(['\"`])(.*?)\1)?", 2),
)
JS_EXTERNAL_SRC_PATTERN = re.compile(r"\.src\s*=\s*(['\"`])(.*?)\1", re.IGNORECASE | re.DOTALL)
ANALYTICS_PATTERN = re.compile(
    r"google-analytics|googletagmanager|googletag|doubleclick|plausible(?:\.io)?|"
    r"mixpanel|segment(?:\.com|\.io)|hotjar|fullstory|amplitude|matomo|"
    r"facebook\.net|fbevents|px\.ads|twitter\.com/i/ads",
    re.IGNORECASE,
)
CSS_URL_PATTERN = re.compile(
    r"url\(\s*(?:(['\"])(.*?)\1|([^)]*?))\s*\)", re.IGNORECASE | re.DOTALL
)
CSS_IMPORT_PATTERN = re.compile(
    r"@import\s+(?:url\(\s*)?(['\"])(.*?)\1", re.IGNORECASE | re.DOTALL
)


def normalize(value: str) -> str:
    """Normalize visible copy without making punctuation-only copy edits pass."""

    value = unicodedata.normalize("NFKC", html.unescape(value))
    value = value.replace("’", "'").replace("‘", "'")
    return " ".join(value.split()).casefold()


def normalized(value: str) -> str:
    return normalize(value)


HEADLINE_N = normalized(HEADLINE)
SUPPORTING_COPY_N = normalized(SUPPORTING_COPY)
NETWORK_CAVEAT_N = normalized(NETWORK_CAVEAT)


@dataclass
class Reference:
    raw: str
    element: str
    attribute: str
    line: int
    request: bool


@dataclass
class Heading:
    level: int
    in_main: bool
    hidden: bool
    line: int
    parts: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join("".join(self.parts).split())


@dataclass
class Anchor:
    href: str
    hidden: bool
    line: int
    parts: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join("".join(self.parts).split())


@dataclass
class Image:
    attrs: dict[str, str]
    line: int


@dataclass
class ParsedPage:
    source: str
    raw: str
    tag_counts: Counter[str]
    html_attrs: dict[str, str]
    ids: set[str]
    main_ids: list[str]
    duplicate_ids: list[str]
    headings: list[Heading]
    anchors: list[Anchor]
    images: list[Image]
    buttons: list[tuple[dict[str, str], int]]
    navs: list[dict[str, str]]
    refs: list[Reference]
    inline_scripts: list[tuple[dict[str, str], str, int]]
    external_scripts: list[tuple[str, int]]
    inline_styles: list[str]
    title: str
    metas: dict[str, list[str]]
    canonical_links: list[str]
    favicons: list[str]
    visible_text: str
    errors: list[str]


def attrs_dict(attrs: list[tuple[str, Optional[str]]]) -> dict[str, str]:
    return {name.lower(): (value if value is not None else "") for name, value in attrs}


def is_hidden(attrs: list[tuple[str, Optional[str]]]) -> bool:
    values = attrs_dict(attrs)
    return (
        "hidden" in values
        or values.get("aria-hidden", "").lower() == "true"
        or re.search(r"(?:display\s*:\s*none|visibility\s*:\s*hidden)", values.get("style", ""), re.I)
        is not None
    )


def srcset_urls(value: str) -> list[str]:
    if not value:
        return []
    # A single data: URL contains a comma; responsive raster candidates do not.
    if value.lstrip().lower().startswith("data:"):
        return [value.strip()]
    urls: list[str] = []
    for candidate in value.split(","):
        candidate = candidate.strip()
        if candidate:
            urls.append(candidate.split()[0])
    return urls


class PageParser(html.parser.HTMLParser):
    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=True)
        self.source = source
        self.tag_counts: Counter[str] = Counter()
        self.html_attrs: dict[str, str] = {}
        self.ids: set[str] = set()
        self.main_ids: list[str] = []
        self.duplicate_ids: list[str] = []
        self.headings: list[Heading] = []
        self.anchors: list[Anchor] = []
        self.images: list[Image] = []
        self.buttons: list[tuple[dict[str, str], int]] = []
        self.navs: list[dict[str, str]] = []
        self.refs: list[Reference] = []
        self.inline_scripts: list[tuple[dict[str, str], str, int]] = []
        self.external_scripts: list[tuple[str, int]] = []
        self.inline_styles: list[str] = []
        self.title = ""
        self._title = ""
        self.metas: dict[str, list[str]] = {}
        self.canonical_links: list[str] = []
        self.favicons: list[str] = []
        self.errors: list[str] = []
        self._stack: list[tuple[str, bool]] = []
        self._active_headings: list[Heading] = []
        self._active_anchors: list[Anchor] = []
        self._visible_parts: list[str] = []
        self._title_parts: Optional[list[str]] = None
        self._script: Optional[tuple[dict[str, str], list[str], int, bool]] = None
        self._style_parts: Optional[list[str]] = None

    def inside(self, tag: str) -> bool:
        return any(open_tag == tag for open_tag, _ in self._stack)

    @property
    def hidden(self) -> bool:
        return any(hidden for _, hidden in self._stack)

    @property
    def ignored_text(self) -> bool:
        return any(open_tag in IGNORED_TEXT_TAGS for open_tag, _ in self._stack)

    def add_ref(self, raw: Optional[str], tag: str, attribute: str, request: bool, line: int) -> None:
        if raw is not None and raw.strip():
            self.refs.append(Reference(raw.strip(), tag, attribute, line, request))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        values = attrs_dict(attrs)
        line = self.getpos()[0]
        inherited_hidden = self.hidden
        hidden = inherited_hidden or is_hidden(attrs)
        self.tag_counts[tag] += 1

        if tag == "html":
            self.html_attrs = values
        if tag == "base":
            self.errors.append(f"line {line}: <base> is not allowed; all public URLs must be explicit")
        if tag == "main":
            if self.tag_counts[tag] > 1:
                self.errors.append(f"line {line}: expected exactly one <main> landmark")
            if values.get("id"):
                self.main_ids.append(values["id"])

        element_id = values.get("id")
        if element_id is not None:
            if not element_id or re.search(r"\s", element_id):
                self.errors.append(f"line {line}: invalid id={element_id!r}")
            elif element_id in self.ids:
                self.duplicate_ids.append(element_id)
            else:
                self.ids.add(element_id)

        for name, value in attrs:
            if name.lower().startswith("on"):
                self.errors.append(f"line {line}: inline event handler {name} is not allowed; use site.js")
            if name.lower() == "ping" and (value or "").strip():
                self.errors.append(f"line {line}: <{tag} ping> can issue third-party requests")

        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            heading = Heading(int(tag[1]), self.inside("main"), hidden, line)
            self.headings.append(heading)
            self._active_headings.append(heading)

        if tag == "a":
            anchor = Anchor(values.get("href", ""), hidden, line)
            self.anchors.append(anchor)
            self._active_anchors.append(anchor)
            self.add_ref(values.get("href"), tag, "href", False, line)
        elif tag == "area":
            self.add_ref(values.get("href"), tag, "href", False, line)
        elif tag == "link":
            rels = set(values.get("rel", "").lower().split())
            self.add_ref(values.get("href"), tag, "href", bool(rels & RESOURCE_LINK_RELS) or "canonical" not in rels, line)
            if "canonical" in rels:
                self.canonical_links.append(values.get("href", ""))
            if "icon" in rels or "apple-touch-icon" in rels:
                self.favicons.append(values.get("href", ""))
            for url in srcset_urls(values.get("imagesrcset", "")):
                self.add_ref(url, tag, "imagesrcset", True, line)
        elif tag == "script":
            src = values.get("src")
            self.add_ref(src, tag, "src", True, line)
            if src:
                self.external_scripts.append((src, line))
            self._script = (values, [], line, hidden)
        elif tag == "img":
            self.images.append(Image(values, line))
            self.add_ref(values.get("src"), tag, "src", True, line)
            for url in srcset_urls(values.get("srcset", "")):
                self.add_ref(url, tag, "srcset", True, line)
        elif tag in {"source", "video", "audio", "track", "iframe", "embed", "input"}:
            self.add_ref(values.get("src"), tag, "src", True, line)
            if tag in {"source", "video"}:
                for url in srcset_urls(values.get("srcset", "")):
                    self.add_ref(url, tag, "srcset", True, line)
            if tag == "video":
                self.add_ref(values.get("poster"), tag, "poster", True, line)
            if tag == "iframe" and "srcdoc" in values:
                self.errors.append(f"line {line}: iframe srcdoc is not allowed")
        elif tag == "object":
            self.add_ref(values.get("data"), tag, "data", True, line)
        elif tag == "form":
            self.add_ref(values.get("action"), tag, "action", True, line)
        elif tag == "use":
            self.add_ref(values.get("href") or values.get("xlink:href"), tag, "href", True, line)
        elif tag == "meta":
            key = (values.get("name") or values.get("property") or values.get("http-equiv") or "").lower()
            if key and "content" in values:
                self.metas.setdefault(key, []).append(values["content"])
            if values.get("http-equiv", "").lower() == "refresh":
                self.errors.append(f"line {line}: meta refresh is not allowed")
        elif tag == "button":
            self.buttons.append((values, line))
        elif tag == "nav":
            self.navs.append(values)
        elif tag == "title":
            self._title_parts = []
        elif tag == "style":
            self._style_parts = []

        if values.get("style"):
            self.inline_styles.append(values["style"])

        if tag not in VOID_TAGS:
            self._stack.append((tag, hidden))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self._title_parts is not None:
            self._title_parts.append(data)
        if self._script is not None:
            self._script[1].append(data)
        if self._style_parts is not None:
            self._style_parts.append(data)
        if self.inside("body") and not self.hidden and not self.ignored_text:
            self._visible_parts.append(data)
            for heading in self._active_headings:
                if not heading.hidden:
                    heading.parts.append(data)
            for anchor in self._active_anchors:
                if not anchor.hidden:
                    anchor.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._title = " ".join("".join(self._title_parts or []).split())
            self._title_parts = None
        if tag == "script" and self._script is not None:
            values, parts, line, _ = self._script
            script_type = values.get("type", "").lower()
            code = "".join(parts)
            if not values.get("src") and code.strip() and script_type != "application/ld+json":
                self.inline_scripts.append((values, code, line))
            self._script = None
        if tag == "style" and self._style_parts is not None:
            self.inline_styles.append("".join(self._style_parts))
            self._style_parts = None
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            for heading in reversed(self._active_headings):
                if heading.level == int(tag[1]):
                    self._active_headings.remove(heading)
                    break
        if tag == "a":
            for anchor in reversed(self._active_anchors):
                self._active_anchors.remove(anchor)
                break

        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index][0] == tag:
                del self._stack[index:]
                break

    def result(self, raw: str) -> ParsedPage:
        return ParsedPage(
            source=self.source,
            raw=raw,
            tag_counts=self.tag_counts,
            html_attrs=self.html_attrs,
            ids=self.ids,
            main_ids=self.main_ids,
            duplicate_ids=self.duplicate_ids,
            headings=self.headings,
            anchors=self.anchors,
            images=self.images,
            buttons=self.buttons,
            navs=self.navs,
            refs=self.refs,
            inline_scripts=self.inline_scripts,
            external_scripts=self.external_scripts,
            inline_styles=self.inline_styles,
            title=self._title,
            metas=self.metas,
            canonical_links=self.canonical_links,
            favicons=self.favicons,
            visible_text=normalized("".join(self._visible_parts)),
            errors=self.errors,
        )


def parse_page(source: str, raw: str) -> ParsedPage:
    parser = PageParser(source)
    parser.feed(raw)
    parser.close()
    return parser.result(raw)


NONPUBLIC_ASSET_NAMES = {"ASSET-PROVENANCE.md", "PROVENANCE.md"}


def is_nonpublic_asset_metadata(relative: str) -> bool:
    """Provenance lives beside assets in git, not in the public web root."""
    path = PurePosixPath(relative)
    return (
        len(path.parts) > 1
        and path.parts[0] == "assets"
        and (path.name in NONPUBLIC_ASSET_NAMES or path.suffix.lower() in {".json", ".md"})
    )


def is_forbidden_path(relative: str) -> bool:
    path = PurePosixPath(relative)
    parts = path.parts
    if not parts or path.is_absolute():
        return True
    if relative in FORBIDDEN_EXACT or any(part in FORBIDDEN_SEGMENTS for part in parts):
        return True
    if any(part.startswith(".") for part in parts):
        return True
    return relative.lower().endswith(".map")


def load_allowlist(path: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    patterns: list[str] = []
    if not path.is_file():
        return [], ["missing publish allowlist: scripts/site-publish-allowlist.txt"]
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        return [], [f"cannot read publish allowlist: {exc}"]

    for number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if any(char in line for char in "\\{}[]"):
            errors.append(f"allowlist line {number}: use a plain docs-relative POSIX path: {line!r}")
            continue
        if line.startswith(("/", "./", "-", "!")) or ".." in PurePosixPath(line).parts:
            errors.append(f"allowlist line {number}: unsafe path: {line!r}")
            continue
        if line.endswith("/"):
            errors.append(f"allowlist line {number}: list files or assets/**, not directories: {line!r}")
            continue
        wildcard = any(char in line for char in "*?")
        if wildcard and line != "assets/**":
            errors.append(
                f"allowlist line {number}: only assets/** may be recursive; "
                "add approved screenshots by exact path"
            )
            continue
        if line in patterns:
            errors.append(f"allowlist line {number}: duplicate entry: {line}")
            continue
        if is_forbidden_path(line):
            errors.append(f"allowlist line {number}: forbidden publish path: {line}")
            continue
        patterns.append(line)

    missing = sorted(REQUIRED_ALLOWLIST_ENTRIES - set(patterns))
    if missing:
        errors.append("allowlist is missing required entries: " + ", ".join(missing))
    return patterns, errors


def expand_allowlist(docs_dir: Path, patterns: Iterable[str]) -> tuple[list[str], list[str]]:
    files: set[str] = set()
    errors: list[str] = []
    for pattern in patterns:
        if pattern == "assets/**":
            asset_root = docs_dir / "assets"
            if not asset_root.is_dir() or asset_root.is_symlink():
                errors.append("assets/ is missing or is a symlink")
                continue
            for root, dirs, names in os.walk(asset_root, followlinks=False):
                root_path = Path(root)
                for name in sorted(dirs + names):
                    path = root_path / name
                    relative = path.relative_to(docs_dir).as_posix()
                    if is_nonpublic_asset_metadata(relative):
                        continue
                    if path.is_symlink():
                        errors.append(f"publish asset must not be a symlink: {relative}")
                    elif name in names:
                        files.add(relative)
        else:
            path = docs_dir / pattern
            if path.is_symlink():
                errors.append(f"publish file must not be a symlink: {pattern}")
            elif path.is_file():
                files.add(pattern)
            elif path.exists():
                errors.append(f"allowlist entry is not a regular file: {pattern}")
            # Missing exact files are allowed here so bootstrap can precede the
            # redesign. Strict mode reports every REQUIRED_FILES omission.

    publish = sorted(files)
    for relative in publish:
        if is_forbidden_path(relative):
            errors.append(f"forbidden path would be published: {relative}")
    return publish, errors


def one_meta(page: ParsedPage, key: str) -> str:
    values = page.metas.get(key, [])
    return values[0].strip() if values else ""


def validate_structure(page: ParsedPage) -> list[str]:
    errors = list(page.errors)
    prefix = page.source
    if not re.match(r"\s*<!doctype\s+html\b", page.raw, re.IGNORECASE):
        errors.append(f"{prefix}: missing HTML5 doctype")
    for tag in ("html", "head", "body"):
        if page.tag_counts[tag] != 1:
            errors.append(f"{prefix}: expected exactly one <{tag}> element")
    if page.tag_counts["main"] != 1:
        errors.append(f"{prefix}: expected exactly one <main> landmark")
    if page.tag_counts["header"] < 1 or page.tag_counts["footer"] < 1:
        errors.append(f"{prefix}: expected header and footer landmarks")
    if not page.html_attrs.get("lang", "").strip():
        errors.append(f"{prefix}: <html> needs a non-empty lang attribute")
    if page.duplicate_ids:
        errors.append(f"{prefix}: duplicate ids: {', '.join(sorted(set(page.duplicate_ids)))}")
    if not page.navs:
        errors.append(f"{prefix}: expected a navigation landmark")
    for nav in page.navs:
        label = nav.get("aria-label", "").strip()
        labelledby = nav.get("aria-labelledby", "").split()
        if not label and not (labelledby and all(target in page.ids for target in labelledby)):
            errors.append(f"{prefix}: every <nav> needs aria-label or a valid aria-labelledby")

    skip_targets = [
        anchor.href[1:]
        for anchor in page.anchors
        if not anchor.hidden
        and anchor.href.startswith("#")
        and "skip" in normalized(anchor.text)
    ]
    if not skip_targets:
        errors.append(f"{prefix}: missing a visible 'Skip to content' link")
    if not any(target in page.main_ids and target in page.ids for target in skip_targets):
        errors.append(f"{prefix}: skip link must target the <main> id")

    visible_headings = [heading for heading in page.headings if not heading.hidden]
    all_h1s = [heading for heading in page.headings if heading.level == 1]
    h1s = [heading for heading in visible_headings if heading.level == 1]
    if len(all_h1s) != 1:
        errors.append(f"{prefix}: expected exactly one <h1> element")
    elif not h1s:
        errors.append(f"{prefix}: the <h1> must be visible")
    elif not h1s[0].in_main or not h1s[0].text:
        errors.append(f"{prefix}: the <h1> must be non-empty and inside <main>")
    if not visible_headings or visible_headings[0].level != 1:
        errors.append(f"{prefix}: the first visible heading must be <h1>")
    previous = 0
    for heading in visible_headings:
        if not heading.text:
            errors.append(f"{prefix}: empty h{heading.level} at line {heading.line}")
        if previous and heading.level > previous + 1:
            errors.append(
                f"{prefix}: heading level jumps from h{previous} to h{heading.level} "
                f"at line {heading.line}"
            )
        previous = heading.level

    for image in page.images:
        if "alt" not in image.attrs:
            errors.append(f"{prefix}: image at line {image.line} needs an alt attribute")
        for dimension in ("width", "height"):
            value = image.attrs.get(dimension, "")
            if not value.isdigit() or int(value) <= 0:
                errors.append(
                    f"{prefix}: image at line {image.line} needs a positive numeric {dimension}"
                )
    for values, line in page.buttons:
        if values.get("type", "").lower() not in {"button", "submit", "reset"}:
            errors.append(f"{prefix}: button at line {line} needs an explicit type")
        control_hint = re.search(r"(?:menu|nav|disclosure|toggle)", values.get("class", "") + " " + values.get("id", ""), re.I)
        if control_hint and "aria-expanded" not in values:
            errors.append(f"{prefix}: menu/disclosure button at line {line} needs aria-expanded")

    if page.inline_scripts:
        lines = ", ".join(str(line) for _, _, line in page.inline_scripts)
        errors.append(f"{prefix}: executable inline scripts are not allowed (lines {lines}); use site.js")
    script_sources = [src for src, _ in page.external_scripts]
    shared_scripts = {"site.js", "./site.js", "/site.js", SITE_ORIGIN + "/site.js"}
    if len(script_sources) != 1 or script_sources[0] not in shared_scripts:
        errors.append(f"{prefix}: load exactly one shared script: site.js")
    return errors


def validate_metadata(page: ParsedPage, canonical: str) -> list[str]:
    errors: list[str] = []
    prefix = page.source
    title = page.title.strip()
    description = one_meta(page, "description")
    if len(title) < 8 or "moch" not in normalized(title):
        errors.append(f"{prefix}: title must be descriptive and name Moch")
    if len(description) < 40 or len(description) > 320 or "moch" not in normalized(description):
        errors.append(f"{prefix}: description must be 40–320 characters and name Moch")
    if not one_meta(page, "viewport"):
        errors.append(f"{prefix}: missing viewport metadata")
    if page.canonical_links != [canonical]:
        errors.append(f"{prefix}: canonical must be exactly {canonical}")
    for key in ("og:title", "og:description", "og:image", "og:url", "twitter:title", "twitter:description", "twitter:image"):
        if not one_meta(page, key):
            errors.append(f"{prefix}: missing {key} metadata")
    if not one_meta(page, "og:type"):
        errors.append(f"{prefix}: missing og:type metadata")
    if not one_meta(page, "twitter:card"):
        errors.append(f"{prefix}: missing twitter:card metadata")
    theme_color = one_meta(page, "theme-color")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", theme_color):
        errors.append(f"{prefix}: theme-color must be a #RRGGBB value")
    if not page.favicons:
        errors.append(f"{prefix}: missing favicon link")
    expected_image = "/assets/og-image.png"
    for key in ("og:image", "twitter:image"):
        value = one_meta(page, key)
        if value in {expected_image, "assets/og-image.png", "./assets/og-image.png", SITE_ORIGIN + expected_image}:
            continue
        errors.append(f"{prefix}: {key} must resolve to {expected_image}")
    return errors


def is_same_site_url(parts, scheme: str) -> bool:
    return (
        scheme == "https"
        and parts.hostname is not None
        and parts.hostname.lower() == "moch.softland.tech"
        and parts.port in (None, 443)
        and parts.username is None
        and parts.password is None
    )


def resolve_reference(
    docs_dir: Path,
    source: str,
    ref: Reference,
    publish_files: set[str],
    *,
    fragment_only_ok: bool = False,
) -> list[str]:
    raw = ref.raw.strip()
    errors: list[str] = []
    location = f"{source}:{ref.line} <{ref.element} {ref.attribute}>"
    if not raw:
        return errors
    if any(ord(char) < 32 for char in raw):
        errors.append(f"{location}: control characters are not allowed in URLs")
        return errors
    if raw.startswith("#"):
        if raw != "#" and not fragment_only_ok:
            fragment = unquote(raw[1:])
            page_path = docs_dir / source
            page = parse_page(source, page_path.read_text(encoding="utf-8"))
            if fragment not in page.ids:
                errors.append(f"{location}: missing fragment target {raw}")
        return errors

    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        return [f"{location}: invalid URL {raw!r}: {exc}"]
    scheme = parts.scheme.lower()
    if scheme in {"http", "https"}:
        if is_same_site_url(parts, scheme):
            local_path = unquote(parts.path or "/")
            root_relative = True
        else:
            if ref.request:
                errors.append(f"{location}: third-party resource request is forbidden: {raw}")
            return errors
    elif raw.startswith("//"):
        try:
            same_site = is_same_site_url(parts, "https")
        except ValueError:
            same_site = False
        if same_site:
            local_path = unquote(parts.path or "/")
            root_relative = True
        else:
            if ref.request:
                errors.append(f"{location}: third-party resource request is forbidden: {raw}")
            return errors
    elif scheme == "data":
        if ref.request:
            embedded_media = ref.element in {"img", "source", "input"} or (
                ref.element == "video" and ref.attribute == "poster"
            )
            embedded_css_asset = ref.element == "css" and raw.lower().startswith(
                ("data:image/", "data:font/", "data:application/font-", "data:application/x-font-", "data:application/vnd.ms-fontobject")
            )
            if not (embedded_media or embedded_css_asset):
                errors.append(f"{location}: data: URLs are only allowed for embedded images/media/fonts")
        return errors
    elif scheme in {"mailto", "tel"} and not ref.request:
        return errors
    elif scheme:
        errors.append(f"{location}: URL scheme {scheme!r} is not allowed")
        return errors
    else:
        if "\\" in raw:
            errors.append(f"{location}: backslashes are not allowed in public URLs")
            return errors
        local_path = unquote(parts.path)
        root_relative = local_path.startswith("/")

    if local_path == "/Moch.apk":
        return errors  # Existing VPS artifact; deliberately outside the repo.
    if not local_path:
        target = source
    else:
        if root_relative:
            target = posixpath.normpath(local_path.lstrip("/"))
        else:
            target = posixpath.normpath(posixpath.join(posixpath.dirname(source), local_path))
        if target.endswith("/"):
            target += "index.html"
        if target in {".", ""}:
            target = posixpath.join(posixpath.dirname(source), "index.html")
    if target == ".." or target.startswith("../") or target.startswith("/"):
        errors.append(f"{location}: URL escapes the public docs root: {raw}")
    elif target not in publish_files:
        errors.append(f"{location}: target is missing or not allowlisted: {target}")

    fragment = unquote(parts.fragment)
    if fragment and not fragment_only_ok and target in publish_files and target.endswith(".html"):
        page = parse_page(target, (docs_dir / target).read_text(encoding="utf-8"))
        if fragment not in page.ids:
            errors.append(f"{location}: missing fragment target #{fragment} in {target}")
    return errors


def css_references(css: str) -> list[str]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    refs: list[str] = []
    for match in CSS_URL_PATTERN.finditer(css):
        refs.append((match.group(2) if match.group(2) is not None else match.group(3)).strip())
    for match in CSS_IMPORT_PATTERN.finditer(css):
        refs.append(match.group(2).strip())
    return [ref for ref in refs if ref]


def validate_no_analytics(source: str, text: str) -> list[str]:
    if ANALYTICS_PATTERN.search(text):
        return [f"{source}: analytics/tracking integration is forbidden"]
    return []


def is_local_script_url(url: str) -> bool:
    if any(ord(char) < 32 for char in url) or "\\" in url or "${" in url:
        return False
    if url.startswith("//"):
        try:
            return is_same_site_url(urlsplit("https:" + url), "https")
        except ValueError:
            return False
    if url.startswith(("/", "./", "../", "?", "#")) or not url:
        return True
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme in {"http", "https"}:
        return is_same_site_url(parts, parts.scheme)
    return parts.scheme == "data"


def validate_no_network_code(source: str, text: str) -> list[str]:
    errors = validate_no_analytics(source, text)
    for label, pattern, url_group in JS_NETWORK_CALLS:
        for match in re.finditer(pattern, text, re.IGNORECASE | re.DOTALL):
            url = match.group(url_group)
            if url is None:
                errors.append(f"{source}: {label} URL must be a relative or same-site literal")
            elif not is_local_script_url(url):
                errors.append(f"{source}: third-party {label} request is forbidden: {url}")
    for match in JS_EXTERNAL_SRC_PATTERN.finditer(text):
        if not is_local_script_url(match.group(2)):
            errors.append(f"{source}: third-party script/resource assignment is forbidden: {match.group(2)}")
    if re.search(r"createElement\s*\(\s*['\"]script['\"]", text, re.IGNORECASE):
        errors.append(f"{source}: dynamically created scripts are forbidden; use the shared site.js tag")
    if re.search(r"\bnew\s+FontFace\b", text, re.IGNORECASE):
        errors.append(f"{source}: runtime font loading is forbidden")
    return errors


def validate_page_references(page: ParsedPage, docs_dir: Path, publish_files: set[str]) -> list[str]:
    errors: list[str] = []
    for ref in page.refs:
        errors.extend(resolve_reference(docs_dir, page.source, ref, publish_files))
    for index, css in enumerate(page.inline_styles, 1):
        for raw in css_references(css):
            ref = Reference(raw, "style", f"inline-{index}", page.refs[0].line if page.refs else 1, True)
            errors.extend(resolve_reference(docs_dir, page.source, ref, publish_files, fragment_only_ok=raw.startswith("#")))
    errors.extend(validate_no_analytics(page.source, page.raw))
    return errors


def validate_css(docs_dir: Path, publish_files: set[str], relative: str) -> list[str]:
    path = docs_dir / relative
    try:
        css = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return [f"{relative}: cannot read stylesheet: {exc}"]
    errors: list[str] = []
    for raw in css_references(css):
        ref = Reference(raw, "css", "url", 1, True)
        errors.extend(resolve_reference(docs_dir, relative, ref, publish_files, fragment_only_ok=raw.startswith("#")))
    errors.extend(validate_no_analytics(relative, css))
    return errors


def validate_identity(index: ParsedPage) -> list[str]:
    errors: list[str] = []
    h1s = [heading.text for heading in index.headings if not heading.hidden and heading.level == 1]
    if len(h1s) != 1 or normalized(h1s[0]) != HEADLINE_N:
        errors.append(f"index.html: h1 must use the approved headline: {HEADLINE}")
    if SUPPORTING_COPY_N not in index.visible_text:
        errors.append("index.html: missing the approved Hermes/OpenCode supporting copy")
    caveat_at = index.visible_text.find(NETWORK_CAVEAT_N)
    if caveat_at < 0:
        errors.append("index.html: missing the complete approved network caveat")
    else:
        first_claim = index.visible_text.find("local-first")
        if first_claim < 0:
            errors.append("index.html: missing a visible local-first claim near the network caveat")
        elif not 0 <= caveat_at - first_claim <= 2000:
            errors.append(
                "index.html: the network caveat must be visible within 2000 normalized "
                "characters of the first local-first claim"
            )
    if "v1.0.0" not in index.visible_text or "legacy" not in index.visible_text:
        errors.append("index.html: identify stable v1.0.0 as the legacy linked/relay build")

    download_links = [
        anchor for anchor in index.anchors
        if not anchor.hidden and anchor.href == "/Moch.apk"
    ]
    if not any(normalized(anchor.text) == "download the current beta" for anchor in download_links):
        errors.append("index.html: primary /Moch.apk CTA must be labeled 'Download the current beta'")
    if not any(anchor.href in {"setup.html", "./setup.html", "/setup.html", SITE_ORIGIN + "/setup.html"} for anchor in index.anchors):
        errors.append("index.html: missing setup.html CTA")
    return errors


def validate_setup(page: ParsedPage) -> list[str]:
    errors: list[str] = []
    text = page.visible_text
    h1 = normalized(" ".join(heading.text for heading in page.headings if heading.level == 1 and not heading.hidden))
    if "setup" not in h1 and "set up" not in h1:
        errors.append("setup.html: h1 must identify the setup guide")
    positions: list[int] = []
    for term in ("environment", "thinker", "providers", "about you"):
        position = text.find(term)
        if position < 0:
            errors.append(f"setup.html: missing first-run step: {term}")
        positions.append(position)
    if all(position >= 0 for position in positions) and positions != sorted(positions):
        errors.append("setup.html: first-run steps must appear in Environment → Thinker → Providers → About you order")
    for phrase in ("ubuntu 24.04", "hermes", "default", "opencode", "linux", "legacy", "v1.0.0", "moch-link"):
        if phrase not in text:
            errors.append(f"setup.html: missing required setup/legacy copy: {phrase}")
    for phrase in ("local-first", "hosted models", "free hosted models", "internet", "local model"):
        if phrase not in text:
            errors.append(f"setup.html: missing network caveat concept: {phrase}")
    if not any(anchor.href == "/Moch.apk" for anchor in page.anchors):
        errors.append("setup.html: missing /Moch.apk download")
    return errors


def validate_svg_assets(docs_dir: Path, publish_files: Iterable[str]) -> list[str]:
    errors: list[str] = []
    for relative in publish_files:
        if not relative.endswith(".svg"):
            continue
        try:
            text = (docs_dir / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{relative}: cannot read SVG: {exc}")
            continue
        if re.search(r"<script\b|\son[a-z]+\s*=", text, re.IGNORECASE):
            errors.append(f"{relative}: SVG scripts and inline event handlers are forbidden")
        if re.search(
            r"(?:url\s*\(\s*['\"]?|(?:xlink:)?href\s*=\s*['\"])(?:https?:)?//",
            text,
            re.IGNORECASE,
        ):
            errors.append(f"{relative}: external SVG references are forbidden")
        if ANALYTICS_PATTERN.search(text):
            errors.append(f"{relative}: analytics/tracking integration is forbidden")
    return errors


def validate_og_image(docs_dir: Path) -> list[str]:
    path = docs_dir / "assets" / "og-image.png"
    try:
        data = path.read_bytes()
    except OSError as exc:
        return [f"assets/og-image.png: cannot read social image: {exc}"]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return ["assets/og-image.png: expected a PNG image with an IHDR header"]
    width, height = struct.unpack(">II", data[16:24])
    if (width, height) != (1200, 630):
        return [f"assets/og-image.png: expected 1200×630, got {width}×{height}"]
    return []


def validate_build_sync(repo_root: Path, docs_dir: Path) -> list[str]:
    """The public beta label must match the Android build, not a stale hand edit."""
    gradle = repo_root / "app" / "android" / "app" / "build.gradle"
    try:
        source = gradle.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"app/android/app/build.gradle: cannot read build version: {exc}"]
    code_match = re.search(r"\bversionCode\s+(\d+)", source)
    name_match = re.search(r'\bversionName\s+"([^"]+)"', source)
    if not code_match or not name_match:
        return ["app/android/app/build.gradle: could not read versionCode/versionName"]
    code = code_match.group(1)
    name = name_match.group(1)
    errors: list[str] = []
    for relative in ("index.html", "setup.html"):
        try:
            raw = (docs_dir / relative).read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"{relative}: cannot verify build version: {exc}")
            continue
        names = [html.unescape(value).strip() for value in re.findall(r"data-version(?![-\w])[^>]*>(.*?)<", raw, re.S)]
        codes = [html.unescape(value).strip() for value in re.findall(r"data-version-code[^>]*>(.*?)<", raw, re.S)]
        if not names or any(value != name for value in names):
            errors.append(f"{relative}: data-version must match Gradle versionName {name}")
        if not codes or any(value != code for value in codes):
            errors.append(f"{relative}: data-version-code must match Gradle versionCode {code}")
    try:
        javascript = (docs_dir / "site.js").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"site.js: cannot verify build version: {exc}")
    else:
        js_name = re.search(r"versionName:\s*['\"]([^'\"]+)['\"]", javascript)
        js_code = re.search(r"versionCode:\s*(\d+)", javascript)
        if not js_name or js_name.group(1) != name:
            errors.append(f"site.js: BUILD.versionName must match Gradle versionName {name}")
        if not js_code or js_code.group(1) != code:
            errors.append(f"site.js: BUILD.versionCode must match Gradle versionCode {code}")
    return errors


def verify_site(repo_root: Path = REPO_ROOT, *, bootstrap: bool = False) -> tuple[list[str], list[str]]:
    docs_dir = repo_root / "docs"
    allowlist_path = repo_root / "scripts" / "site-publish-allowlist.txt"
    patterns, errors = load_allowlist(allowlist_path)
    if errors:
        return [], errors
    publish, expand_errors = expand_allowlist(docs_dir, patterns)
    errors.extend(expand_errors)

    canonical = repo_root / "moch-link" / "install.sh"
    public = docs_dir / "install.sh"
    if not canonical.is_file():
        errors.append("missing canonical installer: moch-link/install.sh")
    elif not public.is_file():
        errors.append("missing public installer: docs/install.sh")
    elif canonical.read_bytes() != public.read_bytes():
        errors.append(
            "docs/install.sh must be byte-identical to moch-link/install.sh; "
            "regenerate it with: cp moch-link/install.sh docs/install.sh"
        )

    if bootstrap:
        return publish, errors

    for relative in REQUIRED_FILES:
        path = docs_dir / relative
        if not path.is_file():
            errors.append(f"missing required public file: {relative}")
        elif path.stat().st_size == 0:
            errors.append(f"required public file is empty: {relative}")
    mascots = sorted((docs_dir / "assets" / "moch").glob("*.svg")) if (docs_dir / "assets" / "moch").is_dir() else []
    if not mascots:
        errors.append("missing required Moch mascot artwork under assets/moch/*.svg")
    errors.extend(validate_og_image(docs_dir))
    if errors:
        return publish, errors

    publish_set = set(publish)
    pages: dict[str, ParsedPage] = {}
    for relative in ("index.html", "setup.html"):
        try:
            raw = (docs_dir / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{relative}: cannot read HTML: {exc}")
            continue
        page = parse_page(relative, raw)
        pages[relative] = page
        canonical_url = SITE_ORIGIN + ("/" if relative == "index.html" else "/setup.html")
        errors.extend(validate_structure(page))
        errors.extend(validate_metadata(page, canonical_url))
        errors.extend(validate_page_references(page, docs_dir, publish_set))

    for relative in publish:
        if relative.endswith(".css"):
            errors.extend(validate_css(docs_dir, publish_set, relative))
        elif relative.endswith(".js"):
            try:
                javascript = (docs_dir / relative).read_text(encoding="utf-8")
                errors.extend(validate_no_network_code(relative, javascript))
            except (OSError, UnicodeError) as exc:
                errors.append(f"{relative}: cannot read script: {exc}")
    errors.extend(validate_svg_assets(docs_dir, publish))

    if "index.html" in pages:
        errors.extend(validate_identity(pages["index.html"]))
    if "setup.html" in pages:
        errors.extend(validate_setup(pages["setup.html"]))
    errors.extend(validate_build_sync(repo_root, docs_dir))
    return publish, errors


def stage_site(repo_root: Path, publish: Iterable[str], destination: Path) -> list[str]:
    destination = destination.expanduser().resolve()
    repo_root = repo_root.resolve()
    if destination == repo_root or repo_root in destination.parents:
        raise ValueError("staging destination must be outside the repository")
    if destination.exists():
        raise ValueError(f"staging destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.tmp-", dir=destination.parent))
    try:
        for relative in sorted(publish):
            source = repo_root / "docs" / relative
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        temporary.rename(destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return sorted(publish)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help="check only foundation/allowlist invariants; skip redesigned-site requirements",
    )
    parser.add_argument("--stage", metavar="DIR", help="verify strictly, then stage only allowlisted files into a new DIR")
    args = parser.parse_args(argv)
    if args.bootstrap and args.stage:
        parser.error("--bootstrap and --stage cannot be combined")

    publish, errors = verify_site(bootstrap=args.bootstrap)
    if errors:
        print("Site verification failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    if args.stage:
        try:
            staged = stage_site(REPO_ROOT, publish, Path(args.stage))
        except (OSError, ValueError) as exc:
            print(f"Site staging failed: {exc}", file=sys.stderr)
            return 1
        print(f"Strict site verification passed; staged {len(staged)} allowlisted files in {Path(args.stage).resolve()}")
    elif args.bootstrap:
        print(
            "Bootstrap verification passed: publish allowlist is safe, forbidden paths "
            "are excluded, and installers are byte-identical. Redesigned-site checks were skipped."
        )
    else:
        print(f"Strict site verification passed ({len(publish)} allowlisted public files).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
