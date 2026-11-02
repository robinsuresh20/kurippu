# Licensing Analysis, Clean-Room Boundaries & Dependency Audit

## 1. Reference Project License Assessment

The reference application, **TriliumNext Notes** (`https://github.com/TriliumNext/Trilium`), is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

### Legal Constraints of AGPL-3.0:
1. **Strong Copyleft Scope**: Any work that contains, derives from, or is statically linked with AGPL-3.0 source code must be distributed in its entirety under the terms of the AGPL-3.0.
2. **Network User Clause (Section 13)**: The AGPL specifically mandates that if the software is modified and run over a computer network to provide remote services, the modified source code must be made accessible to all remote network users under the AGPL-3.0.
3. **Proprietary Assets & Styling**: Trilium's specific stylesheets, visual iconography, documentation text, and logos are proprietary intellectual property covered by their copyright holders.

---

## 2. Independent Clean-Room Implementation Boundaries

To create an original, independently maintainable software application with a clean licensing lineage:

### 2.1 Permitted Architectural & Functional Inspiration
Under international copyright jurisprudence (including US Copyright Act 17 U.S.C. § 102(b) and European Directive 2009/24/EC), copyright protection extends only to expressions of ideas, not to ideas, procedures, systems, methods of operation, concepts, or principles:
- **Permitted**: Replicating the functional user experience: hierarchical note tree navigation, parent-child branch relationships, note cloning (DAG relationships), key-value attributes (labels and relations), slash command menus, and split-pane desktop organization.
- **Permitted**: Standard data interchange formats: standard Markdown parsing, JSON representations, and RESTful Google Drive integration.

### 2.2 Strict Clean-Room Prohibitions (Contamination Boundaries)
- ❌ **Zero Code Ingestion**: No source code, scripts, or templates from the Trilium or TriliumNext repositories may be copied, translated, or adapted.
- ❌ **Zero Asset Reuse**: No CSS files, icons, logos, or graphic assets from TriliumNext may be imported. All user interface styling is authored from scratch using Tailwind CSS, and all iconography is sourced from the independent, permissively licensed Lucide icon library.
- ❌ **Independent Git Lineage**: Kurippu is created as a completely new repository with an empty initial commit history, having no submodule, fork, or historical linkage to any existing repository.

### 2.3 Remaining Legal Considerations & Realistic Disclaimers
While a clean-room implementation eliminates direct source-code copyright infringement, it does **not** provide absolute immunity from all legal risks:
- **Trade Dress & Visual Distinctiveness**: Kurippu implements its own distinct visual design system, typography, color palette, and component layouts. It deliberately avoids mimicking Trilium's exact visual styling, trademarks, or unique brand marks.
- **Clean-Room Verification**: Independent creation must be maintained throughout the project lifecycle. Contributors must not inspect Trilium source code to reverse-engineer proprietary algorithms.

---

## 3. License Selection for Kurippu: MIT License

Kurippu is released under the **MIT License**.

Because all source code, components, and architectural models in Kurippu are authored from scratch without incorporating AGPL-3.0 code, licensing Kurippu under the permissive MIT license is legally sound.

---

## 4. Production Dependency Audit & License Verification

All selected production runtime and build-time dependencies have been audited. They are restricted strictly to permissive open-source licenses (MIT, Apache-2.0, ISC, MPL-2.0):

| Package Name | Locked Version | License | Category | Notes / Verification |
| :--- | :--- | :--- | :--- | :--- |
| **react** | `18.3.1` | MIT | Framework | Standard permissive license. |
| **react-dom** | `18.3.1` | MIT | Framework | Standard permissive license. |
| **typescript** | `5.6.3` | Apache-2.0 | Language | Compatible with MIT projects. |
| **vite** | `5.4.11` | MIT | Build Tool | Standard permissive license. |
| **tailwindcss** | `3.4.14` | MIT | Styling | Standard permissive license. |
| **@tiptap/core** | `2.10.3` | MIT | Editor Core | Open-source core ProseMirror wrapper. |
| **@tiptap/react** | `2.10.3` | MIT | Editor React | Open-source React component bindings. |
| **@tiptap/starter-kit** | `2.10.3` | MIT | Editor Extensions | Open-source standard nodes. |
| **@tiptap/extension-table** | `2.10.3` | MIT | Editor Tables | Open-source table extension. |
| **@tiptap/extension-task-list**| `2.10.3` | MIT | Editor Lists | Open-source task list extension. |
| **@tiptap/extension-code-block-lowlight** | `2.10.3` | MIT | Code Highlighting | Open-source code block extension. |
| **zustand** | `5.0.1` | MIT | State Management| Open-source, zero runtime dependencies. |
| **idb** | `8.0.0` | MIT | IndexedDB Client | Open-source wrapper by Jake Archibald. |
| **minisearch** | `7.1.1` | MIT | Search Engine | Zero-dependency in-memory search. |
| **lucide-react** | `0.454.0` | ISC | Iconography | Permissive ISC open-source license. |
| **dompurify** | `3.1.7` | MPL-2.0 / Apache-2.0 | Security | Permissive dual license; safe for bundling. |
| **nanoid** | `5.0.8` | MIT | ID Generator | Standard permissive license. |
| **jszip** | `3.10.1` | MIT | File Archiving | Standard permissive license. |

### 4.1 Strict Exclusion of Commercial / Proprietary Editor Modules
> [!IMPORTANT]
> **Tiptap Pro Features Exclusion**:
> Tiptap provides both open-source (MIT) extensions and paid commercial "Tiptap Pro" extensions (such as Cloud Collaboration, AI integration, and proprietary export plugins).
> **Kurippu strictly uses only the free, open-source MIT packages.** No `@tiptap-pro/*` packages or proprietary licenses are included in this project.

---

## 5. Third-Party Notices & Attribution Obligations

Under the terms of the MIT, Apache-2.0, ISC, and MPL-2.0 licenses, redistributing the compiled software requires retaining the original copyright notices and license text.

To fulfill these obligations, Kurippu will include:
1. A top-level `LICENSE` file containing the project's MIT license.
2. A `THIRD_PARTY_NOTICES.md` file in the project distribution detailing the licenses and copyright statements of all bundled libraries.
