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
      <h1>Identity and persistent state for applications.</h1>
      <p>
        ChatGPT signs the person into this app inside ChatGPT Sites. AittaDB
        then creates a separate local user, issues its own OAuth 2.0 and OpenID
        Connect sessions, and isolates application data by user and client.
      </p>
      <p>
        This is a REST and hypermedia API service. See{" "}
        <Link href="/docs">API docs</Link> or{" "}
        <Link href="/health">health metadata</Link>.
      </p>
    </main>
  );
}
