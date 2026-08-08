"""
Validate Play Store screenshots before upload.

Written because the five files that were sitting in assets/screenshots/ had
correct names and correct dimensions (1080x1920) and were still worthless — each
one an empty dark frame reading "Take screenshot from running app". Dimensions
alone prove nothing, so this also flags images that are almost entirely one
colour, which is what a placeholder looks like to a machine.

Rules are from Google's own documentation, checked 2026-08-07:
https://support.google.com/googleplay/android-developer/answer/9866151

Usage:  python store-assets/check_screenshots.py [folder]
        (default folder: store-assets/screenshots)
"""

import os
import sys
import glob

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is needed:  pip install Pillow")

FOLDER = sys.argv[1] if len(sys.argv) > 1 else os.path.join("store-assets", "screenshots")

MIN_SIDE = 320
MAX_SIDE = 3840
MAX_BYTES = 8 * 1024 * 1024
PROMO_MIN_SHORT_SIDE = 1080          # needed to be eligible for Play promotion
PROMO_MIN_COUNT = 4
HARD_MIN_COUNT = 2                   # needed to publish at all


def describe(path):
    im = Image.open(path)
    w, h = im.size
    return im, w, h, os.path.getsize(path)


def flatness(im):
    """
    Fraction of pixels taken by the single most common colour.

    A real screenshot of this app sits around 0.3-0.6 (dark background, but with
    cards, text and charts on it). The placeholders measured 0.93+.
    """
    small = im.convert("RGB").resize((160, 284))
    # getcolors() over getdata(): one call instead of 45k Python-level
    # iterations, and getdata() is deprecated from Pillow 14.
    colors = small.getcolors(maxcolors=160 * 284)
    if not colors:
        return 0.0
    return max(c for c, _ in colors) / float(160 * 284)


def main():
    if not os.path.isdir(FOLDER):
        print("FAIL  no such folder: %s" % FOLDER)
        print("      create it and put the final screenshots there")
        return 1

    files = sorted(p for p in glob.glob(os.path.join(FOLDER, "*"))
                   if p.lower().endswith((".png", ".jpg", ".jpeg")))
    if not files:
        print("FAIL  %s is empty" % FOLDER)
        return 1

    print("checking %d file(s) in %s\n" % (len(files), FOLDER))
    errors, warnings, promo_ready = [], [], 0

    for p in files:
        name = os.path.basename(p)
        try:
            im, w, h, size = describe(p)
        except Exception as e:
            errors.append("%s: unreadable (%s)" % (name, e))
            continue

        notes = []
        short, long_ = min(w, h), max(w, h)

        if short < MIN_SIDE or long_ > MAX_SIDE:
            errors.append("%s: %dx%d outside the 320-3840 px range" % (name, w, h))
        if long_ > 2 * short:
            errors.append("%s: %dx%d — long side is more than 2x the short side "
                          "(ratio %.2f). Crop to 9:16." % (name, w, h, long_ / short))
        if size > MAX_BYTES:
            errors.append("%s: %.1f MB exceeds the 8 MB limit" % (name, size / 1e6))

        # Screenshots must NOT carry an alpha channel (the app ICON must; these must not).
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            errors.append("%s: has an alpha channel — save as 24-bit PNG or JPEG" % name)

        if short >= PROMO_MIN_SHORT_SIDE and abs((long_ / short) - 16 / 9) < 0.02:
            promo_ready += 1
            notes.append("promo-eligible")
        else:
            notes.append("NOT promo-eligible (needs 1080x1920 exactly 9:16)")

        f = flatness(im)
        if f > 0.85:
            errors.append("%s: %.0f%% of the image is a single colour — this looks "
                          "like a placeholder, not a screenshot" % (name, f * 100))
        elif f > 0.7:
            warnings.append("%s: %.0f%% single colour — check it is not mostly empty"
                            % (name, f * 100))

        print("  %-34s %4dx%-5d %-5s %6.1f KB  %s"
              % (name, w, h, im.mode, size / 1024, ", ".join(notes)))

    print()
    if len(files) < HARD_MIN_COUNT:
        errors.append("only %d screenshot(s); Google requires at least %d to publish"
                      % (len(files), HARD_MIN_COUNT))
    if promo_ready < PROMO_MIN_COUNT:
        warnings.append("%d promo-eligible screenshot(s); %d+ at 1080x1920 are needed "
                        "to be eligible for Play promotion"
                        % (promo_ready, PROMO_MIN_COUNT))

    for w_ in warnings:
        print("WARN  " + w_)
    for e in errors:
        print("FAIL  " + e)

    if errors:
        print("\n%d problem(s) — do not upload yet." % len(errors))
        return 1
    print("\nOK — %d screenshot(s) pass every Play Store rule "
          "(%d promo-eligible)." % (len(files), promo_ready))
    return 0


if __name__ == "__main__":
    sys.exit(main())
