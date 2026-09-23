# Editkin

[繁體中文說明](README.zh-TW.md)

Editkin is a local-first video editor with an editable timeline, a shared EditGraph, and structured commands for AI tools. This repository is the community source edition. It includes neutral default presets and synthetic demo footage. It does not contain the maintainer's private creative packs, music, personal Skills, model weights, signing credentials, or prebuilt media runtimes.

## Automatic editing with Video Autopilot Kit

[Video Autopilot Kit](https://github.com/Hao0321/video-autopilot-kit) supplies the agent-side editing rules and public design references. Codex, Claude Code, or another MCP-compatible agent reads that Kit, inspects the source material, and uses Editkin's local MCP tools to prepare, audit, apply, and render an editable v4 plan. Editkin supplies the editing engine; the agent makes the editorial decisions.

For integration development, install or clone the Kit and set `EDITKIN_VIDEO_AUTOPILOT_SKILL` to the absolute path of its `codex-skill/video-autopilot/SKILL.md` before starting Editkin with `npm run mcp` in your agent's MCP configuration. Use the same Kit in the agent session. Editkin binds the selected Skill and its workflow contract to the plan and checks for changes again before applying it. The public Kit works without the maintainer's private design profile; real footage and visual quality still need review.

## Build the source

Use Node.js 22.13 or newer. From a fresh checkout:

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm run dev` opens the web UI at `http://127.0.0.1:5173`. The UI and core TypeScript can be built without private files. Native desktop builds also need Rust stable and platform-specific media runtimes. This source snapshot does not include a cleared, signed installer. See [BUILDING.md](docs/BUILDING.md) before claiming a desktop release.

The bundled demo videos are generated color bars with silent audio. You can use your own lawfully redistributable media when testing edits. Some advanced rendering, fonts, color transforms, captions, and native model features require separately obtained dependencies; a web build alone does not prove those paths.

## Contribute

Start with the [public issue tracker](https://github.com/Hao0321/Editkin/issues), including tasks labeled `good first issue` or `help wanted`.

Read [CONTRIBUTING.md](CONTRIBUTING.md), [COMMUNITY.md](docs/COMMUNITY.md), [SECURITY.md](SECURITY.md), and [TRADEMARKS.md](TRADEMARKS.md). Code and community default data are offered under [GPL-3.0-or-later](LICENSE). The font files carry their own SIL OFL 1.1 notices; the ACES config carries its upstream license. Official Editkin branding and release signing remain controlled by the maintainer.

Sponsorship may support ongoing development. Contributions are accepted under the existing open-source license with a Developer Certificate of Origin sign-off; contributors keep their copyright. No copyright assignment or separate proprietary relicensing grant is requested.

## Release status

This repository is for source collaboration. Official downloads will be announced separately after the exact binaries pass licensing, signing, provenance, and platform checks. Do not treat a pull-request artifact or a locally built binary as an official Editkin release.
