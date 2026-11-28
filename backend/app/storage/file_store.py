"""Write-once, content-addressed file store (Task 1.6).

Stores original screenshot bytes privately and immutably beneath STORAGE_ROOT,
addressed by their SHA-256. Three operations only — no delete, no overwrite:

    write_once(workspace_id, sha256, data) -> storage_path (relative)
    read(storage_path) -> bytes
    exists(storage_path) -> bool

Layout (private volume, never web-served):
    <STORAGE_ROOT>/<workspace_id>/<ab>/<cd>/<sha256>
where ab = sha256[0:2], cd = sha256[2:4]. Physical deduplication is by content
hash per workspace; Workspace *metadata* lives in the relational DB (separation
of concerns, design Req 12.2). The returned storage_path is RELATIVE to
STORAGE_ROOT so DB rows stay portable across storage roots/mounts.

Immutability (INV-1/INV-3/INV-10):
  * Publication is atomic via an EXCLUSIVE create (os.link / O_CREAT|O_EXCL) that
    fails if the destination already exists; an existing destination is treated
    as success WITHOUT replacing bytes.
  * There is NO delete or overwrite operation.
  * Published files are set read-only (0o444).

Crash tolerance:
  * Bytes are written to a unique temp file under a reserved `.tmp/` subdirectory
    on the same volume, flushed + fsync'd, then published by exclusive create.
  * try/finally removes the temp file on in-process errors and on the
    already-exists path. A hard crash/SIGKILL may leave an orphan temp file under
    `.tmp/` (harmless; removable by the optional sweep) but can NEVER corrupt or
    delete a published original.

NOTE: filesystem persistence here is local. Durability on a real mounted cloud
volume across instance restarts is a SEPARATE, still-outstanding proof (Task 1.0,
targeted Nov 12); this module does not establish that.
"""

from __future__ import annotations

import errno
import hashlib
import contextlib
import re
import stat
import os
import secrets
import time
from pathlib import Path

from app import config

_SHA256_HEX_LEN = 64
_TMP_DIRNAME = ".tmp"
# Names this store creates under .tmp/ (write_once temp files, preflight probes).
_TEMP_NAME = re.compile(r"^[0-9a-f]{64}\.\d+\.[0-9a-f]{16}\.tmp$")
_PROBE_NAME = re.compile(r"^preflight\.\d+\.[0-9a-f]{8}$")


class StorageBusyError(Exception):
    """The allocation lock is held (an upload or a recovery is in progress)."""


class StorageScanError(Exception):
    """A directory or file under the storage root could not be inspected.

    Byte counts are only trustworthy from a COMPLETE scan; callers must abort
    rather than use a partial total. The message names the path relative to
    the root and the error kind only (no file contents).
    """
# Published files: read-only for owner/group/other (private + immutable).
_PUBLISHED_MODE = 0o444
# Directories: owner-only access (private screenshots).
_DIR_MODE = 0o700


class FileStoreError(Exception):
    """Base error for file-store operations."""


class IntegrityError(FileStoreError):
    """Raised when stored bytes fail a size or SHA-256 integrity check."""


class UnsafePathError(FileStoreError):
    """Raised when a storage_path would escape the private storage root."""


def compute_sha256(data: bytes) -> str:
    """Return the hex SHA-256 of the exact bytes."""
    return hashlib.sha256(data).hexdigest()


def _is_valid_sha256(sha256: str) -> bool:
    return (
        isinstance(sha256, str)
        and len(sha256) == _SHA256_HEX_LEN
        and all(c in "0123456789abcdef" for c in sha256)
    )


class FileStore:
    def __init__(self, root: str | os.PathLike[str] | None = None) -> None:
        self._root = Path(root if root is not None else config.STORAGE_ROOT).resolve()
        self._tmp_dir = self._root / _TMP_DIRNAME
        # Trusted identity of the storage root: (st_dev, st_ino) of the real
        # directory this store was created for. Pinned now if it exists, or at
        # its first creation. Every later open of the root must match it, so a
        # root renamed away and replaced (by a symlink or another directory)
        # after this point is refused, never followed.
        self._root_id: tuple[int, int] | None = None
        try:
            fd = os.open(self._root, self._DIR_FLAGS)
        except OSError:
            pass  # absent (pinned at creation) or not a real directory (refused on first use)
        else:
            try:
                st = os.fstat(fd)
                self._root_id = (st.st_dev, st.st_ino)
            finally:
                os.close(fd)

    @property
    def root(self) -> Path:
        return self._root

    # ------------------------------------------------------------------ paths

    # ------------------------------------------------------------ containment
    #
    # Invariants for every mutation under STORAGE_ROOT (temp files, reclaim,
    # sweep, publication directories) and for the allocation lock:
    #   1. The root is opened with O_NOFOLLOW and its (st_dev, st_ino) must equal
    #      the identity pinned when this store was created (``_root_id``). A
    #      root that was renamed and replaced by a symlink, another directory,
    #      or nothing at all is refused (UnsafePathError) BEFORE anything is
    #      created, locked, chmod-ed or removed.
    #   2. Everything below the root is reached through directory file
    #      descriptors obtained with O_NOFOLLOW and checked to be real
    #      directories on the root's filesystem; later operations are relative
    #      to those fds, so swapping a path component after the check cannot
    #      redirect them.
    #   3. The allocation lock is flock() on the pinned ROOT directory itself
    #      (see ``allocation_guard``): the root's identity cannot be replaced
    #      without failing invariant 1, so there is no lock file to rename and
    #      no `.tmp` replacement can create a second, independent lock domain.
    _DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def _open_root_fd(self, *, create: bool) -> int | None:
        """Open the pinned storage root without following symlinks.

        Returns None only when the root does not exist, was never pinned and
        ``create`` is False. Raises UnsafePathError for a symlink, a non-directory,
        a vanished pinned root, or any identity mismatch.
        """
        try:
            fd = os.open(self._root, self._DIR_FLAGS)
        except FileNotFoundError:
            if self._root_id is not None:
                raise UnsafePathError("STORAGE_ROOT no longer exists at its configured path") from None
            if not create:
                return None
            self._root.mkdir(parents=True, exist_ok=True)
            try:
                fd = os.open(self._root, self._DIR_FLAGS)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
                    raise UnsafePathError("STORAGE_ROOT is not a real directory") from exc
                raise
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
                raise UnsafePathError("STORAGE_ROOT is not a real directory") from exc
            raise
        try:
            st = os.fstat(fd)
            ident = (st.st_dev, st.st_ino)
            if self._root_id is None:
                self._root_id = ident  # first creation: pin it
            elif ident != self._root_id:
                raise UnsafePathError("STORAGE_ROOT was replaced after this store was created")
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _check_root_identity(self) -> None:
        """Raise UnsafePathError unless the configured path still names the pinned root."""
        fd = self._open_root_fd(create=False)
        if fd is not None:
            os.close(fd)

    def _open_child_dir(self, parent_fd: int, name: str, *, create: bool, label: str) -> int | None:
        """Open ``name`` under ``parent_fd`` as a contained directory, or refuse.

        Raises UnsafePathError (before any mutation) if the entry is a symlink,
        not a directory, or on a different filesystem than its parent (e.g. a
        bind mount): such a directory is not inside STORAGE_ROOT.
        """
        if create:
            try:
                os.mkdir(name, _DIR_MODE, dir_fd=parent_fd)  # never follows a symlink
            except FileExistsError:
                pass
        try:
            fd = os.open(name, self._DIR_FLAGS, dir_fd=parent_fd)
        except FileNotFoundError:
            if create:
                raise
            return None
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
                raise UnsafePathError(f"{label} is not a real directory inside STORAGE_ROOT") from exc
            raise
        try:
            st, parent = os.fstat(fd), os.fstat(parent_fd)
            if not stat.S_ISDIR(st.st_mode) or st.st_dev != parent.st_dev:
                raise UnsafePathError(f"{label} is not on the STORAGE_ROOT filesystem")
            if create:
                try:
                    os.fchmod(fd, _DIR_MODE)  # the opened directory itself, never a link target
                except OSError:
                    pass  # best-effort on filesystems that disallow chmod
        except BaseException:
            os.close(fd)
            raise
        return fd

    @contextlib.contextmanager
    def _tmp_dir_fd(self, *, create: bool):
        """Yield a contained fd for ``STORAGE_ROOT/.tmp`` (None if absent and not creating)."""
        root_fd = self._open_root_fd(create=create)
        if root_fd is None:
            yield None
            return
        try:
            fd = self._open_child_dir(root_fd, _TMP_DIRNAME, create=create, label="STORAGE_ROOT/.tmp")
        finally:
            os.close(root_fd)
        try:
            yield fd
        finally:
            if fd is not None:
                os.close(fd)

    def _publish_dir_fd(self, parts: tuple[str, ...]) -> int:
        """Create/open ``root/<parts...>`` one contained component at a time."""
        fd = self._open_root_fd(create=True)
        try:
            for i, part in enumerate(parts):
                child = self._open_child_dir(fd, part, create=True, label="/".join(parts[: i + 1]))
                os.close(fd)
                fd = child
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _relative_storage_path(self, workspace_id: int, sha256: str) -> str:
        # POSIX-style relative path stored in the DB; join uses os.sep on read.
        return f"{int(workspace_id)}/{sha256[0:2]}/{sha256[2:4]}/{sha256}"

    def _resolve_within_root(self, storage_path: str) -> Path:
        """Resolve a RELATIVE storage_path under the root, rejecting any escape.

        Defends against path traversal (`..`), absolute-path injection, and
        symlink escapes: the fully-resolved real path must stay within the
        fully-resolved real storage root.
        """
        if storage_path is None or storage_path == "":
            raise UnsafePathError("empty storage path")
        p = Path(storage_path)
        if p.is_absolute() or p.drive or p.anchor:
            raise UnsafePathError("absolute storage path is not allowed")
        if any(part == ".." for part in p.parts):
            raise UnsafePathError("parent-directory segments are not allowed")

        self._check_root_identity()
        candidate = (self._root / p)
        # Resolve symlinks/.. fully, then confirm containment within the real root.
        real_root = os.path.realpath(self._root)
        real_candidate = os.path.realpath(candidate)
        # Containment check using commonpath on realpaths.
        try:
            common = os.path.commonpath([real_root, real_candidate])
        except ValueError:
            raise UnsafePathError("storage path is not within the storage root")
        if common != real_root:
            raise UnsafePathError("storage path escapes the storage root")
        return Path(real_candidate)

    def _assert_within_root(self, path: Path) -> None:
        """Raise UnsafePathError unless `path`'s real location is within root.

        Used on the WRITE path to ensure an attacker-controlled symlink in a
        path component cannot redirect publication outside STORAGE_ROOT.
        """
        self._check_root_identity()
        real_root = os.path.realpath(self._root)
        real_path = os.path.realpath(path)
        try:
            common = os.path.commonpath([real_root, real_path])
        except ValueError:
            raise UnsafePathError("path is not within the storage root")
        if common != real_root:
            raise UnsafePathError("path escapes the storage root")

    def _verify_published(self, final: Path, sha256: str, expected_size: int) -> None:
        """Verify an already-published file matches the expected content.

        A duplicate write is only "successful" if the existing bytes are intact:
        their size and SHA-256 must match. A corrupted/mismatched existing
        original raises IntegrityError and is NEVER overwritten or silently
        accepted.
        """
        existing = final.read_bytes()
        if len(existing) != expected_size:
            raise IntegrityError(
                "existing published file size does not match expected size"
            )
        if compute_sha256(existing) != sha256:
            raise IntegrityError(
                "existing published file does not match its content address"
            )

    # --------------------------------------------------------------- core ops

    def write_once(self, workspace_id: int, sha256: str, data: bytes) -> str:
        """Atomically, idempotently publish `data` under its content hash.

        Verifies the provided sha256 matches the data, writes to a temp file,
        fsyncs, and publishes by exclusive create. Returns the RELATIVE
        storage_path. If the destination already exists, returns it WITHOUT
        replacing the existing bytes.
        """
        if not _is_valid_sha256(sha256):
            raise FileStoreError("sha256 must be 64 lowercase hex chars")
        actual = compute_sha256(data)
        if actual != sha256:
            raise IntegrityError("provided sha256 does not match data")

        rel = self._relative_storage_path(workspace_id, sha256)
        final = self._root / rel
        expected_size = len(data)
        # Write-path containment, checked BEFORE any directory is created or
        # chmod-ed: the temp dir and every publication directory component must
        # be real directories on the root's filesystem (no symlink escape). All
        # writes below are relative to those directory fds.
        parent_parts = tuple(rel.split("/")[:-1])
        with self._tmp_dir_fd(create=True) as tmp_fd:
            pub_fd = self._publish_dir_fd(parent_parts)
            try:
                # Defense in depth: the path view must agree with the fd view.
                self._assert_within_root(final.parent)
                self._assert_within_root(self._tmp_dir)
                # If already published, it is only a successful duplicate when
                # the existing bytes are intact. A corrupted/mismatched original
                # raises IntegrityError and is never overwritten or accepted.
                if final.exists():
                    self._verify_published(final, sha256, expected_size)
                    return rel
                # Unique temp name under the reserved .tmp/ dir (same volume).
                tmp_name = f"{sha256}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
                created = False
                try:
                    fd = os.open(tmp_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                                 0o600, dir_fd=tmp_fd)
                    created = True
                    with os.fdopen(fd, "wb") as f:
                        f.write(data)
                        f.flush()
                        os.fsync(f.fileno())
                    # Publish by EXCLUSIVE create: link fails if the name exists.
                    try:
                        os.link(tmp_name, sha256, src_dir_fd=tmp_fd, dst_dir_fd=pub_fd,
                                follow_symlinks=False)
                    except FileExistsError:
                        # A concurrent writer won the race. Keep ITS bytes, but
                        # only after verifying they are intact.
                        self._verify_published(final, sha256, expected_size)
                        return rel
                    # Make the published original read-only (immutable, private).
                    try:
                        pfd = os.open(sha256, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=pub_fd)
                        try:
                            os.fchmod(pfd, _PUBLISHED_MODE)
                        finally:
                            os.close(pfd)
                    except OSError:
                        pass
                    return rel
                finally:
                    # Best-effort cleanup of OUR uniquely named temp file only,
                    # never a published original. A hard crash may leave an
                    # orphan under .tmp/ (reclaimed at the next startup).
                    if created:
                        try:
                            os.unlink(tmp_name, dir_fd=tmp_fd)
                        except OSError:
                            pass
            finally:
                os.close(pub_fd)

    # ---- crash-safe capacity accounting (deployment foundation P1-2) ----
    #
    # Lifecycle of one write: temp file created under ``.tmp/`` and fsynced ->
    # hard-linked to its content-addressed path (publication) -> temp name
    # unlinked. A crash can leave (a) an unpublished temp file, or (b) a temp
    # name that is a second hard link to a published original. Recovery runs
    # only while no upload is in flight (an EXCLUSIVE lock that every upload
    # holds SHARED while it reserves and writes). It removes ONLY names that
    # match this store's own temp-file pattern (case (a) frees bytes, case (b)
    # only drops a link: the published original keeps its inode and bytes),
    # then counts every remaining regular file once per inode.

    @contextlib.contextmanager
    def allocation_guard(self, *, exclusive: bool = False, wait: bool = True):
        """Cross-process allocation lock: ``fcntl.flock`` on the pinned STORAGE_ROOT.

        Uploads take it SHARED around "reserve capacity, write bytes"; startup
        recovery takes it EXCLUSIVE, so it can never run while an upload in any
        process is between those steps. ``wait=False`` raises
        ``StorageBusyError`` instead of waiting. The lock is released if the
        holder dies.

        The lock is held on the root DIRECTORY, not on a file inside it. Its
        identity is therefore the root's (device, inode), which is pinned and
        re-checked: renaming or replacing ``.tmp`` (or planting a file named
        like the old lock) cannot create a second, independent lock domain, and
        replacing the root itself is refused. Refusals happen before the lock is
        taken or anything is created.

        Yields an ``_AllocationGuard`` holding the validated root and ``.tmp``
        directory handles for this guard's lifetime. Pass it to
        ``reclaim_temp_files`` / ``retained_bytes`` / ``published_bytes`` so a
        guarded operation never re-opens ``.tmp`` or the root by pathname.
        """
        import fcntl
        root_fd = self._open_root_fd(create=True)  # NOFOLLOW + identity-checked
        tmp_fd: int | None = None
        try:
            mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            try:
                fcntl.flock(root_fd, mode if wait else mode | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise StorageBusyError("storage allocation is in use") from exc
            # The root may have been replaced while this call waited for the lock.
            self._check_root_identity()
            tmp_fd = self._open_child_dir(root_fd, _TMP_DIRNAME, create=True, label="STORAGE_ROOT/.tmp")
            st = os.fstat(tmp_fd)
            yield _AllocationGuard(self, root_fd, tmp_fd, (st.st_dev, st.st_ino))
        finally:
            if tmp_fd is not None:
                os.close(tmp_fd)
            os.close(root_fd)  # closing releases the flock

    def _own_guard(self, guard: "_AllocationGuard | None") -> None:
        if guard is not None and guard._store is not self:
            raise ValueError("allocation guard belongs to a different FileStore")

    def reclaim_temp_files(self, guard: "_AllocationGuard | None" = None) -> tuple[int, int]:
        """Remove this store's own leftover temp files; returns (files, bytes freed).

        Call ONLY while holding ``allocation_guard(exclusive=True)`` and pass its
        guard: the cleanup then runs on the guard's validated ``.tmp`` handle and
        refuses (UnsafePathError) if ``.tmp`` or the root was replaced since the
        guard was taken. Without a guard it opens ``.tmp`` itself (validated).
        Never touches anything outside ``.tmp/`` and never a name that does not
        match the temp-file or preflight-probe pattern. Bytes are "freed" only
        when the removed name was the file's last link.
        """
        self._own_guard(guard)
        if guard is not None:
            guard.verify()
            return self._reclaim_in(guard.tmp_fd)
        with self._tmp_dir_fd(create=False) as tmp_fd:  # refuses a symlinked/out-of-root .tmp
            if tmp_fd is None:
                return 0, 0
            return self._reclaim_in(tmp_fd)

    @staticmethod
    def _reclaim_in(tmp_fd: int) -> tuple[int, int]:
        files = freed = 0
        with os.scandir(tmp_fd) as entries:
            names = [e.name for e in entries]
        for name in names:
            if not (_TEMP_NAME.match(name) or _PROBE_NAME.match(name)):
                continue
            try:
                st = os.stat(name, dir_fd=tmp_fd, follow_symlinks=False)
                if not stat.S_ISREG(st.st_mode):
                    continue
                os.unlink(name, dir_fd=tmp_fd)
            except OSError:
                continue
            files += 1
            if st.st_nlink <= 1:
                freed += st.st_size
        return files, freed

    def _scan_regular_files(self, *, include_tmp: bool, guard: "_AllocationGuard | None" = None):
        """Yield ``lstat`` results for every regular file under the root.

        Fail-closed: any directory that cannot be listed and any entry that
        cannot be inspected raises ``StorageScanError`` instead of being
        skipped, so no caller can mistake a partial scan for a complete one.
        Symlinks are never followed. Read-only. The walk is relative to a
        validated root handle (the guard's, if given), never the path again; with
        a guard, ``.tmp`` is read through the guard's own ``tmp_fd`` (never
        listed, stat-ed or opened by name), and the guard is re-verified before
        and after, so a count taken across a root or ``.tmp`` replacement is
        never returned. Every other directory is opened by name relative to its
        parent handle and must be the very inode that was just stat-ed.
        """
        self._own_guard(guard)

        def fail(rel: str, exc: OSError) -> None:
            raise StorageScanError(f"cannot inspect {rel or '.'!r} under STORAGE_ROOT ({type(exc).__name__})") from exc

        def walk(dir_fd: int, rel: str):
            try:
                with os.scandir(dir_fd) as entries:
                    names = [e.name for e in entries]
            except OSError as exc:
                fail(rel, exc)
            # With a guard, ``.tmp`` is walked below through guard.tmp_fd, so its
            # name is never trusted here (a substitute, or a name that is absent
            # at listing time, must not change the count).
            skip_tmp = not rel and (not include_tmp or guard is not None)
            for name in names:
                if skip_tmp and name == _TMP_DIRNAME:
                    continue
                child = f"{rel}/{name}" if rel else name
                try:
                    st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                except OSError as exc:
                    fail(child, exc)
                if stat.S_ISREG(st.st_mode):
                    yield st
                elif stat.S_ISDIR(st.st_mode):
                    try:
                        sub = os.open(name, self._DIR_FLAGS, dir_fd=dir_fd)
                    except OSError as exc:
                        fail(child, exc)
                    try:
                        opened = os.fstat(sub)
                        if (opened.st_dev, opened.st_ino) != (st.st_dev, st.st_ino):
                            raise StorageScanError(f"{child!r} changed while it was being scanned")
                        yield from walk(sub, child)
                    finally:
                        os.close(sub)
            if guard is not None and include_tmp and not rel:
                yield from walk(guard.tmp_fd, _TMP_DIRNAME)  # the guard's handle, not a pathname

        if guard is not None:
            guard.verify()
            yield from walk(guard.root_fd, "")
            guard.verify()
            return
        root_fd = self._open_root_fd(create=False)
        if root_fd is None:
            return
        try:
            yield from walk(root_fd, "")
        finally:
            os.close(root_fd)

    def retained_bytes(self, guard: "_AllocationGuard | None" = None) -> int:
        """Every regular file under the root, ``.tmp/`` included, counted once
        per inode (hard links are not double-counted). Read-only.

        Raises ``StorageScanError`` if any part of the tree cannot be inspected
        (never a partial total), and ``UnsafePathError`` if the root was replaced."""
        seen: set[tuple[int, int]] = set()
        total = 0
        for st in self._scan_regular_files(include_tmp=True, guard=guard):
            if (st.st_dev, st.st_ino) in seen:
                continue
            seen.add((st.st_dev, st.st_ino))
            total += st.st_size
        return total

    def is_published(self, workspace_id: int, sha256: str) -> bool:
        """True when this workspace already holds these exact bytes on disk
        (a later write would add no physical bytes)."""
        if not _is_valid_sha256(sha256):
            return False
        return self.exists(self._relative_storage_path(workspace_id, sha256))

    def published_bytes(self, guard: "_AllocationGuard | None" = None) -> int:
        """Total size of every file under the root except the reserved ``.tmp/``
        directory: all retained physical bytes, including published originals
        that no database row references (e.g. after a failed transaction).
        Read-only; never modifies or removes anything. Raises
        ``StorageScanError`` rather than returning a partial total, and
        ``UnsafePathError`` if the root was replaced."""
        return sum(st.st_size for st in self._scan_regular_files(include_tmp=False, guard=guard))

    def exists(self, storage_path: str) -> bool:
        try:
            resolved = self._resolve_within_root(storage_path)
        except UnsafePathError:
            return False
        return resolved.is_file()

    def read(self, storage_path: str, *, expected_sha256: str | None = None,
             expected_size: int | None = None) -> bytes:
        """Read bytes back, verifying integrity.

        Always re-verifies the SHA-256 against the content-addressed filename
        (the last path segment) so silent corruption is detected. Optional
        explicit expected_sha256 / expected_size add defense in depth.
        """
        resolved = self._resolve_within_root(storage_path)
        if not resolved.is_file():
            raise FileStoreError("storage path does not exist")
        data = resolved.read_bytes()

        # Size check (if provided).
        if expected_size is not None and len(data) != expected_size:
            raise IntegrityError("stored byte size does not match expected size")

        # Content-address self-check: filename is the sha256 of the bytes.
        name_hash = resolved.name
        actual = compute_sha256(data)
        if _is_valid_sha256(name_hash) and actual != name_hash:
            raise IntegrityError("stored bytes do not match content address")
        if expected_sha256 is not None and actual != expected_sha256:
            raise IntegrityError("stored bytes do not match expected sha256")
        return data

    # ------------------------------------------------------------- housekeeping

    def sweep_stale_temp_files(self, older_than_seconds: float = 3600) -> int:
        """Remove ONLY stale temp files under `.tmp/`. Never touches published
        originals. Returns the count removed. Safe and idempotent."""
        with self._tmp_dir_fd(create=False) as tmp_fd:  # refuses a symlinked/out-of-root .tmp
            if tmp_fd is None:
                return 0
            now = time.time()
            removed = 0
            with os.scandir(tmp_fd) as entries:
                names = [e.name for e in entries]
            for name in names:
                try:
                    st = os.stat(name, dir_fd=tmp_fd, follow_symlinks=False)
                    if stat.S_ISREG(st.st_mode) and now - st.st_mtime >= older_than_seconds:
                        os.unlink(name, dir_fd=tmp_fd)
                        removed += 1
                except OSError:
                    pass
            return removed


class _AllocationGuard:
    """Validated handles held for the lifetime of one ``allocation_guard``.

    ``root_fd`` is the flock-ed, identity-pinned storage root; ``tmp_fd`` is
    ``.tmp`` opened relative to it (NOFOLLOW, same filesystem). Guarded
    operations use these handles instead of re-opening anything by pathname, and
    call ``verify()`` to prove the pathnames still name the same directories.
    """

    __slots__ = ("_store", "root_fd", "tmp_fd", "_tmp_id")

    def __init__(self, store: FileStore, root_fd: int, tmp_fd: int, tmp_id: tuple[int, int]) -> None:
        self._store = store
        self.root_fd = root_fd
        self.tmp_fd = tmp_fd
        self._tmp_id = tmp_id

    def verify(self) -> None:
        """Raise UnsafePathError if the root or ``.tmp`` was replaced since the guard was taken."""
        self._store._check_root_identity()
        try:
            st = os.stat(_TMP_DIRNAME, dir_fd=self.root_fd, follow_symlinks=False)
        except OSError as exc:
            raise UnsafePathError("STORAGE_ROOT/.tmp disappeared while the allocation guard was held") from exc
        if not stat.S_ISDIR(st.st_mode) or (st.st_dev, st.st_ino) != self._tmp_id:
            raise UnsafePathError("STORAGE_ROOT/.tmp was replaced while the allocation guard was held")
