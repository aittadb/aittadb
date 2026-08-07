# Browser UI Style Guide

Sites Auth Broker is a REST API and authentication service, so its browser UI must stay small. The expected quality level is contemporary ChatGPT Sites generated pages: careful spacing, strong typographic hierarchy, polished panels, responsive composition, and purposeful visual treatment. The UI must not look like an unstyled form or a default server error page.

This style guide describes style-level alignment only. Do not copy ChatGPT product branding, imply affiliation, or make issued broker tokens look like OpenAI or ChatGPT tokens.

## Page Model

Use one shared authentication-service shell for all normal HTML responses:

- A full-bleed visual panel that communicates the identity-to-token broker concept.
- One focused content panel for the current task.
- A consistent footer or badge linking to `https://github.com/sendanor/sites-auth-broker`.
- No broad site navigation, marketing sections, testimonials, pricing, blog content, dashboard, or user profile.

The normal page set is limited to service metadata, health, device-code entry, device approval or denial, OAuth consent, OAuth errors, administrator client registration, and the minimal OpenAPI viewer.

## Visual Direction

Prefer:

- A calm, high-trust authentication-product aesthetic.
- Off-white or lightly tinted page backgrounds with depth from panels, borders, and shadows.
- Balanced contrast with one dark anchoring area and one light task area.
- Teal, blue, green, and warm accent colors used sparingly.
- Restrained 6-8px corner radii for the outer shell, controls, and metadata surfaces.
- Original locally hosted imagery that explains the broker flow, paired with page-specific visual copy.

Avoid:

- Plain black text on default white backgrounds.
- Default browser button/form styling.
- Clip-art, stock-photo filler, generic hero sections, or decorative images unrelated to authentication.
- External fonts, external images, trackers, or third-party client scripts.
- Purple-blue gradient dominance, one-note palettes, or novelty styling that lowers trust.

## Images and Visual Assets

Images are allowed only when they help communicate the broker boundary or improve trust in a mandatory auth page. Prefer local, checked-in assets generated or designed specifically for this project. CSS artwork is acceptable when it gives the same level of polish without adding asset-loading risk.

The shared production asset is `public/broker-aperture.jpg`. Its glass apertures show one signal crossing a boundary and resolving into separate local credentials. It is decorative in HTML and must retain an empty `alt` attribute because the adjacent visual copy carries the meaning. Every page supplies a relevant visual eyebrow, heading, and explanation instead of reusing generic marketing copy.

Any image asset must:

- Be served from this origin.
- Have no embedded secrets, tokens, personal data, or deployment identifiers.
- Avoid OpenAI, ChatGPT, or confusingly similar marks.
- Be reviewed at desktop and mobile widths.
- Have accessible surrounding text; decorative images must be hidden from assistive technology.

Do not add image dependencies to token responses, JSON API responses, or machine-readable metadata.

## Typography and Layout

Use system fonts and keep letter spacing at `0`. Use fixed responsive type steps at explicit breakpoints rather than scaling font size with viewport width.

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

## Hypermedia Equivalence

HTML pages show available actions as buttons or links. JSON responses should expose equivalent `_links` and `actions` objects where protocol compatibility allows. OAuth token success responses remain standards-compliant and do not include decorative hypermedia.

## Review Checklist

Before completing browser UI work:

- Check every HTML response uses the shared shell or a documented exception.
- Check every page supplies content-aware visual copy appropriate to its operation or error state.
- Check every page has the GitHub project affordance.
- Check desktop and mobile layouts do not overlap.
- Check CSP remains compatible with the stylesheet and assets.
- Check no external fonts, images, or scripts were introduced.
- Check `broker-aperture.jpg` remains local, decorative, and free of text, marks, secrets, PII, and deployment identifiers.
- Check errors are content-aware and not default/plain server output.
