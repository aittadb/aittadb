import { escapeHtml, pageDocument } from "./pages";
import type { ApplicationEventData } from "./events";

export interface ApplicationEventPageItem {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export interface ApplicationEventCollectionPage {
  items: readonly ApplicationEventPageItem[];
  pageSize: number;
  maxPageSize: number;
  typeFilter: string | null;
  nextHref: string | null;
  signedIn: boolean;
}

export function applicationEventCollectionPage(
  page: ApplicationEventCollectionPage,
): string {
  const rows = page.items
    .map(
      (event) =>
        `<tr><td><code>${escapeHtml(event.id)}</code></td><td><code>${escapeHtml(event.type)}</code></td><td>${escapeHtml(dataSummary(event.data))}</td><td>${timeElement(event.createdAt)}</td><td>${timeElement(event.expiresAt)}</td></tr>`,
    )
    .join("");
  const state =
    page.items.length === 0
      ? `<p class="empty-state">No events found${page.typeFilter ? " for this exact type" : ""}.</p>`
      : `<div class="table-wrap"><table class="resource-table"><thead><tr><th>Event ID</th><th>Type</th><th>Data</th><th>Created</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const pagination = page.nextHref
    ? `<nav class="actions" aria-label="Event pages"><a class="button secondary" href="${escapeHtml(page.nextHref)}">Next page</a></nav>`
    : `<p class="note">End of the currently available event collection.</p>`;
  const clearFilter = page.typeFilter
    ? `<a class="button secondary" href="/events?page_size=${page.pageSize}">Clear filter</a>`
    : "";

  return pageDocument({
    title: "Application events",
    eyebrow: "Persistent event stream",
    heading: "Application events",
    summary:
      "Read immutable events from this AittaDB identity and client namespace in deterministic order.",
    visualEyebrow: "Bounded delivery",
    visualHeading: "A durable stream with an opaque position.",
    visualSummary:
      "Every page stays inside one authenticated AittaDB namespace; internal ordering and credentials never enter the representation.",
    body: `<section class="storage-state" aria-labelledby="event-list-heading"><div class="storage-state-heading"><div><h2 id="event-list-heading">Available events</h2><p>${page.items.length} ${page.items.length === 1 ? "event" : "events"} on this page${page.typeFilter ? ` for <code>${escapeHtml(page.typeFilter)}</code>` : ""}.</p></div></div>${state}${pagination}</section><section class="resource-workbench" aria-labelledby="event-filter-heading"><h2 id="event-filter-heading">Filter the collection</h2><form method="get" action="/events" class="stacked-form"><label for="event-type">Exact event type</label><input id="event-type" name="type" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" value="${escapeHtml(page.typeFilter ?? "")}" autocomplete="off"><label for="event-page-size">Page size</label><input id="event-page-size" name="page_size" type="number" min="1" max="${page.maxPageSize}" value="${page.pageSize}" required><div class="actions"><button type="submit">Apply filter</button>${clearFilter}</div></form></section><p class="note">The browser uses only the current ChatGPT-signed-in AittaDB session. API clients use an AittaDB bearer token with <code>events.read</code>. Event data is immutable and isolated from every other user and client namespace.</p>`,
    actions: [
      {
        href: "/session",
        label: page.signedIn ? "My signed-in session" : "Sign in with ChatGPT",
      },
      { href: "/docs", label: "API docs", secondary: true },
    ],
  });
}

export function applicationEventItemPage(
  event: ApplicationEventData,
  collectionHref: string,
): string {
  return pageDocument({
    title: `${event.type} event`,
    eyebrow: "Persistent application event",
    heading: "Event details",
    summary:
      "This immutable event belongs to the current AittaDB user and application namespace.",
    visualEyebrow: "Immutable application state",
    visualHeading: "One event. One subject and client boundary.",
    visualSummary:
      "AittaDB returns an event only when the current session or access token owns its exact namespace.",
    body: `<section class="storage-state" aria-labelledby="event-content-heading"><h2 id="event-content-heading">Event content</h2><section class="info-grid" aria-label="Event metadata"><div><span>Event ID</span><code>${escapeHtml(event.id)}</code></div><div><span>Event type</span><strong>${escapeHtml(event.type)}</strong></div><div><span>Created</span>${timeElement(event.created_at)}</div><div><span>Expires</span>${timeElement(event.expires_at)}</div></section><h3>Event data</h3><pre class="record-value" aria-label="Event JSON data">${escapeHtml(JSON.stringify(event.data, null, 2))}</pre></section>`,
    actions: [{ href: collectionHref, label: "Back to events" }],
  });
}

function dataSummary(value: Record<string, unknown>): string {
  const count = Object.keys(value).length;
  return count === 1 ? "1 top-level field" : `${count} top-level fields`;
}

function timeElement(value: number): string {
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return `<span>${escapeHtml(String(value))} Unix seconds</span>`;
  }
  const iso = date.toISOString();
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`;
}
