"""Read-only observation of caller-held Windows process objects.

This newly authored module has not been executed or validated by its author.
It never creates, opens, closes, waits with a nonzero timeout, or terminates a
process. The caller retains both handles and must establish the parent's
creating-owner lineage separately. An observed PID or parent relation grants
no termination authority. An unavailable image is never replaced by an
expected filename, and these observations never certify executable bytes or
successful work. No DLL is loaded merely by importing this module.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import ntpath
import os


SCHEMA = "editkin.windows-held-process-observation/v1"
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
ERROR_ACCESS_DENIED = 5
MAX_DWORD = (1 << 32) - 1
MAX_FILETIME = (1 << 64) - 1


class PROCESS_BASIC_INFORMATION(ctypes.Structure):
    """Native Win64 PBI: two signed LONGs and four pointer-sized fields."""
    _fields_ = [
        ("ExitStatus", ctypes.c_int32),
        ("PebBaseAddress", ctypes.c_void_p),
        ("AffinityMask", ctypes.c_size_t),
        ("BasePriority", ctypes.c_int32),
        ("UniqueProcessId", ctypes.c_size_t),
        ("InheritedFromUniqueProcessId", ctypes.c_size_t),
    ]


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _integer(value, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


class WindowsHeldProcessReader:
    """Observe exact held objects without assuming custody of either handle.

    The five _read_* getters return actual API observations. A fixture may
    override a single getter, but that is an explicitly controlled observation,
    not evidence that the corresponding fault happened naturally on Windows.
    This module does not implement executable pinning or a process supervisor.
    """

    def __init__(self):
        if os.name != "nt" or ctypes.sizeof(ctypes.c_void_p) != 8:
            raise RuntimeError("actual Win64 held-process reader required")
        if ctypes.sizeof(PROCESS_BASIC_INFORMATION) != 48:
            raise RuntimeError("unexpected native Win64 PBI layout")
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._nt = ctypes.WinDLL("ntdll", use_last_error=True)
        signatures = (
            ("GetProcessTimes", [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
            ("WaitForSingleObject", [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            ("GetExitCodeProcess", [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            ("QueryFullProcessImageNameW", [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                           ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        )
        for name, arguments, result in signatures:
            function = getattr(self._kernel, name)
            function.argtypes, function.restype = arguments, result
        query = self._nt.NtQueryInformationProcess
        query.argtypes = [wintypes.HANDLE, ctypes.c_int32, ctypes.c_void_p,
                          wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
        query.restype = ctypes.c_int32

    def _read_basic(self, handle: int) -> dict:
        value, returned = PROCESS_BASIC_INFORMATION(), wintypes.ULONG()
        status = int(self._nt.NtQueryInformationProcess(
            handle, 0, ctypes.byref(value), ctypes.sizeof(value), ctypes.byref(returned)))
        if status != 0 or returned.value != ctypes.sizeof(value):
            raise RuntimeError("held PBI query failed: ntstatus=" + str(status)
                               + ", returnedBytes=" + str(returned.value))
        return {"pid": int(value.UniqueProcessId),
                "parentPid": int(value.InheritedFromUniqueProcessId)}

    def _read_times(self, handle: int) -> dict:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not self._kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                            ctypes.byref(kernel), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {"birthFileTime": (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime),
                "exitFileTime": (int(exited.dwHighDateTime) << 32) | int(exited.dwLowDateTime)}

    def _read_wait(self, handle: int) -> int:
        state = int(self._kernel.WaitForSingleObject(handle, 0))
        if state == MAX_DWORD:
            raise ctypes.WinError(ctypes.get_last_error())
        return state

    def _read_exit_code(self, handle: int) -> int:
        value = wintypes.DWORD()
        if not self._kernel.GetExitCodeProcess(handle, ctypes.byref(value)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(value.value)

    def _read_image(self, handle: int) -> dict:
        buffer, length = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
        if not self._kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
            return {"ok": False, "image": None, "win32Error": int(ctypes.get_last_error())}
        if not 0 < length.value < 32768:
            raise RuntimeError("held image query returned invalid character count")
        return {"ok": True, "image": buffer.value, "win32Error": None}

    @staticmethod
    def _error(result: dict, code: str, **details) -> None:
        result["errors"].append({"code": code, "observedUtc": _utc(), **details})

    def _get(self, result: dict, phase: str, subject: str, getter: str, handle: int):
        try:
            return getattr(self, getter)(handle)
        except Exception as error:
            self._error(result, "kernel-read-failed", phase=phase, subject=subject,
                        getter=getter, errorType=type(error).__name__, message=str(error),
                        win32Error=getattr(error, "winerror", None))
            return None

    def _capture(self, result: dict, phase: str, child: int, parent: int) -> dict:
        snapshot = {"capturedUtc": _utc(), "child": {}, "parent": {}}
        for subject, handle in (("child", child), ("parent", parent)):
            entry = snapshot[subject]
            entry["basic"] = self._get(result, phase, subject, "_read_basic", handle)
            # A live process's exit FILETIME is undefined. Establish wait state
            # first; raw timing bytes are retained without using them as liveness.
            entry["waitState"] = self._get(result, phase, subject, "_read_wait", handle)
            entry["times"] = self._get(result, phase, subject, "_read_times", handle)
            entry["exitCode"] = (self._get(result, phase, subject, "_read_exit_code", handle)
                                 if entry["waitState"] == WAIT_OBJECT_0 else None)
            entry["exitFileTimeDefined"] = entry["waitState"] == WAIT_OBJECT_0
        snapshot["completedUtc"] = _utc()
        return snapshot

    def _validate_entry(self, result: dict, phase: str, subject: str, entry: dict) -> None:
        basic, times, state = entry["basic"], entry["times"], entry["waitState"]
        valid_basic = (isinstance(basic, dict)
                       and _integer(basic.get("pid"), 1, MAX_DWORD)
                       and _integer(basic.get("parentPid"), 0, MAX_DWORD))
        valid_times = (isinstance(times, dict)
                       and _integer(times.get("birthFileTime"), 1, MAX_FILETIME)
                       and _integer(times.get("exitFileTime"), 0, MAX_FILETIME))
        valid_wait = type(state) is int and state in (WAIT_OBJECT_0, WAIT_TIMEOUT)
        if not valid_basic:
            self._error(result, "invalid-held-basic", phase=phase, subject=subject)
        if not valid_times:
            self._error(result, "invalid-held-times", phase=phase, subject=subject)
        if not valid_wait:
            self._error(result, "invalid-held-wait", phase=phase, subject=subject, actual=state)
        if valid_wait and state == WAIT_OBJECT_0:
            if not _integer(entry["exitCode"], 0, MAX_DWORD):
                self._error(result, "invalid-held-exit-code", phase=phase, subject=subject)
            if valid_times and times["exitFileTime"] < times["birthFileTime"]:
                self._error(result, "invalid-held-exit-interval", phase=phase, subject=subject)

    @staticmethod
    def _wire_times(result: dict) -> dict:
        # Preserve all available observations, including undefined live exit
        # bytes, with FILETIME represented losslessly as decimal strings.
        for phase in ("before", "after"):
            snapshot = result[phase]
            if snapshot is None:
                continue
            for subject in ("child", "parent"):
                times = snapshot[subject].get("times")
                if isinstance(times, dict):
                    snapshot[subject]["times"] = {
                        key: str(value) if type(value) is int else value
                        for key, value in times.items()}
        result["completedUtc"] = _utc()
        return result

    def observe(self, child_handle, parent_handle, expected_child_pid, expected_parent_pid,
                expected_parent_birth_filetime, *, parent_proved, role="sampled-descendant") -> dict:
        result = {
            "schema": SCHEMA, "status": "BLOCK", "acceptedObservation": False,
            "acceptedClosure": False, "image": None, "imageVerified": False,
            "terminationEligible": False, "WorkSuccessNotCertified": True,
            "workSuccessCertified": False, "fullExecutableIdentityCertified": False,
            "role": role, "observedUtc": _utc(),
            "expected": {"childPid": expected_child_pid, "parentPid": expected_parent_pid,
                         "parentBirthFileTime": str(expected_parent_birth_filetime),
                         "parentProved": parent_proved},
            "errors": [], "before": None, "after": None, "imageQuery": None,
            "basis": {
                "heldHandlesReadOnly": True, "callerRetainsHandles": True,
                "parentProofIsCallerPrecondition": True,
                "sampledPidDoesNotGrantAuthority": True,
                "identityStable": False, "parentBirthMatches": False,
                "childRelationMatches": False, "birthIntervalValidated": False,
                "liveExitFileTimeUsedForLiveness": False,
                "closureScope": "one exact held child, not exhaustive descendant closure",
                "imageScope": "actual API image path only, not executable-byte certification",
                "imageUnavailableCauseEstablished": False,
            },
        }
        maximum_handle = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1
        if (not _integer(child_handle, 1, maximum_handle)
                or not _integer(parent_handle, 1, maximum_handle)
                or child_handle == parent_handle
                or not _integer(expected_child_pid, 1, MAX_DWORD)
                or not _integer(expected_parent_pid, 1, MAX_DWORD)
                or expected_child_pid == expected_parent_pid
                or not _integer(expected_parent_birth_filetime, 1, MAX_FILETIME)
                or type(parent_proved) is not bool or not parent_proved
                or not isinstance(role, str) or not 1 <= len(role) <= 128):
            self._error(result, "invalid-held-observation-preconditions")
            return self._wire_times(result)

        result["before"] = self._capture(result, "before", child_handle, parent_handle)
        query = self._get(result, "image", "child", "_read_image", child_handle)
        result["imageQuery"] = {"observedUtc": _utc(), "ok": None, "image": None,
                                "win32Error": None}
        if isinstance(query, dict):
            result["imageQuery"].update(query)
        result["after"] = self._capture(result, "after", child_handle, parent_handle)
        for phase in ("before", "after"):
            for subject in ("child", "parent"):
                self._validate_entry(result, phase, subject, result[phase][subject])

        image_ok = (isinstance(query, dict) and query.get("ok") is True
                    and isinstance(query.get("image"), str)
                    and 0 < len(query["image"]) < 32768 and ntpath.isabs(query["image"])
                    and query.get("win32Error") is None)
        image_failure = (isinstance(query, dict) and query.get("ok") is False
                         and query.get("image") is None
                         and _integer(query.get("win32Error"), 1, MAX_DWORD))
        if not image_ok and not image_failure:
            self._error(result, "invalid-held-image-result")
        if result["errors"]:
            return self._wire_times(result)

        before, after = result["before"], result["after"]
        for phase, snapshot in (("before", before), ("after", after)):
            child, parent = snapshot["child"], snapshot["parent"]
            if (child["basic"]["pid"] != expected_child_pid
                    or child["basic"]["parentPid"] != expected_parent_pid
                    or parent["basic"]["pid"] != expected_parent_pid):
                self._error(result, "held-pid-or-parent-mismatch", phase=phase)
            if parent["times"]["birthFileTime"] != expected_parent_birth_filetime:
                self._error(result, "held-parent-birth-mismatch", phase=phase)
            child_birth, parent_birth = child["times"]["birthFileTime"], parent["times"]["birthFileTime"]
            if child_birth < parent_birth:
                self._error(result, "child-predates-held-parent", phase=phase)
            if (parent["waitState"] == WAIT_OBJECT_0
                    and child_birth > parent["times"]["exitFileTime"]):
                self._error(result, "child-created-after-held-parent-exit", phase=phase)
        for subject in ("child", "parent"):
            first, last = before[subject], after[subject]
            if (first["basic"] != last["basic"]
                    or first["times"]["birthFileTime"] != last["times"]["birthFileTime"]):
                self._error(result, "held-identity-drift", subject=subject)
            if first["waitState"] == WAIT_OBJECT_0:
                if last["waitState"] != WAIT_OBJECT_0:
                    self._error(result, "held-exit-state-regression", subject=subject)
                elif (first["times"]["exitFileTime"] != last["times"]["exitFileTime"]
                      or first["exitCode"] != last["exitCode"]):
                    self._error(result, "held-exit-observation-drift", subject=subject)
        if result["errors"]:
            return self._wire_times(result)

        result["basis"].update(identityStable=True, parentBirthMatches=True,
                                childRelationMatches=True, birthIntervalValidated=True)
        closed = after["child"]["waitState"] == WAIT_OBJECT_0
        if image_ok:
            result["status"] = "EXITED_IMAGE_VERIFIED" if closed else "LIVE_IMAGE_VERIFIED"
            result["image"], result["imageVerified"] = query["image"], True
        elif (role == "sampled-descendant" and query["win32Error"] == ERROR_ACCESS_DENIED
              and closed):
            result["status"] = "READ_ONLY_EXITED_IMAGE_UNAVAILABLE"
        else:
            self._error(result, "held-image-unavailable-without-readonly-closed-exception",
                        win32Error=query["win32Error"], role=role, childExitSignaled=closed)
            return self._wire_times(result)
        result["acceptedObservation"], result["acceptedClosure"] = True, closed
        return self._wire_times(result)
