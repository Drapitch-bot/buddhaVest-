"""
Several paragraphs in one request — and the guarantee that it can only ever be
faster, never wrong.

deep_translator opens a fresh HTTPS request per string, so a 46-minute
transcript meant one round trip per paragraph. Packing paragraphs into one
request needs a marker, and a marker is a thing a translator can mangle: it can
drop one, duplicate one, reorder them, translate the digits, or wrap them in
spaces. Every one of those, if trusted, shifts the article by a paragraph and
puts the wrong sentence under the wrong heading.

So nothing trusts it. _split_marked verifies the answer against what was sent
and returns None at the first thing that does not add up, and the caller then
does it the slow, certain way. These cases are that promise, written as the
ways it could be broken.

Run:  python test_translate_group.py
"""
import re
import sys

import main

_split = main._split_marked
_plan = main._plan_groups

bad = 0


def check(name, got, want):
    global bad
    ok = got == want
    print("  %s  %s%s" % ("ok  " if ok else "FAIL", name.ljust(58),
                          "" if ok else "  got %r want %r" % (got, want)))
    if not ok:
        bad += 1


def marked(*pieces):
    return "\n\n".join("[[[%d]]]\n%s" % (i, p) for i, p in enumerate(pieces))


print("\n  a clean answer")
check("three paragraphs come back in order",
      _split(marked("שלום", "עולם", "היום"), 3), ["שלום", "עולם", "היום"])
check("one paragraph",
      _split(marked("שלום"), 1), ["שלום"])
check("a paragraph containing brackets of its own",
      _split(marked("הרווח [3] עלה", "שורה"), 2), ["הרווח [3] עלה", "שורה"])
# Translators like to put spaces inside brackets. The parser tolerates it on
# purpose: falling back for a cosmetic space would throw away the fast path on
# most real answers.
check("markers padded with spaces still parse",
      _split("[[[ 0 ]]]\nראשון\n\n[[ [1] ]]\nשני", 2), ["ראשון", "שני"])
check("  and spaced right out",
      _split("[ [ [0] ] ]\nראשון\n\n[ [ [1] ] ]\nשני", 2), ["ראשון", "שני"])
check("extra blank lines around a marker",
      _split("\n\n[[[0]]]\n\n\nראשון\n\n\n[[[1]]]\n\nשני\n\n", 2), ["ראשון", "שני"])

print("\n  every way it could be mangled must give up, not guess")
check("a marker was dropped",
      _split("[[[0]]]\nראשון\n\nשני", 2), None)
check("a marker was duplicated",
      _split(marked("א", "ב") + "\n\n[[[1]]]\nג", 2), None)
check("the markers came back out of order",
      _split("[[[1]]]\nשני\n\n[[[0]]]\nראשון", 2), ["ראשון", "שני"])
check("an index beyond what was sent",
      _split("[[[0]]]\nא\n\n[[[7]]]\nב", 2), None)
check("a negative index",
      _split("[[[0]]]\nא\n\n[[[-1]]]\nב", 2), None)
check("a paragraph came back empty",
      _split("[[[0]]]\nא\n\n[[[1]]]\n   \n", 2), None)
check("more markers than paragraphs sent",
      _split(marked("א", "ב", "ג"), 2), None)
check("fewer markers than paragraphs sent",
      _split(marked("א"), 2), None)
check("the whole answer is empty", _split("", 2), None)
check("the answer is None", _split(None, 2), None)
check("no markers at all — a translator that stripped them",
      _split("ראשון שני שלישי", 3), None)

print("\n  packing")
short = ["a" * 100] * 10
check("ten short paragraphs travel together", len(_plan(short)), 1)
check("  and every index is accounted for",
      sorted(i for g in _plan(short) for i in g), list(range(10)))

many = ["a" * 100] * 60
plan = _plan(many)
check("sixty are split by the count cap", len(plan) > 1, True)
check("  no group exceeds the count cap",
      all(len(g) <= main._GROUP_MAX for g in plan), True)
check("  every index still accounted for, once",
      sorted(i for g in plan for i in g), list(range(60)))

longs = ["b" * 2000] * 5
plan = _plan(longs)
check("long paragraphs are split by size", len(plan) > 1, True)
check("  no group exceeds the character budget",
      all(sum(len(longs[i]) + 16 for i in g) <= main._GROUP_CHARS or len(g) == 1
          for g in plan), True)
check("  every index accounted for", sorted(i for g in plan for i in g), list(range(5)))

huge = ["c" * 9000]
check("a single oversized paragraph is still sent, alone", _plan(huge), [[0]])
check("nothing in, nothing out", _plan([]), [])

print("\n  the marker survives being built")
one = "[[[0]]]\n" + "x" * 10
check("the pattern the builder writes is the pattern the parser reads",
      bool(main._JOIN_RE.search(one)), True)

print("\n  %s" % ("%d failing" % bad if bad else "all passing"))
sys.exit(1 if bad else 0)
