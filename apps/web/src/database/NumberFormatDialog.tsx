/**
 * How a number column reads: plain, money or a percentage, how many decimals, and whether
 * thousands are grouped. Display only: the stored numbers, what agents read and what a filter
 * compares stay the plain values. Changing it is a person's act, like a retype.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { DATABASE_NUMBER_MAX_DECIMALS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec, NumberFormat } from "@stuga/protocol/databases/types";
import { Databases } from "../api";
import { formatLocale, t } from "../i18n/i18n";
import { formatNumber } from "./model/numbers";

interface NumberFormatDialogProps {
  isOpen: boolean;
  docId: string;
  tableId: string;
  /** null while the dialog is closed; it stays mounted between openings. */
  column: ColumnSpec | null;
  onSaved: () => void;
  onError: (e: unknown, fallback: string) => void;
  onClose: () => void;
}

const AUTO = "auto";
const SAMPLE = 1234.5;

/** Where a region's own currency is not the euro, among the regions the interface languages are spoken in. */
const REGION_CURRENCY: Record<string, string> = {
  US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", IN: "INR", JP: "JPY", CN: "CNY", TW: "TWD", HK: "HKD", KR: "KRW",
  BR: "BRL", MX: "MXN", AR: "ARS", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK",
};

/** The reader's own currency, from their locale's region; the euro otherwise. */
function defaultCurrency(locale: string): string {
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).maximize().region;
  } catch {
    region = undefined;
  }
  return (region && REGION_CURRENCY[region]) ?? "EUR";
}

function currencyOptions(locale: string): Array<{ value: string; label: string }> {
  const codes = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : ["EUR", "USD", "GBP", "JPY", "CNY", "SEK"];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "currency" });
  } catch {
    names = null;
  }
  return codes.map((code) => ({ value: code, label: `${names?.of(code) ?? code} (${code})` }));
}

export function NumberFormatDialog({ isOpen, docId, tableId, column, onSaved, onError, onClose }: NumberFormatDialogProps) {
  const locale = formatLocale();
  const [style, setStyle] = useState<NumberFormat["style"]>("number");
  const [decimals, setDecimals] = useState<string>(AUTO);
  const [grouping, setGrouping] = useState(false);
  const [currency, setCurrency] = useState(() => defaultCurrency(locale));
  const [saving, setSaving] = useState(false);
  const currencies = useMemo(() => currencyOptions(locale), [locale]);

  // Every opening re-seeds from the column on screen.
  useEffect(() => {
    if (!isOpen) return;
    const f = column?.options?.format;
    setStyle(f?.style ?? "number");
    setDecimals(f?.decimals === undefined ? AUTO : String(f.decimals));
    setGrouping(f ? f.grouping === true : false);
    setCurrency(f?.currency ?? defaultCurrency(locale));
    setSaving(false);
  }, [isOpen, column, locale]);

  const format: NumberFormat = {
    style,
    ...(decimals === AUTO ? {} : { decimals: Number(decimals) }),
    ...(grouping ? { grouping: true } : {}),
    ...(style === "currency" ? { currency } : {}),
  };
  const current = column?.options?.format ?? null;

  async function save(next: NumberFormat | null) {
    if (column === null) return;
    setSaving(true);
    try {
      await Databases.setColumnFormat(docId, tableId, column.column_id, next);
      onSaved();
      onClose();
    } catch (e) {
      onError(e, t("database.numberFormat.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const close = () => !saving && onClose();
  const decimalOptions = [
    { value: AUTO, label: t("database.numberFormat.decimalsAuto") },
    ...Array.from({ length: DATABASE_NUMBER_MAX_DECIMALS + 1 }, (_, n) => ({ value: String(n), label: formatNumber(n, undefined, locale) })),
  ];

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={t("database.numberFormat.title")} subtitle={column?.display ?? ""} onOpenChange={(o) => !o && close()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Selector
                label={t("database.numberFormat.style")}
                options={[
                  { value: "number", label: t("database.numberFormat.styleNumber") },
                  { value: "currency", label: t("database.numberFormat.styleCurrency") },
                  { value: "percent", label: t("database.numberFormat.stylePercent") },
                ]}
                value={style}
                onChange={(v) => setStyle(v as NumberFormat["style"])}
              />
              {style === "currency" && (
                <Selector label={t("database.numberFormat.currency")} options={currencies} value={currency} onChange={(v) => setCurrency(String(v))} hasSearch />
              )}
              <Selector label={t("database.numberFormat.decimals")} options={decimalOptions} value={decimals} onChange={(v) => setDecimals(String(v))} />
              <CheckboxInput label={t("database.numberFormat.grouping")} value={grouping} onChange={(v) => setGrouping(v === true)} />
              <Text type="supporting" color="secondary">
                {t("database.numberFormat.example", { example: formatNumber(SAMPLE, format, locale) })}
              </Text>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="between">
              <span>
                {current !== null && (
                  <Button label={t("database.numberFormat.clear")} variant="ghost" onClick={() => void save(null)} isDisabled={saving} />
                )}
              </span>
              <HStack gap={2}>
                <Button label={t("common.cancel")} variant="ghost" onClick={close} isDisabled={saving} />
                <Button label={t("common.save")} variant="primary" onClick={() => void save(format)} isDisabled={saving || column === null} isLoading={saving} />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
