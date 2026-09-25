# HumanOS conversation design

The approved screen is a quiet, warm ivory conversation. Charcoal carries the primary action; cobalt marks World trust and keyboard focus. A message, mandate, approval, or receipt reads as one step in a human conversation, with advanced evidence disclosed on demand.

## Visual references

- Mobile, inspected at original detail (853 × 1853): `/Users/saikarthik/.codex/generated_images/01a0d731-9301-7b92-9e3c-b2980fda7912/exec-2d8afea0-9a82-4afd-bd87-131404756d7b.png`
- Desktop, inspected at original detail (1505 × 1045): `/Users/saikarthik/.codex/generated_images/01a0d731-9301-7b92-9e3c-b2980fda7912/exec-8921cfba-ac4f-4354-ad84-2b87c84a6ffc.png`

These are composition references, not sample mission data or proof of a live provider. The mobile image shows one full-height column with a compact header, roomy transcript, 1px bordered reviews, and a bottom composer. The desktop image shows a pale 260px rail, approximately 820px conversation column, compact 72px heading, narrow transcript rows, and a low composer.

## Implementable system

- Colors: canvas `#fbfaf7`, surface `#fffefa`, ink `#242827`, muted `#616a67`, hairline `#e1e3de`, quiet fill `#f3f4f1`, cobalt `#1769d2`, danger `#9d3832`. No gradients, glass or nested dashboard cards.
- Type: DM Sans or a closely matched sans serif; body 15–16px with 1.5 line height; secondary 12–13px; title 20–23px. Use weight and whitespace for hierarchy, with tabular numerals for timestamps and hashes.
- Spacing scale: 4, 8, 12, 16, 24, 32 and 48px. Message groups have 20–28px vertical rhythm. Review blocks use 16–24px interior padding, 10–12px radii and a 1px hairline. Control heights are at least 44px.
- Mobile: one `100dvh` column with top and bottom safe-area insets; no horizontal overflow at 320px or 200% zoom. Header is 56–64px. Transcript and composer share a grid so the last message stays visible above the composer, including when a keyboard changes viewport height. Mission, identity and connection navigation appears in focus-managed modal sheets.
- Desktop: at `min-width: 1100px`, show a collapsible 260px left rail. Keep the transcript and composer centered within `max-width: 840px` (acceptable 760–880px). The header is compact; no permanent right dashboard.
- Interactions: human messages have a quiet surface and right alignment; agent text stays left aligned. Identity, ENS and progress are compact semantic rows. Mandate and approval are full-width readable reviews with explicit actions. The sensitive approval leads with the action effect and gives exact payload hash, nonce and expiry in a disclosure. Terminal denial and receipts use separate status rows. Composer sends the first task; subsequent changes are driven by explicit review buttons. The rail folds into sheets with Escape, focus trap and focus restoration.
- Accessibility: skip link, semantic `main`, headings, `role="status"` and `role="alert"`, visible 3px focus, reduced motion, accessible names on icon controls, and contrast that remains legible on the ivory canvas.
