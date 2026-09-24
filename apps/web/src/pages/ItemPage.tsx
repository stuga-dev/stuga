/**
 * /doc/:docId. Documents and databases share one id namespace, so every link
 * lands here: the metadata is fetched once, access is gated, and the item's own
 * page renders with the row in hand.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useToast } from "@astryxdesign/core/Toast";
import { FileText } from "lucide-react";
import { Docs, type DocSummary } from "../api";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { NoAccessCard } from "../document/NoAccessCard";
import { LoadFailed } from "../ui/LoadFailed";
import { DocPage } from "./DocPage";
import { DatabasePage } from "./DatabasePage";
import { errorMessage } from "../lib/http/client";
import "../styles/editor.css";
import "../styles/review.css";
import "../styles/ask.css";
import "../styles/database.css";

/** What the fetch concluded, remembered with the id it answers so it never describes the next item. */
type Load =
  | { docId: string; kind: "ready"; doc: DocSummary }
  | { docId: string; kind: "no-access" }
  | { docId: string; kind: "failed" };

export function ItemPage() {
  const { docId } = useParams<{ docId: string }>();
  const [load, setLoad] = useState<Load | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    Docs.get(docId).then(
      (doc) => {
        if (!cancelled) setLoad({ docId, kind: "ready", doc });
      },
      (e: unknown) => {
        if (cancelled) return;
        // 403 and 404 are one surface, so existence is never leaked.
        const status = (e as { status?: number }).status;
        setLoad({ docId, kind: status === 403 || status === 404 ? "no-access" : "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [docId, attempt]);

  const retry = useCallback(() => {
    setLoad(null);
    setAttempt((n) => n + 1);
  }, []);

  if (!docId) return <div>Missing document id.</div>;

  // The row in hand must be this item's: on the render after a navigation the state still answers the previous id.
  const current = load?.docId === docId ? load : null;
  if (current?.kind === "no-access") return <NoAccessCard docId={docId} />;
  if (current?.kind === "failed") {
    return (
      <AppShell>
        <Section padding={6} variant="transparent">
          <VStack gap={3} hAlign="center" style={{ paddingTop: "20vh" }}>
            <LoadFailed title="Couldn’t open this item" icon={<FileText size={28} />} onRetry={retry} />
          </VStack>
        </Section>
      </AppShell>
    );
  }
  if (current?.kind !== "ready") {
    return (
      <AppShell>
        <Section padding={6} variant="transparent">
          <VStack gap={3} hAlign="center" style={{ paddingTop: "20vh" }}>
            <Spinner label="Loading…" />
          </VStack>
        </Section>
      </AppShell>
    );
  }

  const { doc } = current;
  if (doc.doc_type === "database") {
    // The data plane refuses a trashed database, so its grid must not mount.
    if (doc.trashed) {
      return <TrashedDatabaseCard doc={doc} onRestored={(d) => setLoad({ docId, kind: "ready", doc: d })} />;
    }
    return <DatabasePage key={doc.doc_id} doc={doc} />;
  }
  return <DocPage key={doc.doc_id} doc={doc} />;
}

/** Says "database", never "table": a table is one tab inside a database. */
function TrashedDatabaseCard({ doc, onRestored }: { doc: DocSummary; onRestored: (d: DocSummary) => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    try {
      onRestored(await Docs.trash(doc.doc_id, false));
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't restore the database."), type: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="doc-noaccess">
      <div className="doc-noaccess__card">
        <h1>This database is in Trash</h1>
        <p>
          Restore it to view and edit its tables. Items in Trash are deleted permanently after {TRASH_RETENTION_DAYS} days.
        </p>
        <HStack gap={2} justify="center">
          <Button label="All documents" variant="secondary" onClick={() => nav("/")} />
          <Button label={busy ? "Restoring…" : "Restore"} variant="primary" isDisabled={busy} onClick={restore} />
        </HStack>
      </div>
    </div>
  );
}
