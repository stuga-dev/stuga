# Interface languages

The web app is written in English and translated into the languages in
`@stuga/protocol/domain/ui-languages` (`UI_LANGUAGES`). A person's choice lives on their account
(`/api/me/language`); without one, the browser's languages decide. The page loads one language
before it renders and reloads to change it.

## Writing interface text

Every string a person reads goes through the catalog:

```tsx
import { t } from "../i18n/i18n";

<Button label={t("library.newFolder")} />
toast({ body: t("library.folderCreated", { name }), type: "info" });
```

- **Keys** are `<namespace>.<area>.<name>`: the namespace is the file in `messages/en/`, one per
  part of the app; the rest says where the text sits (`library.share.copyLink`). Words used all
  over (Cancel, Save, Untitled…) are in `common`.
- **Messages are ICU.** Arguments are `{name}`; numbers that vary need plurals, never a ternary:
  `"{count, plural, one {# row} other {# rows}}"`. Format a number inside a message as
  `{count, number}`. Write ’ and “ ”, never `'`, which ICU reads as a quote.
- **Whole sentences.** Never build a sentence from fragments or concatenate translated parts:
  word order differs by language. Give the message the variable parts as arguments.
- **Elements inside a sentence** use `tRich` from `rich.tsx` with tags:
  `tRich("node.backups.where", { link: (chunks) => <Link to="…">{chunks}</Link> })` for
  `"Backups go to <link>Storage</link>."`.
- **Keys are written out.** Never assemble a key at run time; map a value to its key with a
  `Record<Value, MessageKey>`, so the type checker and the unused-key test see every key.
- **Dates, times, numbers and sizes** come from `lib/format.ts` (`relativeTime`, `shortDate`,
  `fmtInt`, `byteSize`…), which format in the reader's locale. Never call `toLocaleString()`
  without `formatLocale()`.
- **Sorting** text a person reads uses `localeCompare(other, formatLocale())`.
- **Search over labels** (the slash menu, the command palette) matches the translated label and
  the English one, so either finds the item.
- **Text that becomes data** is written in the creator's language, as a document app does. A new
  document is created with no title, which each reader sees as `t("common.untitled")` in their own
  language until its first line or a rename names it.
- **What stays English**: names, identifiers, and anything sent to agents or models. Mark such a
  line `// i18n-exempt: <why>`.

`t()` works at module scope in code the app loads after the catalog (everything under `App`);
`literals.test.ts` fails if a module loaded before it (main.tsx and its imports) translates at import.

## Checks

- `catalog.test.ts`: every language has every English key and keeps each message's arguments,
  plurals and tags; every English message parses and is used. `I18N_NAMESPACE=editor` checks one.
- `literals.test.ts`: no new English outside the catalog. `LITERALS_REPORT=src/editor` lists
  every finding under a path; `UPDATE_LITERALS_BASELINE=1` rewrites the baseline after extraction.
- `pnpm --filter @stuga/web i18n:check` reports missing translations and English changed since
  translation; `--accept` records the current English once every language is up to date.

## Translating

Translations are written by AI against `glossary.md`, which fixes each product term and each
language's style. Changing an English message means translating it again in every language.
`?lang=en-XA` (development only) shows pseudo-text: accented, longer, bracketed, to find text that
skipped the catalog and layouts that clip.
