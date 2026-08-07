export default function Page() {
  return (
    <main className="page">
      <h1>Sites Auth Broker</h1>
      <p>
        ChatGPT signs the person into this app inside ChatGPT Sites. Sites Auth
        Broker then creates a separate local user and issues its own OAuth 2.0,
        OpenID Connect, and JWT sessions.
      </p>
      <p>
        This is a REST API and authentication service. See{" "}
        <a href="/docs">API docs</a> or <a href="/health">health metadata</a>.
      </p>
    </main>
  );
}
