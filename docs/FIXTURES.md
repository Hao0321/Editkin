# Synthetic test media

The MP4 fixtures in this source edition were generated on 2026-09-23 from FFmpeg `lavfi` patterns, without imported video, music, speech, or private design references. They are contributed by the Editkin maintainer under GPL-3.0-or-later alongside the program source. The generated patterns are for testing and carry no claim about production image quality.

The generator used FFmpeg's `testsrc2`, `color`, and `anullsrc` sources, H.264 at 30 fps, AAC silent audio for the 12-second demo, and `+faststart`. The exact file hashes are listed in `PUBLIC_SOURCE_MANIFEST.json`; source checkout verification can compare them with `sha256sum` or `Get-FileHash`.
