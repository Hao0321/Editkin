"""Offline installer contract tests using disposable checkouts and tool stubs.

No real npm, Cargo, Homebrew, signing, or application installation is performed.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE_ROOT = Path(__file__).resolve().parent.parent
GIT = shutil.which("git")
STUB = r'''#!/bin/bash
tool="${0##*/}"
printf '%s\n' "$tool $*" >> "$EDITKIN_TEST_CALLS"
case "$tool" in
  brew) printf '%s\n' "$EDITKIN_TEST_PREFIX" ;;
  uname) if [ "$1" = -s ]; then printf '%s\n' "${EDITKIN_TEST_SYSTEM:-Darwin}"; else echo arm64; fi ;;
  id) echo "${EDITKIN_TEST_UID:-501}" ;;
  rustc) echo "rustc ${EDITKIN_TEST_RUST:-1.92.0} (test fixture)" ;;
  node)
    if [ "${EDITKIN_TEST_NODE_FAIL:-0}" = 1 ]; then echo 'Node prerequisite failed' >&2; exit 1; fi
    ;;
  ffmpeg)
    case "$*" in
      *-encoders*)
        [ "${EDITKIN_TEST_OMIT:-}" = libx264 ] || echo ' V..... libx264 test encoder'
        [ "${EDITKIN_TEST_OMIT:-}" = aac ] || echo ' A..... aac test encoder'
        ;;
      *-filters*)
        for filter in ass subtitles drawtext; do
          [ "${EDITKIN_TEST_OMIT:-}" = "$filter" ] || echo " ... $filter V->V test filter"
        done
        ;;
    esac
    exit 0
    ;;
  ffprobe) echo 'ffprobe version 8.0' ;;
  xcrun) echo /fixture/clang ;;
  npm|cargo|codesign)
    echo "Blocked real build or signing: $tool" >&2
    exit 87
    ;;
  *) echo "Unexpected stub: $tool" >&2; exit 88 ;;
esac
'''


@unittest.skipUnless(GIT and Path("/bin/bash").is_file(), "Git and Bash are required")
class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="editkin-installer-test-")
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / "checkout with spaces"
        (self.repo / "scripts").mkdir(parents=True)
        for relative in ("scripts/install-macos-community.sh", "Install-on-Mac.command"):
            shutil.copy2(SOURCE_ROOT / relative, self.repo / relative)
        (self.repo / "tracked.txt").write_text("original\n")
        (self.repo / ".gitignore").write_text(".rd/\n.ignored/\n")
        self.calls = self.root / "tool-calls.txt"
        prefix = self.root / "tool prefix"
        tool_bin = prefix / "bin"
        tool_bin.mkdir(parents=True)
        for name in ("brew", "uname", "id", "node", "npm", "cargo", "rustc", "ffmpeg", "ffprobe", "xcrun", "codesign"):
            path = tool_bin / name
            path.write_text(STUB)
            path.chmod(0o755)
        (tool_bin / "python3").symlink_to(sys.executable)
        (tool_bin / "git").symlink_to(GIT)
        self.environment = {
            **os.environ,
            "PATH": str(tool_bin) + os.pathsep + "/usr/bin:/bin",
            "EDITKIN_TEST_PREFIX": str(prefix),
            "EDITKIN_TEST_CALLS": str(self.calls),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        self.git("init", "--quiet")
        self.git("add", ".")
        self.output = self.root / "Applications with spaces" / "Editkin Test.app"

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *arguments):
        return subprocess.run([GIT, *arguments], cwd=self.repo, env=self.environment,
                              check=True, capture_output=True, text=True, timeout=20)

    def run_installer(self, *arguments, finder=False, **environment):
        entry = "Install-on-Mac.command" if finder else "scripts/install-macos-community.sh"
        return subprocess.run(["/bin/bash", str(self.repo / entry), *arguments],
                              cwd=self.root, env={**self.environment, **environment},
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)

    def assert_no_build(self):
        calls = self.calls.read_text() if self.calls.exists() else ""
        self.assertFalse(any(line.split()[0] in {"npm", "cargo", "codesign"}
                             for line in calls.splitlines()), calls)
        self.assertFalse((self.repo / ".rd").exists())
        self.assertFalse(self.output.exists())

    def test_help_and_invalid_cli_do_not_probe_or_write(self):
        for arguments, status in ((["--help"], 0), (["--unknown"], 2), (["--output"], 2)):
            with self.subTest(arguments=arguments):
                result = self.run_installer(*arguments)
                self.assertEqual(result.returncode, status, result.stderr)
        self.assertFalse(self.calls.exists())
        self.assert_no_build()

    def test_check_is_read_only_and_accepts_spaces(self):
        before = self.git("status", "--porcelain", "--untracked-files=all").stdout
        result = self.run_installer("--check", "--output", str(self.output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Prerequisites OK", result.stdout)
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all").stdout, before)
        self.assertFalse(self.output.parent.exists())
        self.assert_no_build()

    def test_unsupported_platform_and_root_fail_before_dependencies(self):
        for environment, message in (({"EDITKIN_TEST_SYSTEM": "Linux"}, "requires macOS"),
                                     ({"EDITKIN_TEST_UID": "0"}, "without sudo")):
            with self.subTest(environment=environment):
                result = self.run_installer("--output", str(self.output), **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
        self.assert_no_build()

    def test_invalid_destination_does_not_start_build(self):
        result = self.run_installer("--output", str(self.root / "not-an-app"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(".app", result.stderr)
        self.assert_no_build()

    def test_existing_application_and_dangling_symlink_are_preserved(self):
        self.output.mkdir(parents=True)
        marker = self.output / "user-file"
        marker.write_bytes(b"preserve existing application")
        before = marker.stat().st_mtime_ns
        result = self.run_installer("--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Destination exists", result.stderr)
        self.assertEqual(marker.read_bytes(), b"preserve existing application")
        self.assertEqual(marker.stat().st_mtime_ns, before)
        alias = self.root / "dangling.app"
        alias.symlink_to(self.root / "missing-target")
        result = self.run_installer("--output", str(alias))
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(alias.is_symlink())
        self.assertFalse((self.repo / ".rd").exists())
        self.assertNotIn("npm ", self.calls.read_text())

    def test_failed_node_rust_and_media_prerequisites_do_not_start_build(self):
        cases = [{"EDITKIN_TEST_NODE_FAIL": "1"}, {"EDITKIN_TEST_RUST": "1.91.0"}]
        cases += [{"EDITKIN_TEST_OMIT": name} for name in ("libx264", "aac", "ass", "subtitles", "drawtext")]
        for environment in cases:
            with self.subTest(environment=environment):
                result = self.run_installer("--output", str(self.output), **environment)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assert_no_build()

    def test_finder_entry_preserves_failure_status(self):
        result = self.run_installer("--unknown", finder=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unknown option", result.stderr)
        self.assert_no_build()

    def test_isolated_copy_excludes_untracked_files_and_preserves_source(self):
        (self.repo / "tracked.txt").write_text("local working-tree change\n")
        (self.repo / "untracked.txt").write_text("do not copy\n")
        (self.repo / ".ignored").mkdir()
        (self.repo / ".ignored/media.txt").write_text("do not copy\n")
        result = self.run_installer("--output", str(self.output))
        self.assertEqual(result.returncode, 87, result.stderr)
        copies = list((self.repo / ".rd").glob("macos-community.*/source"))
        self.assertEqual(len(copies), 1)
        self.assertEqual((copies[0] / "tracked.txt").read_text(), "local working-tree change\n")
        self.assertFalse((copies[0] / "untracked.txt").exists())
        self.assertFalse((copies[0] / ".ignored").exists())
        self.assertEqual((self.repo / "tracked.txt").read_text(), "local working-tree change\n")
        self.assertEqual((self.repo / ".ignored/media.txt").read_text(), "do not copy\n")
        self.assertFalse(self.output.exists())

    def test_tracked_symlink_is_rejected_before_downloads(self):
        outside = self.root / "outside.txt"
        outside.write_text("unchanged\n")
        (self.repo / "linked.txt").symlink_to(outside)
        self.git("add", "linked.txt")
        result = self.run_installer("--output", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Symlink in tracked source", result.stderr)
        self.assertEqual(outside.read_text(), "unchanged\n")
        self.assertNotIn("npm ", self.calls.read_text())
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
