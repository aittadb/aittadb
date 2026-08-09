import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("audit attribution migration preserves events and removes the legacy JSON field", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const validActor = "a".repeat(43);
    sqlite.exec(
      await readFile(
        new URL("../../db/migrations/0001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    sqlite
      .prepare(
        "INSERT INTO audit_events (type, data_json, created_at) VALUES (?, ?, ?)",
      )
      .run(
        "legacy-attributed",
        JSON.stringify({ actor_subject_hash: validActor, detail: "keep" }),
        2,
      );
    sqlite
      .prepare(
        "INSERT INTO audit_events (type, data_json, created_at) VALUES (?, ?, ?)",
      )
      .run("unattributed", JSON.stringify({ detail: "unchanged" }), 1);
    sqlite
      .prepare(
        "INSERT INTO audit_events (type, data_json, created_at) VALUES (?, ?, ?)",
      )
      .run(
        "invalid-legacy-string",
        JSON.stringify({ actor_subject_hash: "actor-a", detail: "keep-short" }),
        3,
      );
    sqlite
      .prepare(
        "INSERT INTO audit_events (type, data_json, created_at) VALUES (?, ?, ?)",
      )
      .run(
        "invalid-legacy-attribution",
        JSON.stringify({ actor_subject_hash: 7, detail: "keep-too" }),
        4,
      );
    sqlite
      .prepare(
        "INSERT INTO audit_events (type, data_json, created_at) VALUES (?, ?, ?)",
      )
      .run("legacy-invalid-json", "not-json", 5);

    sqlite.exec(
      await readFile(
        new URL(
          "../../db/migrations/0011_audit_actor_attribution.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    const rows = sqlite
      .prepare(
        "SELECT type, data_json, actor_subject_hash FROM audit_events ORDER BY id ASC",
      )
      .all();
    assert.equal(rows.length, 5);
    assert.deepEqual(
      { ...rows[0] },
      {
        type: "legacy-attributed",
        data_json: JSON.stringify({ detail: "keep" }),
        actor_subject_hash: validActor,
      },
    );
    assert.deepEqual(
      { ...rows[1] },
      {
        type: "unattributed",
        data_json: JSON.stringify({ detail: "unchanged" }),
        actor_subject_hash: null,
      },
    );
    assert.deepEqual(
      { ...rows[2] },
      {
        type: "invalid-legacy-string",
        data_json: JSON.stringify({ detail: "keep-short" }),
        actor_subject_hash: null,
      },
    );
    assert.deepEqual(
      { ...rows[3] },
      {
        type: "invalid-legacy-attribution",
        data_json: JSON.stringify({ detail: "keep-too" }),
        actor_subject_hash: null,
      },
    );
    assert.deepEqual(
      { ...rows[4] },
      {
        type: "legacy-invalid-json",
        data_json: "not-json",
        actor_subject_hash: null,
      },
    );
    assert.deepEqual(
      sqlite
        .prepare("PRAGMA index_info('idx_audit_events_actor_subject')")
        .all()
        .map((row) => row.name),
      ["actor_subject_hash", "created_at", "id"],
    );
    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO audit_events (type, data_json, actor_subject_hash, created_at) VALUES (?, ?, ?, ?)",
          )
          .run("invalid-direct", "{}", "not-canonical", 6),
      /CHECK constraint failed/,
    );
    assert.equal(
      Number(
        sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get()
          ?.count ?? 0,
      ),
      5,
    );
  } finally {
    sqlite.close();
  }
});
