"""Draws the two test cards of the phone image proof (docs/PHONE_IMAGES.md): a landscape and a portrait picture, both 1024 px or less.

Each card has a coloured frame, a label in every corner (so a mirrored or cropped picture is obvious), a grey ramp (so a wrong colour space
shows as washed-out or too dark steps) and the red, green, blue and skin-tone bars. Pure Pillow, no network. Run from the project folder:
python scripts/make_phone_test_cards.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'phone-images'
CARDS = {'card-wide': (1024, 576), 'card-tall': (576, 1024)}


def font(size):
    for name in ('arialbd.ttf', 'arial.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def card(name, width, height):
    image = Image.new('RGB', (width, height), (24, 28, 40))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, width - 1, height - 1], outline=(255, 214, 0), width=12)
    draw.rectangle([12, 12, width - 13, height - 13], outline=(0, 220, 230), width=4)
    small, big = font(30), font(54)
    for text, xy, anchor in (('TL', (28, 24), 'la'), ('TR', (width - 28, 24), 'ra'), ('BL', (28, height - 24), 'ld'), ('BR', (width - 28, height - 24), 'rd')):
        draw.text(xy, text, fill=(255, 255, 255), font=small, anchor=anchor)
    draw.text((width // 2, int(height * 0.18)), 'PHONE IMAGE TEST', fill=(255, 214, 0), font=big, anchor='mm')
    draw.text((width // 2, int(height * 0.18) + 56), f'{name}  {width}x{height}', fill=(0, 220, 230), font=small, anchor='mm')
    # Grey ramp, 16 steps from black to white: the middle steps show a colour-space mistake.
    ramp_top, ramp_height = int(height * 0.34), int(height * 0.16)
    steps, left, right = 16, 40, width - 40
    for i in range(steps):
        value = round(255 * i / (steps - 1))
        draw.rectangle([left + (right - left) * i // steps, ramp_top, left + (right - left) * (i + 1) // steps - 1, ramp_top + ramp_height], fill=(value, value, value))
    # Colour bars: red, green, blue, a skin tone, a sky blue.
    bars = [(220, 40, 40), (40, 200, 70), (50, 90, 230), (224, 172, 140), (120, 190, 255)]
    bar_top, bar_height = ramp_top + ramp_height + 24, int(height * 0.18)
    for i, colour in enumerate(bars):
        draw.rectangle([left + (right - left) * i // len(bars), bar_top, left + (right - left) * (i + 1) // len(bars) - 1, bar_top + bar_height], fill=colour)
    # A diagonal and a circle: a stretched picture makes the circle an oval.
    draw.line([(120, height - 70), (width - 120, bar_top + bar_height + 30)], fill=(255, 255, 255), width=3)
    radius = int(min(width, height) * 0.09)
    cx, cy = width // 2, (bar_top + bar_height + height - 40) // 2 + 10
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=(255, 80, 160), width=8)
    return image


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (width, height) in CARDS.items():
        card(name, width, height).save(OUT / f'{name}.png', optimize=True)
        print('wrote', OUT / f'{name}.png')
