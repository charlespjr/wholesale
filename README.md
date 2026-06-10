# WholesaleOS

A landing page for an AI-powered real estate wholesaling platform — an AI
acquisitions agent (**Remi**), a deal-data engine (**Dealfeed**), and an
orchestration layer (**Atlas**), inspired by the structure of modern REI
SaaS sites.

## Stack

Pure static site — no build step, no dependencies.

- `index.html` — all page sections (hero, how it works, products, stats, testimonials, pricing, FAQ, CTA, footer)
- `styles.css` — dark theme with emerald/cyan gradient accents, fully responsive
- `script.js` — sticky nav, mobile menu, scroll-reveal animations, animated counters, FAQ accordion

## Run locally

Open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Deploy

Works as-is on GitHub Pages, Netlify, Vercel, or Cloudflare Pages — just point
the host at the repository root.

## Customizing

- **Brand name / product names**: search-and-replace `WholesaleOS`, `Remi`, `Dealfeed`, `Atlas` in `index.html`.
- **Colors**: edit the CSS variables at the top of `styles.css` (`--accent`, `--accent-2`, `--bg`).
- **Pricing**: the three tiers live in the `#pricing` section of `index.html`.
