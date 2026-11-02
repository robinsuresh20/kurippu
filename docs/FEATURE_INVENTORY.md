# Feature Inventory: TriliumNext-Inspired Knowledge Management

This document provides a comprehensive feature inventory derived from the deep architectural and functional analysis of **TriliumNext Notes** (`https://github.com/TriliumNext/Trilium` and `https://docs.triliumnotes.org/`).

Each feature is classified into one of three implementation tiers:
- **Essential (Initial Release)**: Core to daily knowledge-management workflow and foundational architecture.
- **Important (Subsequent Release)**: High-value features expanding productivity, relations, and automation.
- **Advanced (Future/Later)**: Complex specialized features (e.g., custom JavaScript scripting environments, canvas mind-mapping).

---

## 1. Core Application Layout & Navigation

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Three-Pane Desktop Layout** | Left sidebar (note tree / launcher), center note editor, right sidebar (note details, attributes, backlinks). | **Essential** | Resizable CSS flexbox/grid layout with collapse toggles and persistent width preferences. |
| **Launch Bar / Action Rail** | Leftmost narrow rail for quick switching between Tree, Search, Recent Notes, Favorites, and Settings. | **Essential** | Vertical icon rail with keyboard shortcuts (Ctrl/Cmd+1..5). |
| **Breadcrumb Navigation** | Top bar showing the path from root to current note with clickable parent links. | **Essential** | Breadcrumb component driven by the active branch path. |
| **Multiple Note Tabs / Split View** | Ability to open notes in multiple tabs or side-by-side split view. | **Important** | Tab bar component with pinned tabs and split-pane layout manager. |
| **Responsive Mobile / Tablet Layout** | Collapsible off-canvas drawer navigation for viewports < 768px. | **Essential** | Tailwind-driven responsive drawer overlay with touch-friendly touch targets. |
| **Status Bar** | Real-time status indicator showing Sync Status (Synced, Saving, Offline, Error), Word Count, and Revision Info. | **Essential** | Bottom dock indicator bound to the Sync and Editor state stores. |

---

## 2. Note Tree & Hierarchical Organization

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Infinite Nested Hierarchy** | Arbitrarily deep parent-child note nesting. | **Essential** | Recursive tree component with virtualized windowing for 10,000+ notes. |
| **Stable Note Identifiers** | Notes identified by unique IDs (UUID/nanoid), independent of titles or folder paths. | **Essential** | Canonical 21-char nanoids used across URLs, storage, and cross-references. |
| **Branch / Parent-Child Tuple** | Tree structure defined by Branch relationships (`parentNoteId`, `noteId`, `position`). | **Essential** | Normalized branch map in metadata manifest to support tree rendering and reordering. |
| **Note Cloning (DAG Tree)** | A single note can exist under multiple parents simultaneously without data duplication. | **Important** | Multi-parent branch relations where editing one clone reflects across all occurrences. |
| **Drag & Drop Reordering** | Drag notes to reorder siblings or move notes between parent folders. | **Essential** | Accessible HTML5 / `@dnd-kit` drag-and-drop tree reordering with drop indicators. |
| **Context Menus** | Right-click options on tree items: New Child Note, Rename, Duplicate, Move, Delete, Copy Link. | **Essential** | Accessible floating context menu triggered by right-click or three-dot action trigger. |
| **Favorites / Pinned Notes** | Quick-access bookmarking for frequently referenced notes. | **Essential** | `#favorite` label attribute with dedicated Launch Bar filter view. |
| **Recent Notes** | Historical chronological log of recently accessed notes. | **Essential** | Local LRU cache of recently opened note IDs stored in local state. |
| **Trash & Soft Deletion** | Notes deleted are marked with `isDeleted: true` and moved to a recoverable Trash view. | **Essential** | Soft-delete state in manifest with 30-day purge or manual "Empty Trash". |

---

## 3. Editors & Supported Note Types

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Text Note (Rich Text / WYSIWYG)** | Rich text formatted editing with Markdown shortcuts (heading `#`, lists `*`, quotes `>`). | **Essential** | Tiptap (ProseMirror engine) with live Markdown input rules. |
| **Code Note** | Dedicated monospace note with programming syntax highlighting, line numbers, and language selector. | **Important** | Monospace editor mode or CodeBlock extension with Prism/Lowlight syntax engine. |
| **Saved Search Note** | Dynamic note whose content is the live output of a saved search query. | **Important** | Virtual note type executing query filters against the client index. |
| **Render / Script Note** | Executable JavaScript / HTML notes for dynamic scripting and automation. | **Advanced** | Sandboxed Web Worker / iframe runner (deferred for security reasons). |
| **Canvas / Diagram Note** | Interactive whiteboard or mind-map diagramming. | **Advanced** | Excalidraw or Mermaid integration. |
| **Book / Long-form Document** | Container note optimized for chapter ordering and multi-page reading. | **Important** | Subtree aggregation view rendering children sequentially. |

---

## 4. Formatting & Content Blocks

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Basic Text Styles** | Bold, Italic, Underline, Strikethrough, Inline Code, Highlight, Subscript, Superscript. | **Essential** | Native Tiptap Marks with keyboard shortcuts (Ctrl+B, Ctrl+I, etc.). |
| **Headings 1–6** | Semantic H1 to H6 headings with automatic outline extraction. | **Essential** | Tiptap Heading extension + Table of Contents outline panel. |
| **Lists & Checklists** | Bulleted lists, numbered lists, and interactive checkboxes with toggle state. | **Essential** | Tiptap BulletList, OrderedList, and TaskList / TaskItem extensions. |
| **Blockquotes & Admonitions** | Standard quotes and callout boxes (Note, Tip, Warning, Important, Caution). | **Essential** | Custom Tiptap Callout/Admonition node with type selector and icon styling. |
| **Code Blocks with Highlighting** | Multi-language code fences with syntax highlighting and copy-to-clipboard button. | **Essential** | Tiptap CodeBlockLowlight with language selector. |
| **Tables** | Grid tables with column/row insertion, resizing, header row, and cell formatting. | **Essential** | Tiptap Table, TableRow, TableHeader, TableCell extensions. |
| **Horizontal Dividers** | `<hr>` divider line separating content sections. | **Essential** | Tiptap HorizontalRule extension (`---`). |
| **Images & Media Embeds** | Inline images with resizing, drag-and-drop upload, and caption support. | **Essential** | Custom Image extension linked to Google Drive attachment blobs. |
| **Math / LaTeX** | KaTeX inline `$...$` and display math blocks `$$...$$`. | **Important** | Tiptap Math extension rendering KaTeX with live editing. |

---

## 5. Internal Links, Backlinks & Relationships

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Internal Note Linking** | Inline link navigating to another note using stable note IDs (`note://<id>`). | **Essential** | Custom Tiptap NoteLink extension resolving titles dynamically. |
| **Link Autocomplete (`[[` or `@`)** | Typing `[[` or `@` brings up a fast fuzzy search dropdown to link another note. | **Essential** | Tiptap Suggestion plugin matching note titles in memory. |
| **Backlink Discovery** | Automatic reverse lookup showing all notes that link to the current active note. | **Essential** | Reverse link index generated during manifest parsing, displayed in right sidebar. |
| **Forward Links (Outlinks)** | List of all notes referenced from the current note. | **Essential** | Parsed from note document nodes, displayed in note info tab. |
| **Explicit Relations** | Typed semantic connections between notes (e.g., `~childOf`, `~author`, `~relatesTo`). | **Important** | Key-value relation attributes (`~relationName = targetNoteId`). |
| **Relation Visualizer / Graph** | 2D force-directed interactive node graph showing note link networks. | **Important** | Interactive D3.js or ForceGraph canvas in sidebar or modal. |

---

## 6. Tags, Attributes & Metadata

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Labels (Tags)** | Key-value tags (`#project`, `#status=in-progress`, `#priority=high`). | **Essential** | Structured array of `{ name: string, value?: string }` per note. |
| **Inline Hashtags** | Typing `#tag` in editor automatically registers the tag on the note. | **Important** | Editor regex trigger syncing inline hashtags with note attributes. |
| **Attribute Inheritance** | Notes inherit attributes from parent notes or ancestors marked as `inheritable`. | **Important** | Traversal evaluation in tree store computing effective attributes. |
| **System Labels** | Special attributes driving behavior: `#archived`, `#favorite`, `#readOnly`, `#color`. | **Essential** | Recognized attribute keys altering UI state, color coding, or badge display. |
| **Note Metadata Inspector** | Right-sidebar panel displaying Note ID, creation date, modification date, word count, size. | **Essential** | Dedicated Note Info tab in right drawer. |

---

## 7. Search & Filtering

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Quick Search Modal** | Global command palette (Ctrl/Cmd+P or Ctrl/Cmd+K) with instant fuzzy title matching. | **Essential** | High-performance in-memory fuzzy search modal with keyboard navigation. |
| **Full Content Search** | Search through full body text of notes with highlighted snippet excerpts. | **Essential** | Client-side MiniSearch indexing note text cached in IndexedDB. |
| **Tag & Attribute Filter** | Filter note tree by clicking a tag or querying `#status=done`. | **Essential** | Query parser matching structured labels and attributes in tree manifest. |
| **Saved Search Queries** | Reusable search queries accessible directly from the sidebar. | **Important** | Saved filter presets stored in settings or as virtual notes. |
| **Date Range Filtering** | Filter notes created or modified within time ranges (e.g., `modified: >= -7d`). | **Important** | Date comparison filters integrated into the search grammar. |

---

## 8. Keyboard Shortcuts & Command Menus

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Slash Commands (`/`)** | Typing `/` on an empty line opens an action menu for blocks (Headings, Lists, Tables, etc.). | **Essential** | Modular Tiptap Suggestion menu with keyboard arrow navigation and filter-as-you-type. |
| **Global Command Palette** | `Ctrl+K` or `Ctrl+P` opens application commands and note search. | **Essential** | Global modal palette with fuzzy matching for all actions and notes. |
| **Formatting Shortcuts** | `Ctrl+B`, `Ctrl+I`, `Ctrl+U`, `Ctrl+Shift+C`, `Ctrl+Shift+1..6`. | **Essential** | ProseMirror keymaps adhering to standard conventions. |
| **Tree Navigation Shortcuts** | `Up`/`Down` to navigate tree, `Right`/`Left` to expand/collapse, `Enter` to open. | **Essential** | Keyboard focus manager with accessible ARIA tree roles. |
| **Quick Note Creation** | `Ctrl+N` to create a new child note under the active note. | **Essential** | Global hotkey triggering `createNote(activeParentId)`. |

---

## 9. Note History, Recovery & Synchronization

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Autosave with Debounce** | Changes automatically saved after 1000ms pause or on blur. | **Essential** | Local IndexedDB immediate save + 1.5s debounced sync queue to Google Drive. |
| **Save State Indicator** | Visual feedback: "Saved", "Saving...", "Offline", "Sync Error". | **Essential** | Status badge in footer and header reflecting exact Drive persistence state. |
| **Note Revision History** | Automatic point-in-time snapshots when editing sessions finish. | **Important** | Revision log in `notes/<noteId>.revisions.json` or Drive file revisions. |
| **Conflict Detection** | Detection when Drive file was modified remotely before local save commits. | **Essential** | Drive `If-Match` ETags / revision timestamps; split-pane conflict resolver. |
| **Offline Queue & Replay** | Edits made offline persist in IndexedDB and sync automatically when online. | **Essential** | Write-ahead sync queue with exponential backoff and idempotency tokens. |

---

## 10. Settings, Themes & Customization

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Light & Dark Themes** | Clean, high-contrast light and dark themes matching system or user toggle. | **Essential** | CSS variables / Tailwind `dark` class with persistence in local settings. |
| **Custom Font & Typography** | Adjustable font family (Inter, System, Monospace) and font size. | **Important** | Settings dropdown adjusting root CSS variables. |
| **Custom CSS Injection** | Custom CSS stylesheets to tweak any aspect of the UI. | **Advanced** | User stylesheet injection (deferred to subsequent release). |
| **Editor Preferences** | Spellcheck toggle, line width options (constrained vs full width), code line numbers. | **Essential** | Settings modal with toggles persisted to application config. |

---

## 11. Import/Export & Attachments

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Markdown Export** | Export single note or subtree as `.md` file with frontmatter attributes. | **Essential** | Client-side ZIP generation (`JSZip`) bundling notes and linked attachments. |
| **Markdown / Text Import** | Import `.md` or `.txt` files as new notes. | **Essential** | File drag-and-drop reader converting Markdown to Tiptap JSON. |
| **HTML Export** | Export note or subtree as standalone HTML document. | **Important** | HTML serialization of ProseMirror doc with embedded CSS styles. |
| **File Attachments** | Attach PDFs, images, archives to notes; preview images and audio inline. | **Essential** | Upload to `attachments/` folder on Google Drive with signed download URLs. |
| **Full Backup & Restore** | Complete snapshot backup of manifest, notes, and attachments in single archive. | **Essential** | One-click export of complete manifest + notes to `.zip` file for offline recovery. |

---

## 12. Authentication & Access Control

| Feature | TriliumNext Reference Behavior | Classification | Implementation Strategy |
| :--- | :--- | :--- | :--- |
| **Google Sign-In** | Google OAuth 2.0 PKCE flow with secure token lifecycle. | **Essential** | Google Identity Services (GIS) token client; no client secret exposed. |
| **Drive Scope Least-Privilege** | Use `drive.file` scope (only access files created by the app). | **Essential** | Granular OAuth consent requesting `drive.file` scope only. |
| **Token Refresh & Expiry Handling**| Automatic silent token renewal or prompt before expiration. | **Essential** | Token manager listening to expiration with non-blocking re-authentication. |
| **Multi-Device Session Safety** | Safe concurrency across multiple active browser tabs or devices. | **Essential** | Atomic manifest updates using Drive ETag preconditions (`If-Match`). |
| **Sign-Out & Local Cache Wipe** | Complete logout with optional clearing of local IndexedDB cache. | **Essential** | Secure sign-out routine purging in-memory tokens and local storage on request. |
