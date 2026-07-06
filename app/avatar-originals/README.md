# Avatar originals (pre-lift backups)

These are the **original, un-lifted** agent-avatar PNGs as delivered/generated,
backed up 2026-06-24 before the brightness "lift" pass. Kept here (outside
`public/`) so they are NOT served or bundled — they're a safety copy in case we
want to revert or re-tune.

**Live set (public/avatars/) = the PUNCHIER lift.** Recipe (Pillow):
- brightness ×1.30, contrast ×1.10, saturation ×1.20, gamma 0.80
- thumbnails: 128×128 WebP, quality 82

Alternative (moderate) recipe, if we ever dial back:
- brightness ×1.18, contrast ×1.05, saturation ×1.14, gamma 0.88

To revert an avatar to original: copy the file here back to
`public/avatars/<templates|extras>/<name>.png` and regenerate its
`thumb/<name>.webp` (128px). To re-lift from clean, run the lift on these
originals (never on already-lifted files — don't stack passes).
