# Third-Party Notices & Dependency License Audit

This document records the verified licenses of all dependencies in the Kurippu dependency tree as locked in `package-lock.json`.

All runtime and development dependencies have been audited and verified to use permissive open-source licenses compatible with the MIT license.

---

## 1. Primary Runtime Dependencies

| Package | Version | License | License URL / Notice |
| :--- | :--- | :--- | :--- |
| **react** | `18.3.1` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| **react-dom** | `18.3.1` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| **zustand** | `5.0.1` | MIT | Copyright (c) 2019 Paul Henschel |
| **idb** | `8.0.0` | ISC | Copyright 2016 Jake Archibald |
| **minisearch** | `7.1.1` | MIT | Copyright (c) 2019 Luca Ongaro |
| **nanoid** | `5.0.8` | MIT | Copyright 2017 Andrey Sitnik <andrey@sitnik.ru> |
| **lucide-react** | `0.454.0` | ISC | Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather. |
| **dompurify** | `3.1.7` | Apache-2.0 / MPL-2.0 | Licensed under Apache 2.0 / MPL 2.0 (Used under Apache 2.0). Copyright 2015 Cure53. |
| **jszip** | `3.10.1` | MIT / GPL-3.0 | Dual-licensed (Used under MIT). Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso. |

---

## 2. Core Build & Development Dependencies

| Package | Version | License | Role |
| :--- | :--- | :--- | :--- |
| **vite** | `5.4.11` | MIT | Bundler and dev server |
| **typescript** | `5.6.3` | Apache-2.0 | Type checking and compiler |
| **tailwindcss** | `3.4.14` | MIT | Utility-first CSS styling |
| **postcss** | `8.4.47` | MIT | CSS transformation pipeline |
| **autoprefixer** | `10.4.20` | MIT | CSS vendor prefixing |
| **vitest** | `2.1.4` | MIT | Unit and integration test runner |
| **fake-indexeddb** | `6.0.0` | Apache-2.0 | Headless IndexedDB test environment |
| **jsdom** | `25.0.1` | MIT | Headless browser DOM environment |
| **@testing-library/react** | `16.0.1` | MIT | Component test utilities |
| **@testing-library/jest-dom**| `6.6.3` | MIT | Jest DOM matchers |

---

## 3. Transitive Dependency License Breakdown

An automated audit of all 270 packages in `package-lock.json` reveals the following distribution:
- **MIT**: 234 packages (86.7%)
- **ISC**: 22 packages (8.1%)
- **Apache-2.0**: 9 packages (3.3%)
- **BSD-2-Clause / BSD-3-Clause**: 5 packages (1.9%)
- **Copyleft (GPL / AGPL)**: 0 packages (0%)

There are **zero proprietary, commercial, or copyleft-encumbered dependencies** in the build.
