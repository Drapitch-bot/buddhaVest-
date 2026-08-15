"""
Tests for article extraction: images, and where the text stops.

Reported 2026-08-15, from the app on a real phone: translated articles cut off
mid-sentence, and every chart and photo was missing. Two one-line causes.

  `if len(items) >= 20: break`  — a normal article is 30-60 blocks, so the
  reader got the first third and no indication there was more.

  `find_all(["h1","h2","h3","p"])` — images, lists and captions were dropped
  before anything else ran. The result read like a wall of grey text.

The image half is the part that fails quietly, because a broken <img> renders
as nothing at all and looks identical to "this article had no pictures". Most
of what follows is therefore about _image_src.

Run:  python test_article_images.py
"""

import sys
import types

src = open("main.py", encoding="utf-8").read()


def extract(name):
    start = src.index("def %s(" % name)
    lines = src[start:].split("\n")
    body = [lines[0]]
    for line in lines[1:]:
        if line and not line[0].isspace():
            break
        body.append(line)
    return "\n".join(body)


mod = types.ModuleType("art")
mod.__dict__["swallow"] = lambda where, exc=None, **f: None
# _image_src calls _validate_public_url; the SSRF rules are tested elsewhere,
# so stand in a permissive version and keep this file about image selection.
mod.__dict__["_validate_public_url"] = lambda u: u
exec(src[src.index("_IMG_JUNK = ("):src.index("def _image_src")], mod.__dict__)
exec(extract("_image_src"), mod.__dict__)
img_src = mod._image_src

from bs4 import BeautifulSoup

PAGE = "https://example.com/news/2026/markets-today.html"
FAILURES = []


def check(name, got, want):
    ok = got == want
    print("  %-4s %-60s %s" % ("ok" if ok else "FAIL", name,
                               "" if ok else "got %r want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def tag(html):
    return BeautifulSoup(html, "html.parser").find("img")


print("\n── lazy loading: the real file is not in src ──")
# This is the common case on news sites, and reading src first returns a blank
# pixel on exactly the pages people actually open.
check("data-src wins over a placeholder src",
      img_src(tag('<img src="data:image/gif;base64,R0lGOD" data-src="/img/chart.png">'), PAGE),
      "https://example.com/img/chart.png")
check("data-lazy-src is read",
      img_src(tag('<img data-lazy-src="https://cdn.example.com/a.jpg">'), PAGE),
      "https://cdn.example.com/a.jpg")
check("data-original is read",
      img_src(tag('<img data-original="/photos/b.jpg">'), PAGE),
      "https://example.com/photos/b.jpg")
check("plain src still works",
      img_src(tag('<img src="https://cdn.example.com/plain.jpg">'), PAGE),
      "https://cdn.example.com/plain.jpg")

print("\n── srcset: take the widest, not the first ──")
# These candidates are document-relative, so the expected result is resolved
# against the article's own directory - not against the site root. My first
# version of this test asserted the root and was simply wrong about how
# urljoin works.
BASE = "https://example.com/news/2026/"
check("widest of three",
      img_src(tag('<img srcset="s.jpg 400w, m.jpg 800w, l.jpg 1600w">'), PAGE), BASE + "l.jpg")
check("srcset without descriptors",
      img_src(tag('<img srcset="only.jpg">'), PAGE), BASE + "only.jpg")
check("a malformed width does not raise",
      img_src(tag('<img srcset="a.jpg xxw, b.jpg 900w">'), PAGE), BASE + "b.jpg")
check("absolute srcset candidate is not re-rooted",
      img_src(tag('<img srcset="https://cdn.example.com/big.jpg 1600w">'), PAGE),
      "https://cdn.example.com/big.jpg")

print("\n── relative paths must be resolved against the article ──")
check("root-relative", img_src(tag('<img src="/i/x.png">'), PAGE),
      "https://example.com/i/x.png")
check("document-relative", img_src(tag('<img src="x.png">'), PAGE),
      "https://example.com/news/2026/x.png")
check("protocol-relative", img_src(tag('<img src="//cdn.example.com/x.png">'), PAGE),
      "https://cdn.example.com/x.png")
check("already absolute is left alone",
      img_src(tag('<img src="https://other.com/x.png">'), PAGE), "https://other.com/x.png")

print("\n── junk that is an <img> but is not a picture ──")
for name, html in [
    ("logo",          '<img src="/assets/logo.svg">'),
    ("site icon",     '<img src="/static/icon-192.png">'),
    ("author avatar", '<img src="/authors/avatar123.jpg">'),
    ("sprite sheet",  '<img src="/img/sprite.png">'),
    ("tracking pixel","<img src=\"/t/pixel.gif\">"),
    ("1x1",           '<img src="/img/1x1.gif">'),
    ("blank",         '<img src="/img/blank.png">'),
    ("placeholder",   '<img src="/img/placeholder.jpg">'),
    ("ad slot",       '<img src="https://doubleclick.net/x.gif">'),
    ("tiny by width", '<img src="/img/real.jpg" width="16" height="16">'),
    ("tiny with px",  '<img src="/img/real.jpg" width="20px">'),
]:
    check("%s rejected" % name, img_src(tag(html), PAGE), None)

print("\n── a real image with real dimensions is kept ──")
check("large image kept",
      img_src(tag('<img src="/img/chart.png" width="1200" height="800">'), PAGE),
      "https://example.com/img/chart.png")
check("no dimensions declared -> kept",
      img_src(tag('<img src="/img/photo.jpg">'), PAGE),
      "https://example.com/img/photo.jpg")

print("\n── nothing usable -> None, never an exception ──")
for name, html in [
    ("no src at all",   '<img alt="x">'),
    ("empty src",       '<img src="">'),
    ("whitespace src",  '<img src="   ">'),
    ("data: only",      '<img src="data:image/png;base64,iVBOR">'),
    ("empty srcset",    '<img srcset="">'),
]:
    check(name, img_src(tag(html), PAGE), None)
for name, t in [("tag is None", None), ("tag is a string", "not a tag")]:
    try:
        check(name, img_src(t, PAGE), None)
    except Exception as e:
        check(name + " -> no exception", "raised %r" % (e,), "no exception")

print("\n── the extraction limits, read out of the source ──")
# Asserting on the source because the surrounding function is an async endpoint
# that fetches the network; what matters is that the two numbers that caused
# the bug are gone and did not come back.
# Both markers must be located from the SAME starting point: "if not items:"
# occurs earlier in the file as well, and slicing to the first one produced an
# empty string that silently passed nothing.
_start = src.index('bs_tags = body.find_all(')
block = src[_start:src.index('if not items:', _start)]
import re as _re
# "len(items) >= 20" is a substring of "len(items) >= 200", so a plain `in`
# check reported the old limit as still present when it was not. Match the
# number exactly.
check("no 20-block cut-off",
      bool(_re.search(r"len\(items\) >= 20\b", block)), False)
check("the new block ceiling is 200",
      bool(_re.search(r"len\(items\) >= 200\b", block)), True)
check("bounded by characters", "chars >= 24000" in block, True)
check("images extracted", '"img"' in block, True)
check("list items extracted", '"li"' in block, True)
check("captions extracted", '"figcaption"' in block, True)
check("image URLs are not sent to the translator",
      'raw_texts = [t if kind != "img" else ""' in src, True)
check("image URLs are escaped into the attribute",
      '_html.escape(payload, quote=True)' in src, True)

print("\n" + ("PASS — all checks green" if not FAILURES
              else "FAIL — %d: %s" % (len(FAILURES), ", ".join(FAILURES))))
sys.exit(1 if FAILURES else 0)
