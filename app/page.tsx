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
      <h1>Identity, data, and files for third-party applications.</h1>
      <p>
        Identity, sessions, JSON data, and files for connected applications.
      </p>
      <p>
        Source-available under FSL-1.1-MIT. AittaDB runs on OpenAI-hosted
        ChatGPT Sites, issues its own credentials, and never forwards ChatGPT
        credentials. See <Link href="/docs">API docs</Link>,{" "}
        <Link href="/health">health metadata</Link>, or the{" "}
        <Link href="https://github.com/aittadb/aittadb#licensing">
          project repository
        </Link>
        .
      </p>
    </main>
  );
}
