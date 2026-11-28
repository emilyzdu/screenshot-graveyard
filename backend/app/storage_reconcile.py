"""Startup storage reconciliation (P1-2): ``python -m app.storage_reconcile``.

Run by ``deploy/start.sh`` after migrations and before the server starts, when
no upload can be in progress (one instance; the platform stops the old one
before starting the new one). It sets the global ``storage_bytes`` counter to
the physical bytes actually retained under ``STORAGE_ROOT`` (everything except
the reserved ``.tmp/`` directory), which:

* releases reservations whose write never happened (a crash between the
  reservation commit and the file write), and
* counts files no reservation covered (content stored before the counter
  existed, or orphans from a failed metadata transaction).

Strategy for interrupted writes (P1-2): under the EXCLUSIVE allocation lock
(which every upload holds shared while it reserves and writes, so recovery can
never overlap one), it first reclaims this store's own leftover temp files
(``FileStore.reclaim_temp_files``: only names matching the temp-file and
preflight-probe patterns, only inside ``.tmp/``), then counts EVERY remaining
regular file once per inode (``FileStore.retained_bytes``), ``.tmp/`` included.
Containment: STORAGE_ROOT must still be the directory the store was created for
(device/inode pinned), and ``.tmp`` a real directory on its filesystem (not a
symlink, not another mount); otherwise the allocation guard refuses with
``UnsafePathError`` before anything is locked, created, chmod-ed or removed. The
guard is a lock on the root directory itself, and all cleanup and counting use
the guard's own handles, so replacing ``.tmp`` mid-run cannot split the lock or
redirect the cleanup.
Fail-closed: if any directory or file under the root cannot be inspected, it
raises ``StorageScanError`` before reclaiming anything, the global counter keeps
its previous value, and ``main`` exits non-zero so the server never starts.
Published originals are never removed or modified; a leftover temp name that is
a second hard link to an original only loses that extra name. Idempotent: a
second run finds nothing to reclaim and the same byte count.
"""

from __future__ import annotations

import sys

from app import config
from app.db.session import get_session
from app.services.global_usage_service import GlobalUsageService
from app.storage.file_store import FileStore, StorageScanError, UnsafePathError


def reconcile(session=None, store: FileStore | None = None) -> tuple[int, int]:
    store = store or FileStore(config.STORAGE_ROOT)
    own = session is None
    session = session or get_session()
    try:
        # Refuse rather than wait if any upload holds the guard (never overlap).
        with store.allocation_guard(exclusive=True, wait=False) as guard:
            # Every step below runs on the guard's validated root and ``.tmp``
            # handles (never a pathname reopened inside the guard), and each one
            # re-verifies that neither was replaced (UnsafePathError otherwise).
            # Fail closed (StorageScanError): prove the whole tree is readable
            # BEFORE removing any temp file, and count only from a complete
            # scan. On any error nothing is reclaimed and the counter keeps its
            # previous value (the transaction is rolled back below).
            store.retained_bytes(guard=guard)
            store.reclaim_temp_files(guard=guard)
            physical = store.retained_bytes(guard=guard)  # verifies again before returning
            before, after = GlobalUsageService(session).reconcile_storage(physical)
            guard.verify()  # last check before the counter becomes durable
            session.commit()
        return before, after
    except Exception:
        session.rollback()
        raise
    finally:
        if own:
            session.close()


def main() -> int:
    try:
        before, after = reconcile()
    except (StorageScanError, UnsafePathError) as exc:
        # Non-zero exit: deploy/start.sh (set -e) never starts the server, so no
        # upload can run against an unverified counter. UnsafePathError: the
        # storage root or its reserved .tmp was replaced or is not contained in
        # STORAGE_ROOT; it was refused before any further lock, chmod or
        # reclaim, and the counter keeps its previous value. Messages name the
        # setting, never an absolute path.
        print(f"Storage reconciliation aborted; counter unchanged: {exc}", file=sys.stderr)
        return 1
    print(f"Storage counter reconciled: {before} -> {after} bytes")
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through deploy/start.sh
    sys.exit(main())
