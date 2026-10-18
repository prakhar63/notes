# Design system — Notes

How the app looks and behaves, written down so every new screen matches the old ones.
The code is the source of truth: every value here is a token in `styles.css` (`:root`).
If you change a token, update this file in the same commit.

Visual references: the Claude Design canvas "Notes App Layouts"
(https://claude.ai/artifact/JvU4vZy8REMJzdiiX5HusP). Page **UI ideas** is the current look; **Sync** has the sync screens.

---

## 1. Principles

1. **A notebook, not a dashboard.** The writing page is the hero: big, calm, one plain color. Chrome stays small and quiet until needed.
2. **Color belongs to notes.** Bright color appears on list tiles (the note's own color) and almost nowhere else. The interface itself is blue on mist.
3. **Fewer, visible controls.** Prefer one visible button over a hidden gesture or typed shortcut. Shortcuts and gestures are extras, never the only way.
4. **Feedback you can see on a phone.** Every action answers back: a toast, a tile moving, a tick popping. Never a silent change.
5. **Forgiving.** Delete goes to Trash with Undo; nothing important is one tap from gone.

---

## 2. Color

### Palette (user-chosen)

| Name | Hex | Used for |
|---|---|---|
| Charcoal | `#1E2A31` | Text; the page surface in dark mode |
| Deep blue | `#0E4A72` | Brand: primary buttons, the open note's tile, brand text |
| Mid blue | `#3482BC` | Accent: focus rings, hover outlines, icons. **Not for small text** (contrast) |
| Light blue | `#BDE0F8` | Highlights: search matches, step numbers, progress tracks; the brand color in dark mode |
| Mist | `#EEF5FB` | The app's ground (behind the list and the page) |

### Tokens

Use tokens, never raw hex, in new CSS. Dark values apply when the system is dark (unless the toggle says light) or when the toggle says dark (`:root[data-theme]`; JS also sets `data-effective`).

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#eef5fb` | `#141d22` | App ground |
| `--surface` | `#ffffff` | `#1e2a31` | The note page, dialogs, menus |
| `--surface-2` | `#f4f9fd` | `#26343c` | Inputs, quiet buttons, status rows |
| `--ink` | `#1e2a31` | `#e6f1f9` | Body text |
| `--muted` | `#51626c` | `#9db2c0` | Secondary text, idle icons |
| `--line` | `#cfe2f0` | `#2e3e47` | Borders, dividers |
| `--rule` / `--rule-strong` | `#d6e7f4` / `#8fb8d8` | `#2b3a43` / `#4f6878` | Paper lines / dots |
| `--brand` | `#0e4a72` | `#bde0f8` | Primary button fill |
| `--brand-ink` | `#ffffff` | `#1e2a31` | Text on `--brand` |
| `--brand-text` | `#0e4a72` | `#bde0f8` | Brand-colored text and links |
| `--accent` | `#3482bc` | `#6fb0e0` | Focus, hover outline, icons |
| `--highlight` / `--highlight-ink` | `#bde0f8` / `#1e2a31` | `#0e4a72` / `#e6f1f9` | Highlight fill / text on it |
| `--done-ink` | `#7a8a94` | `#7f93a0` | Ticked checklist items |
| `--toast-bg` / `--toast-ink` | `#1e2a31` / `#ffffff` | `#e6f1f9` / `#1e2a31` | Toasts (inverted) |

Danger is the one exception to "blue only": `#b3261e` with white text, for delete-forever buttons. Warning badges (e.g. "Couldn't connect") use peach `#fce3d6` with `#8a3a12`.

### Note colors

Six colors a note can wear: `paper #ffffff`, `cornflower #94b6ef`, `chartreuse #e6e279`, `peach #f6b48f`, `mint #9fdcc0`, `pink #f3a6c4` (tokens `--c-*`).

- They tint the **list tile only**: `color-mix(--c, --tile-mix, --surface)`, with `--tile-mix` 42% light / 22% dark. Tile text stays `--tile-ink`.
- **The note page never changes color.** It is always `--surface`.
- The open note's tile is solid `--tile-active` (deep blue) with white text, whatever its color.

### Contrast rules

- Body text and small text: at least 4.5:1. Mid blue fails on white for small text: use `--brand-text` instead.
- Large text (24px+) and icons: at least 3:1.
- Never tell things apart by hue alone: the open tile is also darker, pinned notes also sit in their own section.

---

## 3. Typography

Two families, loaded from Google Fonts (`index.html`), with system fallbacks:

- **Literata** (`--font-write`): anything you *write* or that names a place: note titles and text, dialog titles, the view title in the header, the menu wordmark.
- **DM Sans** (`--font-ui`): everything else: buttons, lists, labels, meta.

| Style | Font | Size / line | Weight | Where |
|---|---|---|---|---|
| Note title | Literata | 40px | 600 | Editor title |
| Note text | Literata | 19px / `--lh` (32px; 30px on phones) | 400 | Editor body, checklists |
| Screen title (phone) | Literata | 30px / 1.2 | 600 | Full-screen sheets (sync) |
| Dialog title | Literata | 22px / 1.3 (26px in sync) | 600 | Dialogs |
| Picker | Literata | 17px / 1.2 | 600 | "All notes" header button |
| Body UI | DM Sans | 15px / 1.5 | 400 | Default |
| Tile title | DM Sans | 15px | 600 | List tiles |
| Small | DM Sans | 13–14px | 400 | Previews, meta, menu items |
| Label | DM Sans | 12px, uppercase, 0.04em | 600 | Section headers ("Pinned", "Today") |

Only weights 400 and 600 are loaded; don't use others.

---

## 4. Space, shape, depth

- **Spacing:** multiples of 4px. Common: 4, 8, 12, 16, 20, 24, 28. Sidebar padding 22/16/0/24; page max width 680px.
- **Radii:** 999px pills (buttons, chips, toasts); 50% round icon buttons; 14px tiles; 12px inputs, menus, status rows; 16–20px cards and dialogs (18px default dialog); 0 on full-screen phone sheets.
- **Shadows:** `--shadow-card` for the page, `--shadow-pop` for menus, dialogs and the tray. In dark mode shadows become a 1px line.
- **Touch targets:** at least 40px on desktop and 44px on phones (primary phone buttons 52px).

---

## 5. Layout

- **Desktop (≥ 720px):** list (320px) beside the page. The list can collapse to a rail (`Ctrl+\`).
- **Phone (< 720px):** one screen at a time, switched by `body[data-view]` (`list` / `editor`), with the back gesture working through history. The app is pinned to the window (`position: fixed; inset: 0`) so nothing hides behind Android's navigation bar.
- **Sidebar order:** header (☰, ← outside All notes, view title, ⋯ in a notebook, collapse, +) → date line (`**Sunday**, 18 October · 2 notes today`) → tag chips → backup nudge → count + sort → list. Search, notebooks, Trash, the theme toggle and More live in the ☰ menu.
- Safe areas: use `env(safe-area-inset-*)` for anything at the screen edge (`viewport-fit=cover`).

---

## 6. Components

**Buttons**
- *Primary:* pill, `--brand` fill, `--brand-ink` text, 600. One per view.
- *Secondary:* pill, `--surface-2` fill (or `--surface` with a `--line` border).
- *Icon button:* 40px round, transparent, `--muted` icon; hover fills `--surface-2`. Needs `aria-label`.
- *Danger:* pill, `#b3261e`, only to confirm a permanent delete.
- *Text link button:* `--brand-text`, 600, underlined (e.g. "Send a backup file instead").
- *New note:* 40px round brand button in the header (desktop); 60px floating round button bottom-right on phones.

**List tile** (`.note-item`): 14px radius, 12/14px padding, note-color tint, title (600) + one-line preview + short date. Hover: 1.5px `--accent` inset outline. Open: deep blue. Pinned tiles show a pin; swipe on phones (pin / Trash).

**Search:** lives at the top of the ☰ menu. 44px (48px on phones), `--surface` with a `--line` border, 12px radius, search icon, a "Ctrl K" hint on desktop. Searches every note outside Trash; results replace the notebook tree while typing (title, notebook name, a snippet starting at a word near the first match), matches marked with `--highlight`. Enter opens the first result and scrolls to the match. Ctrl+K, the collapsed rail's search button and pulling the list down (phones) open the menu with search ready.

**Header title:** the current view (All notes, a notebook, Trash) in Literata 22px (24px on phones). In a notebook or Trash, a ← (light-blue round button) goes back to All notes; in a notebook, ⋯ opens Rename / Delete.

**☰ menu (drawer):** slides in from the left over a dimmed app (340px, max 88% of the screen), the app behind is inert. Top: close, wordmark, theme toggle. Then search (results replace the tree while typing: title + snippet with matches marked, notebook name), All notes, Notebooks (each with a ▸ to show its notes, + New), Trash, and More at the bottom (sync, back up, restore, shortcuts, version). Rows are 40px (44px on phones); the current view is filled `--highlight`. Esc or the phone back gesture closes it.

**Select mode:** "Select" beside the sort, or press and hold a note on a phone. The header becomes ✕ · "N selected" · Select all/none, with a hint line below. Tiles get a round check on the left; a picked tile has a 2px `--brand-text` ring and the open note loses its deep-blue fill. Actions sit in a bar (floating card under the list on desktop, a full-width bottom bar on phones that replaces the +): Pin/Unpin, Move (pop-over of notebooks + New notebook…), Color (pop-over of swatches), Delete (red). In Trash: Restore and Delete forever (asks first). Every action ends select mode and shows a toast with Undo. Shift-click picks a range; Esc or the phone back gesture stops selecting.

**Chips** (tags): pill, `--surface` with a `--line` border, 13px, 600; hover outlines `--accent`; the active chip is filled `--highlight`.

**Editor bar:** back (phone), **Aa** (opens the tray), edited time, pin, delete. Everything else lives in the tray.

**Aa tray:** a pop-over (desktop) or bottom sheet (phone) with sections Color, Page (paper styles), Notebook, Insert (checklist, numbered, bulleted, image).

**Keyboard strip (phone):** sits on the keyboard (`--kb-offset`): tray, checklist, numbered, bulleted, image, hide.

**Dialogs:** native `<dialog>`, 18px radius, `--shadow-pop`, title in Literata, actions bottom-right (primary last). On phones, big flows (sync) become full-screen sheets with actions stacked at the bottom, primary on top.

**Toast:** inverted colors, pill, bottom center, with an optional action (Undo). Short sentences.

**Status row:** `--surface-2`, 12px radius, a dot or icon, one bold line, a muted detail on the right (e.g. "Waiting for your phone… · Code works for 4:52").

**Result card:** a round badge (light blue with a deep-blue tick, or peach with a warning icon), a title, a one-line summary, a stats list (label left, bold value right, `--line` dividers), and an optional notice box for "you should know" details.

**Paper styles:** plain, ruled, dotted, grid, drawn behind the text on the `--lh` grid and scrolling with it.

---

## 7. Icons

Inline SVG, 24×24 viewBox, `stroke="currentColor"`, stroke width 1.8 (2–2.4 for small or emphasized), round caps and joins, no fill (except the pin and bullet dots). Decorative icons get `aria-hidden="true"`. No emoji in the interface.

---

## 8. Motion

Small and quick, never decorative:

| What | How |
|---|---|
| Menus, tray, dialogs | `pop-in` 0.14–0.16s ease-out |
| Toast | `toast-in` 0.2s |
| Phone: open a note | slide in 0.26s `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| Tick a checklist item | `tick-pop` 0.28s |
| Pin | `pin-settle` 0.42s |
| Hover color | 0.15s |
| Waiting | a pulsing dot (1.4s) or spinner (1s) |

All animation and transition is turned off under `prefers-reduced-motion: reduce`.

---

## 9. Words

- Plain, short, friendly; second person ("your phone"). Sentence case everywhere.
- Say what happened and what to do next: "Couldn't connect. Put both on the same Wi‑Fi and try again."
- Reassure where it matters: "Nothing was changed." "Notes go straight between your two devices."
- Buttons are verbs: "Sync now", "Move to Trash", "Restore". Use "Undo" in toasts.
- Curly quotes and apostrophes (’ “ ”), an ellipsis character (…) for things in progress.

---

## 10. Accessibility checklist

- Real `<button>`, `<input>`, `<label>`; icon-only buttons have `aria-label`.
- Visible focus: 2px `--accent` outline, 2px offset.
- Live changes announced: toasts and statuses use `role="status"`.
- Everything works by keyboard: `↑ ↓` in the list and the menu, `Ctrl+K` search, `Ctrl+Alt+N` new note, `Ctrl+\` hide the list, `Esc` closes (pop-over → select mode → menu → tray), `?` shows shortcuts.
- Check both themes and phone width before shipping a new screen.

---

## 11. Adding something new

1. Sketch it on the canvas first and get it approved.
2. Build it from existing tokens and components; add a token only if no existing role fits, and give it a dark value too.
3. Check light, dark, desktop and phone (375px), and reduced motion.
4. Update this file if you added a token, component or rule.
