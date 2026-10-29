# Third-party notices and release obligations

Editkin uses dependencies locked in `package-lock.json` and `native/hao-core/Cargo.lock`. The Electron fallback package also contains Electron／Chromium license files. The Tauri target uses WebView2 supplied by Windows rather than bundling Chromium.

## Editkin

Editkin itself is free software licensed under the GNU General Public License, version 3 or (at your option) any later version (GPL-3.0-or-later). Source repository: https://github.com/Hao0321/Editkin . The written offer at the end of the FFmpeg section also covers the complete corresponding source of the Editkin build in this installer.

## FFmpeg

The Windows installer bundles `runtime/ffmpeg.exe` and `runtime/ffprobe.exe` (staged from `vendor/ffmpeg/win32-x64/`). Both are the same upstream FFmpeg release, built statically by the BtbN FFmpeg-Builds project:

- Version string: `ffmpeg version n8.1.3-20260923` (FFmpeg 8.1.3; `20260923` is the distributor's `--extra-version` build date).
- Upstream FFmpeg source: Git tag `n8.1.3`, commit `1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7` (tag object `23151b11c75aa44d9ab8db796a53c76acf00f6c0`), repository https://git.ffmpeg.org/ffmpeg.git (mirror https://github.com/FFmpeg/FFmpeg/tree/n8.1.3 ). Release tarball: https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz . Project: https://ffmpeg.org/
- Binary distributor and build scripts: https://github.com/BtbN/FFmpeg-Builds , release `autobuild-2026-09-23-14-55`, archive `ffmpeg-n8.1.3-win64-gpl-8.1.zip` (SHA-256 `fde13c8cf7c1b0a54bf661105652970810d94d140d867dd990fce4885a9f5d20`, 191928812 bytes). The distributor prunes old autobuild releases; that release page is no longer listed. The last FFmpeg-Builds `master` commit before the release time is `ccbffa4f85d0e8de5c135c69ebb10e4c14911fa9`; its `scripts.d/` directory pins the source repository and revision of every statically linked library. This commit is inferred from the release timestamp and is not taken from the release record.
- `ffmpeg.exe` SHA-256 `b826bced7badfa264116ba0640251410bcd0671c49d72bf66130673c11bb0ccc` (162889216 bytes); `ffprobe.exe` SHA-256 `14ad2163fbbad8694465849dfd618d36707a15028b5676afa31cd87828b201f3` (162683904 bytes).
- Compiler: gcc 16.2.0 (crosstool-NG 1.29.0.7_b1a94f6), cross-compiled for x86_64-w64-mingw32.
- License: these binaries are built with `--enable-gpl --enable-version3`, so the combined work is licensed under the GNU General Public License, version 3 or later. The full license text is installed as `runtime/FFMPEG-LICENSE.txt` (SHA-256 `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`). They include GPL components such as x264, x265, xvid, libvidstab, frei0r and rubberband, plus LGPL and permissively licensed libraries; each library keeps its own copyright and license.
- Earlier Editkin internal builds used the gyan.dev FFmpeg 8.0 full build (SHA-256 `81b5832f6c548d64feba0ec7d643397e2351d9f3460a65c6c296956045eebaea`, https://www.gyan.dev/ffmpeg/builds/ , https://github.com/GyanD/codexffmpeg/releases/tag/8.0 , FFmpeg commit `140fd653aed8cad774f991ba083e2d01e86420c7`). That build is not in this installer.

Configure flags reported by both executables (`ffmpeg -version`):

```text
--prefix=/ffbuild/prefix --pkg-config-flags=--static --pkg-config=pkg-config --cross-prefix=x86_64-w64-mingw32- --arch=x86_64 --target-os=mingw32 --enable-gpl --enable-version3 --disable-debug --disable-w32threads --enable-pthreads --enable-iconv --enable-zlib --enable-libxml2 --enable-libvmaf --enable-fontconfig --enable-libharfbuzz --enable-libfreetype --enable-libfribidi --enable-vulkan --enable-libshaderc --enable-libdav1d --enable-libvorbis --enable-librav1e --enable-librsvg --disable-libxcb --disable-xlib --disable-libpulse --enable-gmp --enable-lzma --enable-liblcevc-dec --enable-opencl --enable-amf --enable-libaom --enable-avisynth --enable-chromaprint --enable-libdavs2 --enable-libdvdread --enable-libdvdnav --disable-libfdk-aac --enable-ffnvcodec --enable-cuda-llvm --enable-frei0r --enable-libgme --enable-libkvazaar --enable-libaribb24 --enable-libaribcaption --enable-libass --enable-libbluray --enable-libjxl --enable-libmp3lame --enable-libopus --enable-libplacebo --enable-librist --enable-libssh --enable-libtheora --enable-libvpx --enable-libwebp --enable-libzmq --enable-lv2 --enable-libvpl --enable-openal --enable-liboapv --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopenmpt --enable-librubberband --enable-schannel --enable-sdl2 --enable-libsnappy --enable-libsoxr --enable-libsrt --enable-libsvtav1 --enable-libtwolame --enable-libuavs3d --disable-libdrm --enable-vaapi --enable-libvidstab --enable-libvvenc --disable-whisper --enable-libx264 --enable-libx265 --enable-libxavs2 --enable-libxvid --enable-libzimg --enable-libzvbi --extra-cflags=-DLIBTWOLAME_STATIC --extra-cxxflags= --extra-libs=-lgomp --extra-ldflags=-pthread --extra-ldexeflags= --cc=x86_64-w64-mingw32-gcc --cxx=x86_64-w64-mingw32-g++ --ar=x86_64-w64-mingw32-gcc-ar --ranlib=x86_64-w64-mingw32-gcc-ranlib --nm=x86_64-w64-mingw32-gcc-nm --extra-version=20260923
```

### Written offer for source code (GNU GPL version 3, section 6(b))

Hao0321 Studio distributes this Editkin installer. For at least three years after we last distribute this installer version, we offer to give anyone who possesses the object code in it the complete Corresponding Source for the GPL-licensed software it contains. This covers FFmpeg/ffprobe n8.1.3 (the FFmpeg source above, the FFmpeg-Builds scripts, and the source of every statically linked library at the revisions used) and the Editkin program in this installer. On request, we provide the source by access to copy it from a network server at no charge, or on a durable physical medium customarily used for software interchange for no more than our reasonable cost of physically performing that conveyance.

Send requests to: lo246179268@gmail.com

Please name the installer file and its SHA-256. The current contact address is also published with the Editkin releases at https://github.com/Hao0321/Editkin/releases . This offer does not limit any right you have under the GPL; you may also obtain the FFmpeg source directly from the upstream links above.

## Whisper model

Automatic Captions lazily downloads `ggerganov/whisper.cpp` model `ggml-small-q5_1.bin` from the official Hugging Face repository. The application pins size `190085487` and SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` before installation. OpenAI Whisper code and model weights, and whisper.cpp, are distributed under the MIT license. The model is not embedded in the installer; the verified receipt records the upstream URL, license, size and hash in app data.

The Windows bilingual-caption path also bundles the official whisper.cpp v1.8.6 CPU x64 command runtime. `vendor/whisper/win32-x64/manifest.json` pins the official release archive at SHA-256 `b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822` and records every staged executable／DLL hash. `WHISPER-LICENSE.txt` is staged beside the runtime. This second pass performs the upstream model's supported source-language-to-English translation locally; it is not represented as arbitrary-language translation.

## ONNX Runtime Auto Roto adapter

The source tree stages the official Microsoft ONNX Runtime 1.28.0 Windows x64 runtime for the Auto Roto adapter. `vendor/onnxruntime/win32-x64/SOURCE.json` pins the official archive, archive SHA-256 and every runtime／version／license identity; the upstream MIT license and third-party notices remain beside the DLL. `hao-core` uses the locked Rust `ort` 2.0.0-rc.13 wrapper with dynamic loading so the runtime and model are independently verified before execution.

The staged 103-byte sigmoid ONNX model is an integration fixture distributed with ONNX Runtime's Python package. Its source and SHA-256 are recorded under `vendor/auto-roto-models/onnx-logit-calibrator-fixture/`. Product mode rejects this fixture. It is not a semantic segmentation model, a third-party model-weight grant, or evidence of Roto quality; a production model requires its own weights license, provenance, packaging and natural-footage acceptance gate.

## Bundled open fonts

The community installer bundles five fonts from the Google Fonts repository at commit `ec626514f79f831f1ab848a82114a0ce7e2d6372`: Noto Sans TC, Noto Serif TC, LXGW WenKai Mono TC, Bebas Neue and Fredoka. Each is licensed under SIL Open Font License 1.1. `public/fonts/editkin-open-fonts.json` pins the exact source URL, byte count and SHA-256 for every font; the corresponding per-font OFL text is packaged beside it. The release lifecycle gate compares this closed-world source directory byte-for-byte with `font-packs/editkin-open-fonts` extracted from the installer, and the export integration verifies that libass selects the bundled font instead of silently falling back to a system font.

## Chinese caption script conversion (opencc-js／OpenCC)

Automatic Captions convert Simplified Mandarin cue text to Taiwan Traditional (OpenCC `s2twp`) with the npm package `opencc-js` 1.4.2 (https://github.com/nk2028/opencc-js). It is pinned exactly in `package.json` and locked in `package-lock.json` (declared license `MIT AND Apache-2.0`, no dependencies). Its code and dictionary data are inlined into the application service, MCP and Electron fallback JavaScript bundles (`desktop-dist/service.mjs`, `desktop-dist/mcp.mjs`, `desktop-dist/main.mjs`). Those bundles strip legal comments, so this file carries both license texts.

- `opencc-js` code: MIT License, Copyright (c) 2020-2021 The nk2028 Project.
- Dictionary data: generated by `opencc-js` from `opencc-data` (https://github.com/nk2028/opencc-data), the dictionaries of OpenCC (Open Chinese Convert, https://github.com/BYVoid/OpenCC), redistributed under the Apache License, Version 2.0. `opencc-js` 1.4.2 ships no NOTICE file.

The raw recognizer transcript is kept unchanged beside the converted cues. The license texts copied from the installed package (`LICENSE` and `LICENSES/Apache-2.0.txt`) are reproduced at the end of this file.

## Rust and JavaScript dependencies

`hao-core` depends on `serde` and `serde_json`; Tauri adds its locked Rust dependency tree. JavaScript runtime and build dependencies are locked in `package-lock.json`. Every release build creates `release/editkin.spdx.json`, a deterministic SPDX 2.3 inventory derived from both Cargo graphs, `package-lock.json` and bundled runtime identities; the inventory and this notice are embedded in the installer and checked against its extracted payload. It is an engineering dependency/license inventory, not a substitute for retaining required license texts, corresponding source or legal review.

The Tauri package includes the official Node.js 22.23.2 runtime as an on-demand application-service, MCP and Remote runtime. The Windows x64 receipt pins the official archive SHA-256 `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`, `node.exe` SHA-256 `0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4` and `NODE-LICENSE.txt` SHA-256 `8cc9bb466b19fc7e7cc99d03e9df1132021fda8b01eea2624c58bb372dbef576` in `vendor/node/win32-x64/manifest.json`; macOS arm64／x64 archives are checked against pinned official SHA-256 values by `scripts/stage-platform-runtime.mjs`. Release builds separately require Node.js >= 22.12, so a valid bundled runtime cannot conceal an unsupported build interpreter. Node does not stay resident when the editor is idle.

macOS packages stage the host-native binaries supplied by the locked `ffmpeg-static` and `ffprobe-static` npm packages. Their binary hashes are written to `.platform-runtime/manifest.json`, and their bundled license files are copied into the app resources. Those artifacts require the same exact-source／license review before public release.

## No release approval implied

This file records current engineering inputs; it is not legal advice and does not mark an artifact public-release-ready. Code signing, exact source retention, complete license aggregation, SBOM generation and release owner／legal approval remain explicit release gates.

## License texts for bundled JavaScript

### opencc-js — MIT License

```text
MIT License

Copyright (c) 2020-2021 The nk2028 Project

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### OpenCC dictionary data (opencc-data via opencc-js) — Apache License, Version 2.0

```text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

   1. You must give any other recipients of the Work or Derivative Works a copy of this License; and

   2. You must cause any modified files to carry prominent notices stating that You changed the files; and

   3. You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

   4. If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```
