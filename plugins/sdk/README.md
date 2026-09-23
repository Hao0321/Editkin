# Editkin GPU Effect Module SDK v1

`gpu_effect_module` is the public, data-only authoring boundary for single-frame color effects.
Authors describe a one-way node graph; Editkin validates it, resolves parameters, compiles it to
`editkin.gpu-effect-graph/v1` bytecode and hashes the exact runtime program before Rust validates it
again. The authoring graph never injects WGSL, native code, files, network access or GPU resources.

## Limits

- one `$source`, one declared `output`, and 1–4 connected unary nodes;
- no loops, recursion, branches, orphan nodes or temporal neighbours;
- numeric and boolean parameters only at execution time;
- up to four effect programs / 16 compiled instructions on one visual;
- supported ops: `gain`, `invert`, `grayscale`, `saturation`, `contrast`, `tint`, `posterize`,
  `vignette`, `hue_rotate`, `lift_gamma_gain`, `filmic_curve`, `temperature_tint`;
- third-party programs remain manifest-version and SHA-256 pinned and cannot mix with CPU effects.

Use the template in `templates/gpu-color-module`, then run:

```powershell
npm run plugin:validate -- path\to\editkin-plugin.json
```

The validator prints the manifest identity, automation readiness, compiled opcode order and
program SHA-256. A module is accepted only when every default parameter compiles successfully.

This is not AE/OFX or arbitrary WGSL compatibility. Spatial kernels, temporal neighbours,
scene-linear HDR composition and isolated arbitrary shader binaries remain separate engine work.
