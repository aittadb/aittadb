# AittaDB Browser UI Style Guide

AittaDB is a hosted application backend for third-party apps, services, and agents. Its browser UI must stay focused on the signed-in user's real AittaDB identity and data operations, service metadata, and mandatory browser-mediated protocol steps. The expected quality level is contemporary ChatGPT Sites generated pages: careful spacing, strong typographic hierarchy, polished panels, responsive composition, and purposeful visual treatment. The UI must not look like an unstyled form or a default server error page.

This style guide describes style-level alignment only. Do not copy ChatGPT product branding, imply affiliation, or make AittaDB-issued tokens look like OpenAI or ChatGPT tokens.

## Page Model

Use one shared application-backend shell for all normal HTML responses:

- A full-bleed visual panel that communicates the sign-in, separate AittaDB identity, session, and application-data boundary.
- One focused content panel for the current task.
- A consistent AittaDB wordmark and footer linking to `https://github.com/aittadb/aittadb`.
- No broad site navigation, marketing sections, testimonials, pricing, blog content, dashboard, or user profile.

The normal page set is limited to service metadata, the protected local-session boundary, account-deletion request/status outcomes, health, real OAuth/OIDC protocol forms and results, real storage operation forms and results, device-code entry, device approval or denial, OAuth consent, OAuth errors, administrator client registration, and the interactive OpenAPI viewer.

The public service home is an operation map, not a simulated demo. Its links must enter real user-facing production routes. Do not promote sign-in-flow internals such as authorization, device authorization initiation, consent, token exchange, revocation, or introspection as ordinary user operations; clients enter those routes as part of their protocol flows, and developers can open their forms directly or through Swagger UI. The protected session view must use the production Sites identity adapter and durable local-user repository; protocol and storage forms must invoke the same services, scope checks, and persistence as non-browser API requests. Never add mock sign-in, sample-only tokens, fake storage, or browser-only grants.

## Terminology

Lead with **hosted application backend for third-party apps**. Follow with the concrete capabilities available now: ChatGPT sign-in inside ChatGPT Sites, AittaDB-issued sessions, isolated JSON records, and file storage. Treat persistent events as planned until implemented. Do not lead with OAuth/OIDC terminology or describe AittaDB as only an authentication broker.

Use **Identity / Data / Files / Events** as the compact product-capability label. Whenever the page explains capabilities in prose, make clear that Events is planned while identity, data, and files are available now.

Describe AittaDB positively as a source-available project deployed on OpenAI-hosted ChatGPT Sites. Keep hero summaries short and capability-focused; do not repeat detailed licensing, platform, or credential-boundary prose beneath the title and again in a nearby notice. State the essential trust boundary once and link to the complete licensing/platform explanation. The detailed documentation must explain that the current implementation depends on OpenAI-hosted ChatGPT Sites for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets; current public releases use FSL-1.1-MIT and convert to MIT after two years; and an MIT license for immediate use is also available commercially. Do not call the current public FSL release open source or imply technical independence from the platform.

The home-page trust notice uses one concise boundary sentence: `ChatGPT provides browser sign-in inside ChatGPT Sites; AittaDB creates a separate local identity, issues its own credentials, and never receives or forwards ChatGPT credentials.` Keep the compact license label and details link outside that sentence instead of repeating licensing or platform prose. Later references on the same page may say "ChatGPT sign-in." Do not present the standalone phrase "Sites identity" to users.

Elsewhere, always pair the upstream description with the same boundary: AittaDB creates a separate user with an immutable UUID, issues its own tokens, and stores application data only inside AittaDB. Those tokens are not OpenAI or ChatGPT tokens. This wording explains the real sign-in source without implying affiliation or a general ChatGPT OAuth service.

Keep the OpenAI boundary as secondary trust copy, not the lead product description: AittaDB is not affiliated with or endorsed by OpenAI. Keep `officialOpenAIProduct` for JSON clients, but do not render "Official OpenAI product: no" as a browser metadata row.

Label the downstream credential source as **Session issuer**, never **Token authority**. The latter can be mistaken for AI-model token accounting. Supporting copy may name OAuth, OIDC, and JWT credentials explicitly.

Call current-session D1/R2 storage the user's private or signed-in AittaDB namespace. Do not call it "browser-session storage" because that suggests temporary browser state; the data is durable even though a reserved internal browser client provides its isolation boundary.

## Brand System

The product name is **AittaDB**. Render the wordmark as two adjacent spans so its typography and colors cannot drift:

- `Aitta`: Inter, weight `750`, midnight navy `#0B234A`.
- `DB`: Inter, weight `750`, red-orange `#F04A32`.
- Font fallback order: `Inter, system-ui, "Segoe UI", sans-serif`.
- Icon accent: cool teal `#159CA6`.

Use `public/aittadb-mark.svg` as the canonical mark and favicon. It depicts a geometric storehouse containing three data bars and event nodes. Do not redraw, recolor, rotate, crop, add effects inside, or combine it with OpenAI or ChatGPT marks. Keep the navy and red-orange wordmark on a light surface when it overlays the dark visual panel.

## Visual Direction

Prefer:

- A calm, high-trust application-backend aesthetic.
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

Use `public/og.png` as the canonical 1200x630 PNG social preview. It carries the exact AittaDB wordmark and the sentence "ChatGPT sign-in, app-ready identity and data." Root-page Open Graph and X metadata must use a concise, current product description and reference the image through an absolute URL derived from the configured issuer. `public/robots.txt` permits public preview crawling. Review the rendered card for exact text and logo fidelity whenever it is replaced.

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

The client-administration collection combines one labeled creation form with a readable client table. Each row exposes only operations valid for that client: disable or enable according to state, secret rotation only for confidential or service clients, and grant revocation. Service registration makes redirect and browser-origin controls unavailable and lists only enabled AittaDB data scopes; Events scopes disappear when their feature is off. The equivalent hypermedia document must advertise the same controls and one-time submission field. Successful HTML mutations use Post/Redirect/Get; the redirected page presents a human-readable result and browser refresh performs only the GET. A newly generated secret is labeled with its client, announced as a one-time result, and absent from every later page or document.

Storage and UserInfo forms use an explicit authentication selector. Prefer the current signed-in session when available and otherwise prefer explicit access-token mode. Hide and disable the bearer field in session mode, reveal and require it in token mode, and leave it visible without JavaScript so the form still works through server validation.

Each storage URL owns its browser interface. A collection page renders a useful list or explicit empty state plus navigation to a logical key. `GET /storage/files` also presents the real collection-level `POST` upload form. Use a labeled native file input as the accessible baseline; drag and drop may progressively select that input, must provide status text, and must not upload without the user's explicit submit action. A successful current-session upload redirects with `303` only to its validated same-origin canonical item URL, where refresh is a read-only `GET`; explicit-token HTML stays on its immediate `201` result because a redirected session would select a different namespace. An item page may expose `GET`, `PUT`, and `DELETE` actions only for the key already encoded in that exact URL. Do not use an operation selector to mix collection and item URLs, and never accept a second form key that can override an item URL. Render record values, file metadata, results, and errors as readable HTML rather than a JSON dump. A download response may leave the shell to return the actual attachment.

`/auth-ui.js` is the only general progressive-enhancement script. It is same-origin, CSP-compatible, and limited to conditional form disclosure plus encoded storage-item navigation. Initial markup must remain complete without it: conditional controls start enabled, collection navigation submits `?key=...`, and the server validates and redirects to the canonical same-origin item path. Client-side visibility never replaces server authorization, CSRF, origin, scope, key, method, or request-size checks.

## Hypermedia Equivalence

One URI serves equivalent application state and capabilities. `Accept: text/html` renders links, forms, tables, details, and errors for people; the versioned JSON representation renders `data`, semantic `links`, and currently available `actions` for machines. Do not select HTML from `User-Agent`, build separate `/api` and `/web` trees, or expose a button in HTML without its equivalent authorized JSON action. OAuth/OIDC wire responses remain standards-compliant where an AittaDB envelope would break interoperability.

The root remains publicly readable so clients can discover the issuer and begin OAuth flows before authentication. Its primary session control says **Sign in** only when the trusted Sites identity is absent and **Sign out** when it is present. Identity-aware browser operations enter through `/session`, which starts the Sites-owned ChatGPT sign-in flow when needed and displays only the signed-in user's local AittaDB subject. The current session may use its isolated browser-client storage and UserInfo; it is never a substitute for a third-party client's registration, redirect URI, PKCE, consent, scopes, token, secret, revocation, or introspection requirements. For an eligible non-administrator, the page ends with one plainly labeled account-deletion form: explain the local-account consequence, require the exact human phrase, keep CSRF and encrypted confirmation hidden, use the danger button style, and never show internal job detail or a deployment-wide deletion control. The accepted page says processing started without claiming completion and offers the canonical status resource. That status page renders exactly one coarse pending, running, retry, or completed value. Pending/running expose one same-URI refresh button, retry exposes one same-URI recovery button, and the completed status action exposes only `/signout-with-chatgpt?return_to=%2F`; it never targets `/`, `/session`, or another identity-aware route. Keep the shared brand/footer navigation. HTML status controls and hypermedia actions must match exactly.

`/docs` uses the self-hosted Swagger UI distribution inside the branded wide documentation layout. Load its CSS and scripts only from checked-in same-origin assets, point it at the canonical `/openapi.json`, disable persisted authorization, and keep the raw JSON link available. "Try it out" must call the origin serving the viewer, including on a custom domain, rather than trusting a stale server URL. Do not populate examples with working secrets or production credentials.

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
- Check inactive conditional fields are hidden, disabled, and required only when visible, while the no-JavaScript form remains complete.
- Check collection and item storage pages expose only operations owned by their exact resource URL.
- Check file collections show list/empty state and the `POST` upload control, drag and drop remains keyboard-accessible progressive enhancement, and item `PUT` is labeled as create or update according to state.
- Check HTML and JSON advertise equivalent authorized operations and root sign-in/sign-out state agrees with the trusted Sites identity.
- Check Swagger can execute a simple same-origin `GET` through "Try it out" without disturbing operation or Schemas controls.
- Check `aittadb-boundary.jpg` remains local, decorative, and free of text, marks, secrets, PII, and deployment identifiers.
- Check `og.png` is 1200x630, uses exact brand text, and is advertised through issuer-derived root metadata.
- Check errors are content-aware and not default/plain server output.
