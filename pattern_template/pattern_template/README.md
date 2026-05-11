# Pattern Template Fragment Composition

The SIS pattern template was a single 950-line HTML file. To support SaCaSIS (and future variants) without duplicating 90% of the template, the template is now stored as a set of HTML fragments plus a per-variant manifest. A small Node.js build script concatenates fragments in manifest order and writes the assembled template, which is then uploaded to the `SIS_TEMPLATES` KV namespace — exactly as before. The formatter Worker is unchanged in spirit: it still reads one HTML blob from one KV key.

## Layout

```
pattern_template/
├── manifest.json              ← declares variants and their fragment lists
├── build.js                   ← concatenates + (optionally) uploads to KV
├── build/                     ← assembled per-variant templates (git-ignored)
│   ├── sis.html
│   └── sacasis.html
└── fragments/
    ├── shared/                ← reused across every variant
    │   ├── 01_head.html               (DOCTYPE → </head>, styles, paged.js script)
    │   ├── 02_body_open_cover.html    (<body>, cover image)
    │   ├── 03_pattern_details.html    (Section 1)
    │   ├── 06_back.html               (Section 4)
    │   ├── 07_sleeves.html            (Section 5)
    │   ├── 08_assembly.html           (Section 6)
    │   ├── 09_neckband.html           (Section 7: V-neck band)
    │   ├── 10_finished_measurements.html  (schematic SVG + size table)
    │   └── 11_closing.html            (footer + </body></html>)
    ├── sis/                   ← SIS-only fragments
    │   ├── 04_abbreviations.html
    │   └── 05_front.html              (Section 3, plain stockinette)
    └── sacasis/               ← SaCaSIS-only fragments
        ├── 04_abbreviations.html      (adds C2R, C2L, Sand st)
        └── 05_front.html              (Section 3, with central cable panel)
```

Fragment ordering is encoded in the numeric prefix purely as a visual hint; the manifest is the source of truth. The build script reads files exactly in the order listed under `fragments` and concatenates them with no separator and no transformation. That's it — no templating engine, no preprocessing, no conditional rendering at this layer. Conditional rendering inside the assembled template (e.g. `<!--TDCR_IF ...-->` blocks, `<!--SACASIS_IF ...-->` blocks) is handled by the formatter prompt downstream, just as it is today.

## Workflows

**Build all variants:**
```
node build.js
```

**Build a subset:**
```
node build.js sis
node build.js sacasis
```

**Verify the round-trip — confirm that the assembled SIS matches the legacy `/mnt/project/pattern_template` byte-for-byte:**
```
node build.js --verify-sis
```
This is a regression check. Run it after any change to a shared fragment.

**Build and upload to Cloudflare KV** (requires `wrangler` on PATH and the `SIS_TEMPLATES` binding configured in `wrangler.toml`):
```
node build.js --upload
node build.js sacasis --upload    # build just sacasis, then upload it
```

The upload command runs, per variant:
```
wrangler kv key put --binding=SIS_TEMPLATES --remote <kv_key> --path build/<variant>.html
```

The `<kv_key>` comes from the manifest. For SIS it stays `pattern_template`, so the existing formatter Worker reads exactly the same key as before — the migration is invisible to it. For SaCaSIS the manifest assigns `sacasis_pattern_template`.

## Adding a new variant

1. Create a directory under `fragments/` named after the variant (e.g. `fragments/dropshoulder/`).
2. Put any variant-specific fragments in there. Anything not overridden falls back to the corresponding `shared/` fragment.
3. Add a new entry under `variants` in `manifest.json` with:
   - a `kv_key` (the name the formatter Worker will look up)
   - a `description`
   - a `fragments` array listing the assembly order, mixing `shared/…` paths with `<variant>/…` paths
4. `node build.js <variant> --verify-sis` (always re-verify SIS after touching anything shared)
5. Update the formatter Worker to route the new `kv_key` based on whatever input field discriminates the variant (see "Formatter integration" below).

## Editing a shared fragment

A shared fragment lives in `fragments/shared/` and is consumed by every variant in the manifest. Edits to it affect every variant. After editing:

```
node build.js --verify-sis
```

The verify step will fail loudly if your edit changed SIS output unintentionally. If the edit is meant to change SIS, regenerate the reference by uploading the new SIS build to KV — there's no separate snapshot to update.

## Formatter integration

The `sis-formatter` Worker (see `sis_formatter.txt`) already routes between SIS and TDCR by reading `pattern_type` from the calculator JSON and picking the right KV keys:

```js
const isTdcr = calcJson.pattern_type === "tdcr";
const promptKey   = isTdcr ? "tdcr_formatter_prompt"  : "formatter_prompt";
const templateKey = isTdcr ? "tdcr_pattern_template"  : "pattern_template";
```

To extend it for SaCaSIS, switch to a small registry rather than a chain of ternaries:

```js
const TEMPLATE_REGISTRY = {
  sis:     { promptKey: "formatter_prompt",      templateKey: "pattern_template" },
  sacasis: { promptKey: "formatter_prompt",      templateKey: "sacasis_pattern_template" },
  tdcr:    { promptKey: "tdcr_formatter_prompt", templateKey: "tdcr_pattern_template" },
};

const variantKey = calcJson.variant ?? calcJson.pattern_type ?? "sis";
const { promptKey, templateKey } = TEMPLATE_REGISTRY[variantKey]
  ?? (() => { throw new Error(`Unknown variant: ${variantKey}`); })();
```

The calculator already emits `variant: "sacasis"` when `inputs.Variant === "sacasis"` (see `SIS_calculator_with_sacasis__1_.js`), so the formatter can read it directly. SaCaSIS uses the same formatter prompt as SIS because the substitution rules and conditional-block syntax are identical; only the template body differs.

## What this does NOT do

- **No conditional inclusion of fragments based on JSON.** The manifest is static per variant. If you need dynamic content within a variant (e.g. "include text node F only when `Node_F_result == 'YES'`"), use the existing comment-marker mechanism in the formatter prompt (`<!--SIS_IF …-->` / `<!--SIS_END-->`). Fragment composition operates one level up from that.
- **No partial overrides.** A variant either supplies its own fragment for a given slot or uses the shared one. There is no "inherit and patch" mechanism. If a variant needs to change one paragraph of `shared/06_back.html`, it must copy the whole file into `<variant>/06_back.html` and edit there. This is intentional — it keeps the build script trivial and makes the per-variant content fully auditable in one place.
- **No templating syntax in fragments.** The `{variable_name}` placeholders are still substituted by the formatter at runtime, not by the build script. The build script just concatenates bytes.

## Current SaCaSIS status

`fragments/sacasis/04_abbreviations.html` and `fragments/sacasis/05_front.html` are scaffolds with `⚠ TODO` markers showing exactly which calculator outputs each section needs to consume (`{SaCaSIS_K}`, `{SaCaSIS_Panel_sts}`, `{SaCaSIS_Division_row}`, etc.). The `<!--SACASIS_IF ...-->` blocks mirror the structure of the SIS Text Nodes E1a / E1b / E1_WS / F / G / H. Filling these in is the remaining work to ship SaCaSIS end-to-end; the assembly mechanics are already in place and verified.
