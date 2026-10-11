/**
 * What a page that failed to render shows instead: said plainly, with a reload, which also fetches
 * a newer build's code when the old one is gone, and the way back to the documents.
 */
import { useEffect } from "react";
import { useNavigate, useRouteError } from "react-router-dom";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { AlertCircle, Files, RotateCw } from "lucide-react";
import { t } from "../i18n/i18n";
import "../styles/auth.css";

export function RouteError() {
  const error = useRouteError();
  const nav = useNavigate();
  // The page shows none of it; the console keeps it for whoever looks into it.
  useEffect(() => console.error(error), [error]);
  return (
    <Center axis="horizontal" className="auth-page">
      <EmptyState
        title={t("pages.routeError.title")}
        description={t("pages.routeError.body")}
        icon={<AlertCircle size={28} />}
        actions={
          <HStack gap={2}>
            <Button label={t("pages.routeError.reload")} icon={<RotateCw size={16} />} variant="primary" onClick={() => window.location.reload()} />
            <Button label={t("common.allDocuments")} icon={<Files size={16} />} variant="secondary" onClick={() => nav("/")} />
          </HStack>
        }
      />
    </Center>
  );
}
