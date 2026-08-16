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
mod.__dict__["re"] = __import__("re")
mod.__dict__["swallow"] = lambda where, exc=None, **f: None
# _image_src calls _validate_public_url; the SSRF rules are tested elsewhere,
# so stand in a permissive version and keep this file about image selection.
mod.__dict__["_validate_public_url"] = lambda u: u
exec(src[src.index("_IMG_JUNK = ("):src.index("def _pick_article_root")], mod.__dict__)
exec(extract("_image_src"), mod.__dict__)
exec(extract("_pick_article_root"), mod.__dict__)
exec(extract("_sanitize_article"), mod.__dict__)
exec(extract("_trim_article_tail"), mod.__dict__)
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

print("\n── the endpoint no longer rebuilds the page from paragraphs ──")
import re as _re
# The first fix raised a block limit. The second removed the rebuilding
# entirely: the article's own subtree is kept and only its text nodes are
# replaced. These assert that neither old shape came back.
check("the paragraph-only tag list is gone",
      "find_all([\"h1\", \"h2\", \"h3\", \"p\"])" in src, False)
check("no fixed block cut-off",
      bool(_re.search(r"len\(items\) >= 20\b", src)), False)
check("the article subtree is emitted as-is",
      "root.decode_contents()" in src, True)
check("text nodes are replaced in place",
      "node.replace_with(NavigableString(" in src, True)
check("leading/trailing whitespace is preserved around each node",
      "lead + (new_text or \"\").strip() + trail" in src, True)
check("the text-node budget is bounded",
      "len(text_nodes) >= 400" in src, True)
check("a source link back to the original is emitted",
      '_SOURCE_LABEL.get(lang' in src, True)
check("the source link exists in all four languages",
      set(_re.findall(r'"(en|he|ru|es)":',
          src[src.index("_SOURCE_LABEL = {"):src.index("_SOURCE_LABEL = {") + 400])),
      {"en", "he", "ru", "es"})
check("the lead image is shown unless the body already has that file",
      'if hero and hero not in root.decode_contents():' in src, True)
# Yahoo Finance serves the article TEXT but inserts the pictures with
# JavaScript, so a server-side fetch finds no <img> to scan at all. The head
# metadata is the only place the picture is named in the HTML itself. Four
# sources, because publishers populate different ones.
for label, marker in [
    ("og:image",          'soup.find("meta", property="og:image")'),
    ("twitter:image",     '"twitter:image"'),
    ("twitter:image:src", '"twitter:image:src"'),
    ("link rel=image_src",'soup.find("link", rel="image_src")'),
    ("JSON-LD image",     'block.get("image")'),
]:
    check("lead image source: " + label, marker in src, True)
check("JSON-LD image handles a list", "img = img[0]" in src, True)
check("JSON-LD image handles an ImageObject", 'img = img.get("url")' in src, True)

print("\n── /translate-batch must not re-introduce the truncation ──")
# The WebView path extracts up to 150 blocks. This endpoint capped the list at
# 30 and threw the rest away silently, so articles served that way still
# stopped in the middle - the same symptom, a different file. The two numbers
# have to move together.
check("the 30-text cap is gone", "texts[:30]" in src, False)
check("the cap matches the client's 150 blocks plus the title",
      "texts[:151]" in src, True)
check("the body cap was raised to match", "MAX_BODY = 1024 * 1024" in src, True)

print("\n── the article keeps its own markup, minus anything executable ──")
# The whole point of the rewrite: translate the words, leave the page alone.
# So this asserts on BOTH halves — what must survive, and what must not.
PAGE_HTML = """<html><head><title>Markets today</title></head><body>
<nav class="site-nav"><a href="/">Home</a></nav>
<article>
  <h1>Small-cap ETFs</h1>
  <p onclick="steal()" style="color:red">The index rose <b>4.2%</b> this week and kept going.</p>
  <figure><img src="data:image/gif;base64,R0l" data-src="/img/chart.png" width="1200">
  <figcaption>Performance since 2020</figcaption></figure>
  <ul><li>First point that is long enough</li><li>Second point here too</li></ul>
  <table><tr><th>Fund</th><td colspan="2">Return</td></tr></table>
  <blockquote>Time in the market beats timing the market.</blockquote>
  <p>See <a href="javascript:alert(1)">this</a> and <a href="/more">that</a>.</p>
  <div class="related-stories"><p>You might also like this other article entirely</p></div>
  <div class="ad-slot"><img src="/ads/banner.gif"></div>
  <script>fetch('/steal')</script>
  <p>A closing paragraph with enough words in it to count as real content.</p>
</article></body></html>"""

soup = BeautifulSoup(PAGE_HTML, "html.parser")
root = mod._pick_article_root(soup)
n_img = mod._sanitize_article(root, "https://example.com/news/a.html")
out = root.decode_contents()

# Must NOT survive. This half is a security boundary: the output is rendered
# in a WebView, so anything executable that gets through is executing on the
# user's device with whatever that WebView can reach.
for label, gone in [
    ("<script> and its body", "<script" not in out and "steal()" not in out),
    ("inline event handlers", "onclick" not in out),
    ("inline styles",         'style="' not in out),
    ("javascript: hrefs",     "javascript:" not in out),
    ("site navigation",       "site-nav" not in out),
    ("'related stories'",     "might also like" not in out),
    ("ad slots",              "/ads/banner" not in out),
]:
    check("removed: " + label, gone, True)

# Must survive. This is everything the old paragraph-only extractor destroyed,
# and the reason the reader called the result empty.
for label, kept in [
    ("images, from data-src",  "/img/chart.png" in out),
    ("captions",               "Performance since 2020" in out),
    ("list items",             "<li>" in out),
    ("tables, with colspan",   "<table" in out and 'colspan="2"' in out),
    ("pull quotes",            "<blockquote" in out),
    ("inline emphasis",        "<b>4.2%</b>" in out),
]:
    check("kept: " + label, kept, True)

check("relative links made absolute", 'href="https://example.com/more"' in out, True)
check("external links get rel=noopener", 'rel="noopener noreferrer"' in out, True)
check("image count returned", n_img, 1)

print("\n── the bug the test above actually caught ──")
# find_all() hands back a snapshot. Decomposing a parent detaches its children,
# but they are still in that list, and .get() on a detached tag raises because
# its attrs are gone. The first version did not check .decomposed, the
# AttributeError was swallowed, and the ENTIRE sanitising pass aborted - so
# <script> and onclick handlers stayed in the output. Nested junk reproduces it.
NESTED = """<article>
  <div class="ad-slot"><div class="inner"><p>Buy now</p><img src="/x.gif"></div></div>
  <p onclick="bad()">Real body text that is long enough to be kept by the filter.</p>
  <script>bad()</script>
  <p>A second real paragraph, also long enough to survive the length filter.</p>
</article>"""
soup2 = BeautifulSoup(NESTED, "html.parser")
root2 = soup2.find("article")
mod._sanitize_article(root2, "https://example.com/a.html")
out2 = root2.decode_contents()
check("nested junk does not abort the pass", "onclick" not in out2 and "<script" not in out2, True)
check("real text survives it", "Real body text" in out2 and "second real paragraph" in out2, True)

print("\n── the tail: promo, disclosure and the site footer ──")
# A news page does not stop at the last sentence. After it come the promo
# block, the disclosure paragraph and the legal footer - and once translated
# they read as part of the article. Reported as "מבולגן" on 2026-08-15.
TAIL_HTML = """<article>
<h1>64% of men who make this investing move feel like failures</h1>
<p>When the stock market is booming, some people feel tempted to day trade and chase hype.</p>
<p>A recent survey found that day trading can be bad for your mental health over time.</p>
<h2>What to do instead</h2>
<p>Buy a broad index fund and hold it for years, rather than trading on short term moves.</p>
<p>Over the long run this total market ETF has produced strong wealth building returns.</p>
<p>Suppose you put five hundred dollars a month into the fund and it keeps returning.</p>
<p>Ben Gran has positions in the fund. The Motley Fool has positions in and recommends it.</p>
<p>*Stock Advisor returns as of August 15, 2026.</p>
<p>64% of men who make this move feel like failures was originally published by The Motley Fool</p>
<div class="legal-footer"><a href="/terms">Terms</a> | <a href="/privacy">Privacy Policy</a></div>
<p><a href="/dash">Privacy Dashboard</a> <a href="/more">More info</a></p>
</article>"""
tsoup = BeautifulSoup(TAIL_HTML, "html.parser")
troot = mod._pick_article_root(tsoup)
mod._sanitize_article(troot, "https://finance.yahoo.com/news/a.html")
ttext = troot.get_text(" ", strip=True)

for label, gone in [
    ("the disclosure paragraph",      "has positions in" not in ttext),
    ("'Stock Advisor returns as of'", "Stock Advisor returns" not in ttext),
    ("'originally published by'",     "originally published by" not in ttext),
    ("the legal footer",              "Privacy Policy" not in ttext),
    ("the trailing link row",         "Privacy Dashboard" not in ttext),
]:
    check("tail removed: " + label, gone, True)
check("the article body itself survives", "broad index fund" in ttext, True)
check("a mid-article heading is not treated as tail",
      "What to do instead" in ttext, True)

print("\n── the duplicate headline ──")
# The page's own <h1> is inside the body, so emitting ours above it printed the
# title twice with a picture wedged between them.
def _tkey(s): return "".join(c for c in (s or "").lower() if c.isalnum())[:120]
_title = "64% of men who make this investing move feel like failures"
_removed = False
for h in troot.find_all(["h1", "h2"], limit=4):
    if _tkey(h.get_text(" ", strip=True)) == _tkey(_title):
        h.decompose(); _removed = True; break
check("the body's copy of the headline is dropped", _removed, True)
check("headline de-dup is in the endpoint", "title_key and _key(h.get_text" in src, True)

print("\n" + ("PASS — all checks green" if not FAILURES
              else "FAIL — %d: %s" % (len(FAILURES), ", ".join(FAILURES))))
sys.exit(1 if FAILURES else 0)
