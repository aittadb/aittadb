# AittaDB Browser UI Style Guide

AittaDB is a REST API, application-data service, and authentication service, so its browser UI must stay focused on service metadata and mandatory browser-mediated operations. The expected quality level is contemporary ChatGPT Sites generated pages: careful spacing, strong typographic hierarchy, polished panels, responsive composition, and purposeful visual treatment. The UI must not look like an unstyled form or a default server error page.

This style guide describes style-level alignment only. Do not copy ChatGPT product branding, imply affiliation, or make AittaDB-issued tokens look like OpenAI or ChatGPT tokens.

## Page Model

Use one shared authentication-service shell for all normal HTML responses:

- A full-bleed visual panel that communicates the sign-in, independent identity, session, and application-data boundary.
- One focused content panel for the current task.
- A consistent AittaDB wordmark and footer linking to `https://github.com/aittadb/aittadb`.
- No broad site navigation, marketing sections, testimonials, pricing, blog content, dashboard, or user profile.

The normal page set is limited to service metadata, the protected local-session boundary, health, real OAuth/OIDC protocol forms and results, real storage operation forms and results, device-code entry, device approval or denial, OAuth consent, OAuth errors, administrator client registration, and the interactive OpenAPI viewer.

The public service home is an operation map, not a simulated demo. Its links must enter the real production routes. The protected session view must use the production Sites identity adapter and durable local-user repository; protocol and storage forms must invoke the same services, scope checks, and persistence as non-browser API requests. Never add mock sign-in, sample-only tokens, fake storage, or browser-only grants.

## Terminology

The first user-facing reference to the upstream authentication must say "ChatGPT sign-in inside ChatGPT Sites." Later references on the same page may say "ChatGPT sign-in." Do not present the standalone phrase "Sites identity" to users.

Always pair the upstream description with the boundary: AittaDB creates a separate user with an immutable UUID, issues its own tokens, and stores application data only inside AittaDB. Those tokens are not OpenAI or ChatGPT tokens, and AittaDB never forwards ChatGPT credentials. This wording explains the real sign-in source without implying affiliation or a general ChatGPT OAuth service.

Label the downstream credential source as **Session issuer**, never **Token authority**. The latter can be mistaken for AI-model token accounting. Supporting copy may name OAuth, OIDC, and JWT credentials explicitly.

## Brand System

The product name is **AittaDB**. Render the wordmark as two adjacent spans so its typography and colors cannot drift:

- `Aitta`: Inter, weight `750`, midnight navy `#0B234A`.
- `DB`: Inter, weight `750`, red-orange `#F04A32`.
- Font fallback order: `Inter, system-ui, "Segoe UI", sans-serif`.
- Icon accent: cool teal `#159CA6`.

Use `public/aittadb-mark.svg` as the canonical mark and favicon. It depicts a geometric storehouse containing three data bars and event nodes. Do not redraw, recolor, rotate, crop, add effects inside, or combine it with OpenAI or ChatGPT marks. Keep the navy and red-orange wordmark on a light surface when it overlays the dark visual panel.

## Visual Direction

Prefer:

- A calm, high-trust authentication-product aesthetic.
- Off-white or lightly tinted page backgrounds with depth from panels, borders, and shadows.
- Balanced contrast with one dark anchoring area and one light task area.
- Midnight navy `#0B234A` for structural anchors, teal `#159CA6` for active/service accents, and red-orange `#F04A32` for the `DB` wordmark and focused highlights.
- Restrained 6-8px corner radii for the outer shell, controls, and metadata surfaces.
- Original locally hosted imagery that explains the AittaDB boundary, paired with page-specific visual copy.

Avoid:

- Plain black text on default white backgrounds.
- Default browser button/form styling.
- Clip-art, stock-photo filler, generic hero sections, or decorative images unrelated to authentication.
- Runtime-loaded third-party fonts, external images, trackers, or third-party client scripts.
- Purple-blue gradient dominance, one-note palettes, or novelty styling that lowers trust.

## Images and Visual Assets

Images are allowed only when they communicate the AittaDB boundary, carry the product identity, or improve trust in a mandatory auth page. Prefer local, checked-in assets generated or designed specifically for this project. CSS artwork is acceptable when it gives the same level of polish without adding asset-loading risk.

The shared production illustration is `public/aittadb-boundary.jpg`. Its glass apertures show one signal crossing a boundary and resolving into separate AittaDB identity, sessions, and storage. It is decorative in HTML and must retain an empty `alt` attribute because the adjacent visual copy carries the meaning. The canonical brand mark is `public/aittadb-mark.svg`; when an adjacent visible wordmark already names AittaDB, render the mark with an empty `alt` value to avoid duplicate screen-reader output.

Use `public/og.png` as the canonical 1200x630 social preview. It carries the exact AittaDB wordmark and the sentence "ChatGPT sign-in, app-ready identity and data." Root-page Open Graph and X metadata must reference it through an absolute URL derived from the configured issuer. Review the rendered card for exact text and logo fidelity whenever it is replaced.

Any image asset must:

- Be served from this origin.
- Have no embedded secrets, tokens, personal data, or deployment identifiers.
- Avoid OpenAI, ChatGPT, or confusingly similar marks.
- Be reviewed at desktop and mobile widths.
- Have accessible surrounding text; decorative images must be hidden from assistive technology.

Do not add image dependencies to token responses, JSON API responses, or machine-readable metadata.

## Typography and Layout

Self-host the Inter variable font from `public/fonts/inter-latin-wght-normal.woff2`; do not fetch it from a third-party origin. The checked-in `public/fonts/Inter-LICENSE.txt` preserves its SIL Open Font License. Use `Inter, system-ui, "Segoe UI", sans-serif`, keep letter spacing at `0`, and use fixed responsive type steps at explicit breakpoints rather than scaling font size with viewport width. The AittaDB wordmark always uses weight `750`.

Every page should have:

- One clear `h1`.
- A short summary sentence.
- Labels for every input.
- Visible focus states.
- Stable dimensions for forms, tables, buttons, and repeated metadata cards.
- Responsive behavior that keeps buttons and long codes readable on mobile.

## Forms and Tables

Forms must look intentional:

- Full-width labeled inputs inside the task panel.
- Clear primary and secondary actions.
- Validation or error text near the relevant task.
- CSRF fields hidden, never rendered as visible data.

Tables should be used only where density is useful, such as client administration. They need horizontal overflow handling on small screens and clear column headings.

Storage and UserInfo forms use an explicit authentication selector. Prefer the current signed-in session when available and otherwise prefer explicit access-token mode; keep the optional bearer-token field visually distinct. Storage forms use one operation selector rather than simulated cards or client-side state, show record JSON in a monospace textarea, use the native accessible file input for R2 uploads, and render escaped operation results in the shared shell. A download response may leave the shell to return the actual file attachment from the production endpoint.

## Hypermedia Equivalence

HTML pages show available actions as buttons or links. JSON responses should expose equivalent `_links` and `actions` objects where protocol compatibility allows. OAuth token success responses remain standards-compliant and do not include decorative hypermedia.

The root remains publicly readable so clients can discover the issuer and begin OAuth flows before authentication. Identity-aware browser operations enter through `/session`, which starts the Sites-owned ChatGPT sign-in flow when needed and displays only the signed-in user's local AittaDB subject. The current session may use its isolated browser-client storage and UserInfo; it is never a substitute for a third-party client's registration, redirect URI, PKCE, consent, scopes, token, secret, revocation, or introspection requirements.

`/docs` uses the self-hosted Swagger UI distribution inside the branded wide documentation layout. Load its CSS and scripts only from checked-in same-origin assets, point it at the canonical `/openapi.json`, disable persisted authorization, and keep the raw JSON link available. Swagger operations call the real API; do not populate them with working secrets or production credentials as examples.

All AittaDB form, button, heading, table, code-output, and focus selectors must be rooted in the shared shell's direct content or named components. Never use global element selectors that can restyle Swagger controls. Verify operation expansion and the Schemas `Expand all` control after shell CSS changes.

## Review Checklist

Before completing browser UI work:

- Check every HTML response uses the shared shell or a documented exception.
- Check every page supplies content-aware visual copy appropriate to its operation or error state.
- Check every page has the GitHub project affordance.
- Check desktop and mobile layouts do not overlap.
- Check CSP remains compatible with the stylesheet and assets.
- Check the AittaDB mark and wordmark use the canonical assets, colors, Inter weight, and fallback stack.
- Check no runtime-loaded third-party fonts, external images, or scripts were introduced.
- Check `aittadb-boundary.jpg` remains local, decorative, and free of text, marks, secrets, PII, and deployment identifiers.
- Check `og.png` is 1200x630, uses exact brand text, and is advertised through issuer-derived root metadata.
- Check errors are content-aware and not default/plain server output.
