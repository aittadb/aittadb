import Image from "next/image";
import Link from "next/link";

export default function Page() {
  return (
    <main className="page">
      <Link className="brand-lockup" href="/" aria-label="AittaDB service home">
        <Image src="/aittadb-mark.svg" width={52} height={52} alt="" />
        <span className="brand-wordmark" aria-label="AittaDB">
          <span className="brand-aitta">Aitta</span>
          <span className="brand-db">DB</span>
        </span>
      </Link>
      <p className="eyebrow">Hosted application backend</p>
      <h1>Sign-in, data, and files for third-party applications.</h1>
      <p>
        AittaDB runs inside ChatGPT Sites. It maps ChatGPT sign-in to a separate
        AittaDB user, issues its own OAuth 2.0 and OpenID Connect sessions, and
        provides persistent JSON records and file storage isolated by user and
        client.
      </p>
      <p>
        Third-party apps, services, and agents use AittaDB through its REST and
        hypermedia APIs. See <Link href="/docs">API docs</Link> or{" "}
        <Link href="/health">health metadata</Link>.
      </p>
    </main>
  );
}
