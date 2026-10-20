# Manual comment redaction screenshots

Captured on 2026-10-19 with the current compiled UI, actual createApp routes and a fresh synthetic PostgreSQL fixture. All companies, issues, comments and account-like values are invented. No live account, provider call or production data was used.

Before and after mean the same comment before and after its redaction in this version of the app. They do not compare old and new app versions. Light mode uses EXA-1 and keeps the last four characters; dark mode uses a fresh EXA-2 comment and full replacement. Both began with the same synthetic selection. The light action cleaned supported stored copies first, so the dark preview correctly shows no additional copies beyond its own comment. Other comments were retained until their own explicit actions.

The impact previews use actual responses and show only the requesting board user's visible counts. Both confirmations, persistent comments and activity entries were checked after refresh. Overall cleanup remains incomplete, as shown in the warning and activity row. The source-gone capture demonstrates that the old selection cannot be previewed again after replacement.

The native T3 browser captured these images without cropping, overlays or post-capture editing. The CSS viewport was 1440 by 1440; the native transport produced 1280 by 1280 PNGs. The images contain no PNG text or EXIF metadata. The parent inspected all ten original captures in full and selected these nine; the duplicate dark activity view remains private.

- light-before.png: synthetic source comment.
- light-preview-required.png: confirmation disabled before the stored-copy preview.
- light-impact-preview.png: last-four replacement and visible estimated counts.
- light-after.png: persisted replacement and incomplete-cleanup warning.
- light-activity-incomplete.png: incomplete status after refresh.
- dark-before.png: separate fresh synthetic source comment.
- dark-impact-preview.png: full replacement and its real remaining counts.
- dark-after.png: persisted full replacement and warning.
- dark-source-gone.png: exact-match refusal after the source was replaced.

These captures do not demonstrate a log-file rewrite: the owned run-log folder was empty. They do not establish physical erasure, future-write filtering, active-buffer cleanup, delegated agent execution, live authentication, provider behavior, large-database performance or full server startup orchestration. The fixture used real API middleware with an external static mount of the freshly built UI. Its application and database processes and its dedicated incognito tab were closed after verification.

Relevant source SHA-256 values at capture time:

- RedactCommentDialog.tsx: b6ad298f41187febae230aee1bd1804044d2e171e90f63faf6f2217172e6dfea
- IssueDetail.tsx: e5b0a8819dc58075f7a29fd82376a1fc98d85ce6aa963baa4259d0a98d52a0f3
- comment-redaction.ts service: 791cc1a3800f0f0b84a9ce0729fc3f2f1541e67b79c8ab2a0e40892183dfc45b
- manual-redaction-privacy.ts: 60e1c0284b2d51fa876c22054b548b77d4f3a674e4f2794d5c08fe9e7e1d2f73
After capture, request logging was corrected for raw backslashes inside identifiers. The UI, shared selection logic, redaction service and routes pictured here did not change. The classifier hash above identifies capture-time code; these screenshots do not demonstrate that later logging fix.
