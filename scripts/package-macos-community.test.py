"""Portable safety tests; real signing and launch probes run on macOS separately."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("macos_packager", Path(__file__).with_name("package-macos-community.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackagingSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def test_existing_and_dangling_destinations_are_never_replaced(self):
        output = self.root / "Editkin.app"
        output.mkdir()
        marker = output / "existing-user-file"
        marker.write_text("keep")
        with self.assertRaisesRegex(ValueError, "overwrite"):
            packager.require_new_output(output)
        staged = self.root / "staged.app"
        (staged / "Contents").mkdir(parents=True)
        with self.assertRaises(FileExistsError):
            packager.publish_app(staged, output)
        self.assertEqual(marker.read_text(), "keep")
        alias = self.root / "alias.app"
        alias.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "overwrite"):
            packager.require_new_output(alias)

    def test_publish_does_not_overwrite_a_destination_created_after_preflight(self):
        output = self.root / "Editkin.app"
        packager.require_new_output(output)
        output.mkdir()
        with self.assertRaises(FileExistsError):
            packager.publish_app(self.root / "staged.app", output)
        self.assertTrue(output.is_dir())

    def test_failed_publication_removes_only_its_empty_reservation(self):
        output = self.root / "Editkin.app"
        with self.assertRaises(FileNotFoundError):
            packager.publish_app(self.root / "missing.app", output)
        self.assertFalse(output.exists())

    def test_publish_moves_complete_contents(self):
        staged = self.root / "staged.app"
        (staged / "Contents").mkdir(parents=True)
        (staged / "Contents/Info.plist").write_bytes(b"verified")
        output = self.root / "Editkin.app"
        packager.publish_app(staged, output)
        self.assertEqual((output / "Contents/Info.plist").read_bytes(), b"verified")

    def test_resource_tree_rejects_symlinks(self):
        source = self.root / "resources"
        source.mkdir()
        (source / "alias").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            packager.copy_tree(source, self.root / "copied")
        self.assertFalse((self.root / "copied").exists())

    def test_node_library_abi_is_discovered_not_hardcoded(self):
        node = self.root / "prefix/bin/node"
        library = self.root / "prefix/lib/libnode.999.dylib"
        node.parent.mkdir(parents=True)
        library.parent.mkdir()
        node.write_bytes(b"node")
        library.write_bytes(b"library")
        with patch.object(packager, "dependencies", side_effect=lambda p: ["@rpath/libnode.999.dylib"] if p == node else ["/usr/lib/libSystem.B.dylib"]):
            self.assertEqual(packager.node_libraries(node), {library.name: (library, "@rpath/libnode.999.dylib")})

    def test_unresolved_relative_dependencies_fail_closed(self):
        with patch.object(packager, "dependencies", return_value=["@rpath/other.dylib"]):
            with self.assertRaisesRegex(ValueError, "Unsupported relative"):
                packager.node_libraries(self.root / "node")
            with self.assertRaisesRegex(ValueError, "Unsupported relative"):
                packager.require_absolute_dependencies(self.root / "ffmpeg")

    def test_wrong_architecture_is_rejected(self):
        with patch.object(packager, "capture", return_value="x86_64"):
            with self.assertRaisesRegex(ValueError, "host architecture"):
                packager.require_architecture(self.root / "node", "arm64")
        with patch.object(packager, "capture", return_value="x86_64 arm64"):
            packager.require_architecture(self.root / "node", "arm64")

    def test_metadata_keeps_only_names_and_hashes(self):
        source = self.root / "custom-prefix/bin/node"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"runtime")
        record = packager.source_record(source)
        dependency = packager.dependency_record(str(self.root / "custom-prefix/lib/library.dylib"))
        text = json.dumps([record, dependency])
        self.assertNotIn(str(self.root), text)
        self.assertNotIn("custom-prefix", text)
        self.assertEqual(len(record["sha256"]), 64)
        self.assertEqual(dependency, {"name": "library.dylib", "kind": "external-host-library"})

    def test_runtime_inventory_requires_real_capability_lines(self):
        # Newer FFmpeg builds have two filter flags; older builds have three.
        text = " .. ass V->V subtitle filter\n T.C drawtext V->V text\n V....D libx264 encoder\n missing subtitles support\n"
        self.assertEqual(packager.inventory_names(text), {"ass", "drawtext", "libx264"})


if __name__ == "__main__":
    unittest.main()
