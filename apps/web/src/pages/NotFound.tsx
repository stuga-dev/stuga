/** An address that leads nowhere in the app: said plainly, with the way back to the documents. */
import { useNavigate } from "react-router-dom";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Button } from "@astryxdesign/core/Button";
import { Compass, Files } from "lucide-react";
import { t } from "../i18n/i18n";
import "../styles/auth.css";

export function NotFound() {
  const nav = useNavigate();
  return (
    <Center axis="horizontal" className="auth-page">
      <EmptyState
        title={t("pages.notFound.title")}
        description={t("pages.notFound.body")}
        icon={<Compass size={28} />}
        actions={<Button label={t("common.allDocuments")} icon={<Files size={16} />} variant="primary" onClick={() => nav("/")} />}
      />
    </Center>
  );
}
