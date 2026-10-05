# NomadVNC Branding

This folder contains the official branding assets and guidelines for NomadVNC.

## Color Palette

The palette is derived from the Figma color palette generator: [Palette Link](https://www.figma.com/color-palette-generator/?colors=133C4E-A350AA-304B6E-979CF2).

| Color | Hex | HSL | Usage |
|-------|-----|-----|-------|
| **Teal** | `#133C4E` | `198, 61%, 19%` | Core shell depth, status accents, dark gradients |
| **Orchid** | `#A350AA` | `295, 36%, 49%` | Highlight glow, interactive emphasis |
| **Steel** | `#304B6E` | `214, 39%, 31%` | Secondary actions, surface framing, UI chrome |
| **Periwinkle** | `#979CF2` | `237, 78%, 77%` | Primary accent, logo gradient, bright focus states |

## Logo

- `logo.svg`: the NomadVNC mark — a single mono-black vector path
  (512×512 viewBox, no embedded images), the source for every icon.
- `pnpm icons` renders it through a CSS mask onto the branded tile for
  the desktop, Android (adaptive + themed), and iOS icons. The desktop
  sidebar uses a copy at `apps/desktop/src/renderer/public/logo.svg`
  (inverted in dark mode) — keep the two files identical.
- To edit it, use any vector editor (Inkscape, Figma), keep it one flat
  black shape, then optimise with `npx svgo --multipass branding/logo.svg`
  (check the `viewBox` survives).

## Implementation Notes

Branding is implemented via CSS variables in `apps/desktop/src/renderer/styles.css`:

```css
:root {
  --teal: hsl(198, 61%, 19%);
  --orchid: hsl(295, 36%, 49%);
  --steel: hsl(214, 39%, 31%);
  --periwinkle: hsl(237, 78%, 77%);

  --accent: var(--periwinkle);
  --text-primary: hsl(198, 50%, 16%);
}
```
