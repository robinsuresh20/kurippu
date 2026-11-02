# Phase 1 Architecture Review: Findings, Corrections & Decisions

## 1. Review Overview

This document records the architectural findings, corrections, validation evidence, and engineering decisions resulting from the critical review of Phase 1 documentation for **Kurippu**.

---

## 2. Findings & Corrections Made

### 2.1 Google OAuth & Browser Authorization Architecture
* **Original Issue**: The initial draft blended concepts from the OAuth 2.0 Authorization Code Flow with PKCE and the Google Identity Services (GIS) Token Model, implying that a pure browser application could receive refresh tokens or silently refresh indefinitely in the background.
* **Findings from Official GIS Documentation**:
  * In a browser-only Single Page Application without a confidential backend server, GIS issues short-lived access tokens (lifespan: 3,600 seconds) via `google.accounts.oauth2.initTokenClient`. No refresh tokens are issued to client-side implicit flows.
  * Silent renewal via `tokenClient.requestAccessToken({ prompt: '' })` relies on third-party cookies/sessions and can be blocked by browser tracking protections (Apple Safari ITP, Firefox ETP, Chrome Privacy Sandbox, ad-blockers), throwing `interaction_required`.
* **Corrections Made**:
  * Formally separated **Google Sign-In** (`google.accounts.id`, ID Token for identity) from **Google Drive Authorization** (`google.accounts.oauth2.initTokenClient`, access token with `drive.file` scope).
  * Explicitly documented the 1-hour expiration lifecycle and established that silent refresh is opportunistic, not guaranteed indefinitely.
  * Designed an **Offline-First Expiry Protocol**: When authorization expires or requires interaction, edits commit to local IndexedDB, the UI clearly shows *"Local Only (Drive Re-authorization Required)"*, and a one-click banner allows the user to re-authorize via popup and flush the pending sync queue.

---

### 2.2 Google Drive API v3 Concurrency & Data Integrity
* **Original Issue**: The initial draft assumed that Drive API v3 supports standard HTTP `If-Match` headers with ETags on file `PATCH` requests to automatically reject stale updates with `412 Precondition Failed`.
* **Findings from Official Google Drive API v3 Documentation**:
  * Google Drive API v3 **omits `etag` from standard file metadata responses** and does not support HTTP `If-Match` conditional updates for standard file writes. Drive API v3 operates on a **last-write-wins** basis at the network transport layer.
  * However, Drive API v3 File resources expose a monotonically incrementing **`version`** integer and an RFC 3339 **`modifiedTime`** timestamp.
* **Corrections Made**:
  * Replaced invented HTTP `If-Match` assumptions with explicit application-level concurrency control:
    1. **Preflight Version Check**: Before uploading, the client checks the remote file's `version` against its local base version.
    2. **Self-Describing Notes**: Notes are self-describing (`notes/<noteId>.json` contains its own ID, title, parent branch relations, attributes, and content). The manifest is an acceleration cache, not the sole unrecoverable source of truth.
    3. **Three-Way Manifest Dictionary Merging**: Concurrent tree structural changes merge note additions and sibling updates non-destructively based on timestamp recency.
    4. **Automated Reconciliation Scanner**: If `manifest.json` is missing or corrupted, a scanner reads all note files and completely reconstructs the manifest and tree hierarchy.

---

### 2.3 Drive Folder Discovery via `appProperties`
* **Original Issue**: Relying on folder names (e.g. querying `name='Kurippu Knowledge Base'`) breaks when users rename or relocate folders in Google Drive, creating duplicate or orphaned folders.
* **Findings from Official Drive Documentation**:
  * Drive API v3 provides **`appProperties`**: private string key-value pairs attached to files and folders that are visible and queryable **only by the application that set them** (under the same GCP OAuth Client ID).
  * `drive.file` scope allows querying and reading any file created by the application across sessions and devices.
* **Corrections Made**:
  * Root folder discovery uses `appProperties has { key='kurippuRole' and value='root' } and trashed=false`.
  * Even if the user renames the folder in Google Drive's web UI, Kurippu discovers it reliably across devices and clean browser profiles.

---

### 2.4 Persistence Terminology & Zero-Knowledge Clarification
* **Original Issue**: The initial architecture referred to "zero-knowledge persistence", which inaccurately implies client-side end-to-end cryptographic encryption.
* **Corrections Made**:
  * Removed "zero-knowledge" claims. The architecture is defined as **user-owned personal cloud persistence** using structured JSON documents stored directly in the user's private Google Drive.
  * Established an unambiguous 6-state persistence model:
    `DRAFT_LOCAL` ➔ `PERSISTED_LOCAL` ➔ `SYNC_QUEUED` ➔ `SYNCING` ➔ `COMMITTED_REMOTE` (or `CONFLICT_DIVERGED`).
  * Enforced that the UI **never** reports *"Saved to Google Drive"* until the Drive API returns HTTP 200/201.

---

### 2.5 Clean-Room Licensing Boundaries & Dependency Audit
* **Original Issue**: Overpromising that a clean-room implementation provides total immunity from legal risk.
* **Corrections Made**:
  * Clarified that clean-room implementation addresses source-code copyright infringement under 17 U.S.C. § 102(b), but independent design must also maintain visual distinctiveness from Trilium's trade dress and branding.
  * Verified all runtime dependencies under permissive licenses (MIT, Apache-2.0, ISC, MPL-2.0).
  * Explicitly prohibited proprietary Tiptap Pro extensions, restricting the editor to free, open-source MIT extensions.
  * Documented third-party attribution notice requirements (`LICENSE` and `THIRD_PARTY_NOTICES.md`).

---

### 2.6 Technical Proof of Concept (PoC) Milestone
* **Original Issue**: Proceeding directly from project foundation to large-scale UI implementation without validating the Drive storage layer against live Google APIs.
* **Corrections Made**:
  * Added **Milestone 2.2: Technical Proof of Concept** to Phase 2.
  * Mandated automated and manual validation of:
    1. GIS Drive authorization (`drive.file`).
    2. `appProperties` folder discovery.
    3. Note creation, retrieval, and updating.
    4. IndexedDB write-ahead log.
    5. Network interruption recovery.
    6. Concurrency conflict detection.
    7. Clean build and automated tests.

---

## 3. Official Documentation Validation Evidence

1. **Google Identity Services (GIS) Token Model**:
   - Reference: [Google Identity Services: Token Model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
   - *Confirmation*: Access tokens have a fixed 1-hour lifetime. No refresh tokens are returned to client-side browser flows. Silent renewal requires `prompt: ''` and can fail when third-party cookies or session credentials are unavailable.
2. **Google Drive API v3 Files Resource & Concurrency**:
   - Reference: [Google Drive API v3: Files Resource](https://developers.google.com/drive/api/reference/rest/v3/files)
   - *Confirmation*: The `etag` property is omitted from v3 File metadata responses; `version` and `modifiedTime` are the supported versioning fields.
3. **Google Drive API v3 `appProperties`**:
   - Reference: [Google Drive API: Custom File Properties](https://developers.google.com/drive/api/guides/properties)
   - *Confirmation*: `appProperties` are private to the application, queryable via `files.list(q="appProperties has ...")`, and immune to external renaming by users.
4. **Google Drive Scope `drive.file`**:
   - Reference: [Google Drive API: Choose Scopes](https://developers.google.com/drive/api/guides/api-specific-auth)
   - *Confirmation*: Permits reading, modifying, and querying all files created by the application across sessions and devices.

---

## 4. Key Architectural Decisions & Trade-offs

| Decision | Selected Approach | Alternative Rejected | Justification |
| :--- | :--- | :--- | :--- |
| **Storage Topology** | Manifest + Self-Describing Note Files | Monolithic SQLite or Single JSON File in Drive | Monolithic files risk total corruption on interrupted writes and cannot isolate concurrent note edits. Granular files isolate note edits completely. |
| **Manifest Failure Model** | Recoverable Acceleration Cache | Sole Unrecoverable Source of Truth | If `manifest.json` is lost or damaged, self-describing notes allow 100% automated tree reconstruction. |
| **Concurrency Model** | Preflight `version` check + Self-describing notes + 3-way manifest merge | Invented HTTP `If-Match` ETags | Drive API v3 does not support `If-Match` on standard file updates. Application-level version checking reflects real API behavior. |
| **Client-Side Auth** | Google Identity Services Token Client | Authorization Code Flow with PKCE | Code flow without a backend server still cannot protect client secrets or store refresh tokens securely in public browser clients. GIS Token Model is Google's sanctioned browser standard. |
| **Dependency Baseline** | Locked exact versions (React 18.3.1, Vite 5.4.11, Tiptap 2.10.3) | Unpinned floating ranges | Prevents breaking changes and dependency conflicts during implementation. |

---

## 5. Unresolved Questions & Remaining Technical Risks

1. **Rate Limit Bursts During Batch Operations**:
   - *Question*: If a user imports 200 Markdown files at once, will Drive API v3 return `429 Too Many Requests`?
   - *Mitigation Plan*: The import engine will batch note uploads in chunks of 5 with 200ms delays and exponential backoff.
2. **Safari ITP / Private Browsing Silent Refresh**:
   - *Question*: How frequently will Safari users need to click the re-authorization prompt?
   - *Mitigation Plan*: The UI will make the re-authorization prompt as seamless as a single click, and all notes will remain safely buffered in IndexedDB without data loss.
3. **Storage Quota in IndexedDB**:
   - *Question*: What happens if the browser is low on disk space?
   - *Mitigation Plan*: `navigator.storage.persist()` is called on startup to prevent eviction; local cache only stores note text and active attachments.

---

## 6. Review Conclusion

With these corrections, the architecture is grounded in verified Google API capabilities, eliminates unproven assumptions, enforces robust data recovery, and provides an actionable Technical Proof of Concept milestone before Phase 2 UI development begins.
