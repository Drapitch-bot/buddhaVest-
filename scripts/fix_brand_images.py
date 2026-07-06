"""
fix_brand_images.py
-------------------
Crops each brand_* PNG to its tight content bounds (removes transparent padding),
then resizes dark and light variants of each pair so they have IDENTICAL pixel
dimensions.  The light image is the reference; dark is cropped-and-scaled to match.

Run from the project root:
    pip install pillow
    python scripts/fix_brand_images.py
"""

from pathlib import Path
from PIL import Image

ASSETS = Path(__file__).parent.parent / "assets"

PAIRS = [
    ("brand_dark_monk.png",  "brand_light_monk.png"),
    ("brand_dark_text.png",  "brand_light_text.png"),
    ("brand_dark_icon.png",  "brand_light_icon.png"),
]


def crop_to_content(img: Image.Image) -> Image.Image:
    """Crop the image to the bounding box of non-transparent pixels.
    If the image has no alpha channel, crop to non-white pixels instead."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        _, _, _, alpha = rgba.split()
        bbox = alpha.getbbox()          # box of non-transparent pixels
    else:
        # Fallback: convert to RGBA via grayscale difference from white
        gray = img.convert("L")
        # Treat near-white (>250) as background
        from PIL import ImageOps
        inverted = ImageOps.invert(gray)
        bbox = inverted.getbbox()

    if bbox is None:
        return img   # fully transparent / blank — return as-is
    return img.crop(bbox)


def process_pair(dark_name: str, light_name: str):
    dark_path  = ASSETS / dark_name
    light_path = ASSETS / light_name

    if not dark_path.exists() or not light_path.exists():
        print(f"  SKIP — file not found: {dark_name} or {light_name}")
        return

    dark_img  = Image.open(dark_path).convert("RGBA")
    light_img = Image.open(light_path).convert("RGBA")

    print(f"\n{dark_name}")
    print(f"  original dark  size: {dark_img.size}")
    print(f"  original light size: {light_img.size}")

    dark_cropped  = crop_to_content(dark_img)
    light_cropped = crop_to_content(light_img)

    print(f"  cropped  dark  size: {dark_cropped.size}")
    print(f"  cropped  light size: {light_cropped.size}")

    # Use the LARGER of the two cropped sizes as the target
    # (scale the smaller one UP rather than down, preserving detail)
    target_w = max(dark_cropped.width,  light_cropped.width)
    target_h = max(dark_cropped.height, light_cropped.height)

    def fit_into(img: Image.Image, w: int, h: int) -> Image.Image:
        """Scale img to fit exactly within (w × h), maintaining aspect ratio,
        then centre it on a transparent canvas of size (w × h).
        NOTE: thumbnail() only DOWNSCALES — resize() handles both up and down."""
        scale   = min(w / img.width, h / img.height)
        new_w   = max(1, round(img.width  * scale))
        new_h   = max(1, round(img.height * scale))
        resized = img.resize((new_w, new_h), Image.LANCZOS)
        canvas  = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        x = (w - resized.width)  // 2
        y = (h - resized.height) // 2
        canvas.paste(resized, (x, y), resized)
        return canvas

    dark_final  = fit_into(dark_cropped,  target_w, target_h)
    light_final = fit_into(light_cropped, target_w, target_h)

    print(f"  → saving both at   {dark_final.size}")

    dark_final.save(dark_path,  "PNG", optimize=True)
    light_final.save(light_path, "PNG", optimize=True)
    print(f"  ✓ saved {dark_name} and {light_name}")


def main():
    print("BuddhaVest — brand image normaliser")
    print("="*40)
    for dark, light in PAIRS:
        process_pair(dark, light)
    print("\nDone.  Re-run `npx expo start --clear` to pick up the new images.")


if __name__ == "__main__":
    main()
