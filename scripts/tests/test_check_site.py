#!/usr/bin/env python3
"""Stdlib tests for scripts/check_site.py; no network or redesigned docs needed."""

from __future__ import annotations

import importlib.util
import re
import struct
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "check_site.py"
SPEC = importlib.util.spec_from_file_location("check_site", SCRIPT)
assert SPEC and SPEC.loader
check_site = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = check_site
SPEC.loader.exec_module(check_site)

ALLOWLIST = """# docs-relative public files
index.html
setup.html
moch.css
site.js
install.sh
assets/**
"""


def png_header(width: int, height: int) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00"


def html_page(page: str) -> str:
    canonical = "https://moch.softland.tech/" if page == "index.html" else "https://moch.softland.tech/setup.html"
    title = "Moch: your agent runs on your phone" if page == "index.html" else "Set up Moch on Android"
    description = (
        "Moch is a local-first Android AI workspace with embedded Hermes and optional OpenCode inside Moch Linux."
        if page == "index.html"
        else "Set up the current Moch Android beta, choose Hermes or OpenCode, connect a model, and understand network use."
    )
    head = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="{canonical}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{description}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="/assets/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{title}">
  <meta name="twitter:description" content="{description}">
  <meta name="twitter:image" content="/assets/og-image.png">
  <meta name="theme-color" content="#0a0813">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'">
  <link rel="icon" href="assets/favicon.png">
  <link rel="stylesheet" href="moch.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header><nav aria-label="Primary"><a href="index.html">Home</a> <a href="setup.html">Setup</a></nav></header>
  <main id="main">
"""
    if page == "index.html":
        body = f"""    <h1>Your agent runs on your phone. <span>Your model is your choice.</span></h1>
    <p class="build"><span data-version>1.0.53-beta.3</span> · build <span data-version-code>58</span></p>
    <img src="assets/logo.png" alt="Moch logo" width="120" height="40">
    <p>{check_site.SUPPORTING_COPY}</p>
    <p><a href="/Moch.apk" download>Download the current beta</a> <a href="setup.html">Setup guide</a></p>
    <h2>On-device proof</h2>
    <p>The agent and workspace live on the phone. Stable v1.0.0 is the legacy linked/relay build.</p>
    <aside><p>{check_site.NETWORK_CAVEAT}</p></aside>
    <h2>Choose your thinker</h2>
    <p>Hermes is the default. OpenCode is optional and runs inside the Ubuntu Linux guest.</p>
"""
    else:
        body = f"""    <h1>Set up Moch on Android</h1>
    <p class="build"><span data-version>1.0.53-beta.3</span> · build <span data-version-code>58</span></p>
    <p><a href="/Moch.apk" download>Download the current beta</a></p>
    <h2>1. Environment</h2><p>Install or skip Ubuntu 24.04. OpenCode requires Linux.</p>
    <h2>2. Thinker</h2><p>Hermes is the default; OpenCode is optional.</p>
    <h2>3. Providers</h2><p>Choose a hosted provider or connect a local model.</p>
    <h2>4. About you</h2><p>Choose notification and battery permissions.</p>
    <aside><p>{check_site.NETWORK_CAVEAT}</p></aside>
    <h2>Troubleshooting</h2><p>Check the download and provider settings.</p>
    <h2>Legacy v1.0.0 / moch-link relay setup</h2><p>This section is only for existing linked/relay users.</p>
"""
    return head + body + """  </main>
  <footer><p>Moch · MIT · <a href="setup.html">Setup</a></p></footer>
  <script src="site.js" defer></script>
</body>
</html>
"""


class SiteFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.docs = root / "docs"
        self.scripts = root / "scripts"
        self.docs.mkdir(parents=True)
        (self.docs / "assets").mkdir()
        self.scripts.mkdir()
        (root / "moch-link").mkdir()
        installer = b"#!/usr/bin/env bash\necho foundation\n"
        (root / "moch-link" / "install.sh").write_bytes(installer)
        (self.docs / "install.sh").write_bytes(installer)
        (self.scripts / "site-publish-allowlist.txt").write_text(ALLOWLIST, encoding="utf-8")
        gradle = root / "app" / "android" / "app" / "build.gradle"
        gradle.parent.mkdir(parents=True)
        gradle.write_text('defaultConfig {\n    versionCode 58\n    versionName "1.0.53-beta.3"\n}\n', encoding="utf-8")

    def build_strict_site(self) -> None:
        (self.docs / "index.html").write_text(html_page("index.html"), encoding="utf-8")
        (self.docs / "setup.html").write_text(html_page("setup.html"), encoding="utf-8")
        (self.docs / "moch.css").write_text("body { color: #f8efe5; background: #0a0813; }\n", encoding="utf-8")
        (self.docs / "site.js").write_text(
            "const BUILD = Object.freeze({ versionName: '1.0.53-beta.3', versionCode: 58 });\n"
            "document.documentElement.classList.add('js');\n",
            encoding="utf-8",
        )
        assets = self.docs / "assets"
        (assets / "moch").mkdir(parents=True)
        (assets / "logo.png").write_bytes(b"foundation-logo")
        (assets / "favicon.png").write_bytes(b"foundation-favicon")
        (assets / "og-image.png").write_bytes(png_header(1200, 630))
        (assets / "moch" / "mochi.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', encoding="utf-8")


class CheckSiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="moch-site-test-")
        self.base = Path(self.temporary.name)
        self.fixture = SiteFixture(self.base / "repo")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def errors(self, *, bootstrap: bool = False) -> list[str]:
        _, errors = check_site.verify_site(self.fixture.root, bootstrap=bootstrap)
        return errors

    def test_bootstrap_allows_foundation_before_redesign(self) -> None:
        self.assertEqual(self.errors(bootstrap=True), [])

    def test_normal_mode_is_strict_before_redesign(self) -> None:
        errors = self.errors()
        self.assertTrue(any("missing required public file: site.js" in error for error in errors))
        self.assertTrue(any("assets/og-image.png" in error for error in errors))

    def test_bootstrap_rejects_forbidden_allowlist_entry(self) -> None:
        path = self.fixture.scripts / "site-publish-allowlist.txt"
        path.write_text(ALLOWLIST + "redesign/design.html\n", encoding="utf-8")
        self.assertTrue(any("forbidden publish path" in error for error in self.errors(bootstrap=True)))

    def test_bootstrap_rejects_installer_divergence(self) -> None:
        (self.fixture.docs / "install.sh").write_bytes(b"different\n")
        self.assertTrue(any("byte-identical" in error for error in self.errors(bootstrap=True)))

    def test_assets_source_map_is_never_publishable(self) -> None:
        assets = self.fixture.docs / "assets"
        (assets / "site.js.map").write_text("{}\n", encoding="utf-8")
        self.assertTrue(any("forbidden path would be published" in error for error in self.errors(bootstrap=True)))

    def test_intermediate_symlink_cannot_escape_docs(self) -> None:
        outside = self.base / "outside-docs"
        outside.mkdir()
        (outside / "secret.txt").write_text("not public\n", encoding="utf-8")
        (self.fixture.docs / "linked").symlink_to(outside, target_is_directory=True)
        allowlist = self.fixture.scripts / "site-publish-allowlist.txt"
        allowlist.write_text(ALLOWLIST + "linked/secret.txt\n", encoding="utf-8")
        errors = self.errors(bootstrap=True)
        self.assertTrue(any("escapes docs/" in error for error in errors))

    def test_strict_site_passes_and_staging_excludes_repo_only_files(self) -> None:
        self.fixture.build_strict_site()
        for relative in ("redesign/design.html", "bug-hunter/report.html", "tests/example.html", "SITE-SPEC.md", "screens-inventory.html"):
            path = self.fixture.docs / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("not public\n", encoding="utf-8")
        self.assertEqual(self.errors(), [])
        publish, errors = check_site.verify_site(self.fixture.root)
        self.assertEqual(errors, [])
        destination = self.base / "staged"
        check_site.stage_site(self.fixture.root, publish, destination)
        staged = sorted(path.relative_to(destination).as_posix() for path in destination.rglob("*") if path.is_file())
        self.assertEqual(staged, publish)
        self.assertFalse((destination / "redesign").exists())
        self.assertFalse((destination / "tests").exists())

    def test_aria_controls_step_button_is_not_a_disclosure(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        text = path.read_text(encoding="utf-8").replace(
            "<h2>On-device proof</h2>",
            '<button class="step-button" type="button" aria-controls="proof-detail" aria-pressed="true">Step</button><h2>On-device proof</h2>',
        )
        path.write_text(text, encoding="utf-8")
        self.assertEqual(self.errors(), [])

    def test_missing_network_caveat_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        path.write_text(path.read_text(encoding="utf-8").replace(check_site.NETWORK_CAVEAT, "Networks may be used."), encoding="utf-8")
        self.assertTrue(any("network caveat" in error for error in self.errors()))

    def test_third_party_script_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        text = path.read_text(encoding="utf-8").replace(
            '<script src="site.js" defer></script>',
            '<script src="https://example.com/tracker.js" defer></script><script src="site.js" defer></script>',
        )
        path.write_text(text, encoding="utf-8")
        self.assertTrue(any("third-party resource request" in error for error in self.errors()))

    def test_missing_internal_asset_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        path.write_text(path.read_text(encoding="utf-8").replace('src="assets/logo.png"', 'src="assets/missing.png"'), encoding="utf-8")
        self.assertTrue(any("missing or not allowlisted" in error for error in self.errors()))

    def test_same_site_download_metadata_request_is_allowed(self) -> None:
        self.fixture.build_strict_site()
        (self.fixture.docs / "site.js").write_text(
            "const BUILD = Object.freeze({ versionName: '1.0.53-beta.3', versionCode: 58 });\n"
            "fetch('/Moch.apk', { method: 'HEAD' }).then(updateDownloadMetadata);\n",
            encoding="utf-8",
        )
        self.assertEqual(self.errors(), [])

    def test_third_party_fetch_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        (self.fixture.docs / "site.js").write_text(
            "fetch('https://api.example.com/releases').then(updateDownloadMetadata);\n",
            encoding="utf-8",
        )
        self.assertTrue(any("third-party fetch request" in error for error in self.errors()))

    def test_third_party_css_font_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        (self.fixture.docs / "moch.css").write_text(
            '@font-face { font-family: remote; src: url("https://example.com/font.woff2"); }\n',
            encoding="utf-8",
        )
        self.assertTrue(any("third-party resource request" in error for error in self.errors()))

    def test_css_image_set_string_url_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        (self.fixture.docs / "moch.css").write_text(
            '.hero { background-image: image-set("https://example.com/tracker.png" 1x); }\n',
            encoding="utf-8",
        )
        self.assertTrue(any("third-party resource request" in error for error in self.errors()))

    def test_computed_fetch_access_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "site.js"
        text = path.read_text(encoding="utf-8")
        path.write_text(text + "globalThis['fetch']('https://example.com/track');\n", encoding="utf-8")
        self.assertTrue(any("computed network API access" in error for error in self.errors()))

    def test_js_only_control_must_start_disabled(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        text = path.read_text(encoding="utf-8").replace(
            "<h2>On-device proof</h2>",
            '<button class="step-button" type="button" data-step-button="1">Step</button><h2>On-device proof</h2>',
        )
        path.write_text(text, encoding="utf-8")
        self.assertTrue(any("JS-only control" in error for error in self.errors()))

    def test_hidden_step_control_is_not_an_accepted_fallback(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        text = path.read_text(encoding="utf-8").replace(
            "<h2>On-device proof</h2>",
            '<button class="step-button" type="button" hidden data-step-button="1">Step</button><h2>On-device proof</h2>',
        )
        path.write_text(text, encoding="utf-8")
        self.assertTrue(any("JS-only control" in error for error in self.errors()))

    def test_copy_label_control_must_start_disabled(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "setup.html"
        text = path.read_text(encoding="utf-8").replace(
            "<h2>1. Environment</h2>",
            '<button class="copy-button" type="button" data-copy-label="Copy"><span>Copy</span></button><h2>1. Environment</h2>',
        )
        path.write_text(text, encoding="utf-8")
        self.assertTrue(any("JS-only control" in error for error in self.errors()))

    def test_missing_csp_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        text = path.read_text(encoding="utf-8")
        text = re.sub(r'\s*<meta http-equiv="Content-Security-Policy"[^>]*>', '', text)
        path.write_text(text, encoding="utf-8")
        self.assertTrue(any("CSP must restrict" in error for error in self.errors()))

    def test_missing_fragment_target_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        path.write_text(
            path.read_text(encoding="utf-8").replace('<a href="setup.html">Setup</a>', '<a href="#missing">Setup</a>', 1),
            encoding="utf-8",
        )
        self.assertTrue(any("missing fragment target" in error for error in self.errors()))

    def test_asset_provenance_sidecars_stay_in_repo_but_not_publish(self) -> None:
        self.fixture.build_strict_site()
        assets = self.fixture.docs / "assets"
        (assets / "og-image.png.json").write_text("{}\n", encoding="utf-8")
        (assets / "ASSET-PROVENANCE.md").write_text("provenance\n", encoding="utf-8")
        (assets / "moch" / "PROVENANCE.md").write_text("provenance\n", encoding="utf-8")
        publish, errors = check_site.verify_site(self.fixture.root)
        self.assertEqual(errors, [])
        self.assertNotIn("assets/og-image.png.json", publish)
        self.assertNotIn("assets/ASSET-PROVENANCE.md", publish)
        self.assertNotIn("assets/moch/PROVENANCE.md", publish)
        destination = self.base / "staged"
        check_site.stage_site(self.fixture.root, publish, destination)
        self.assertFalse((destination / "assets" / "og-image.png.json").exists())
        self.assertFalse((destination / "assets" / "ASSET-PROVENANCE.md").exists())
        self.assertFalse((destination / "assets" / "moch" / "PROVENANCE.md").exists())

    def test_build_version_drift_fails_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        path = self.fixture.docs / "index.html"
        path.write_text(path.read_text(encoding="utf-8").replace("1.0.53-beta.3", "1.0.53-beta.2"), encoding="utf-8")
        self.assertTrue(any("data-version must match Gradle" in error for error in self.errors()))

    def test_wrong_social_image_dimensions_fail_strict_mode(self) -> None:
        self.fixture.build_strict_site()
        (self.fixture.docs / "assets" / "og-image.png").write_bytes(png_header(1200, 600))
        self.assertTrue(any("expected 1200×630" in error for error in self.errors()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
