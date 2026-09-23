#ifndef EDITKIN_EFFECT_PLUGIN_V1_H
#define EDITKIN_EFFECT_PLUGIN_V1_H

#include <stddef.h>
#include <stdint.h>

#define EDITKIN_EFFECT_ABI_VERSION 1u
#define EDITKIN_EFFECT_ENTRY_SYMBOL "editkin_effect_plugin_v1"

/* Buffers contain premultiplied, scene-linear RGBA32F pixels. The host owns all
   memory; a plugin must not retain pointers after the call returns. */
typedef struct EditkinEffectProcessV1 {
  uint32_t abi_version;
  uint32_t width;
  uint32_t height;
  const float *input_rgba32f;
  float *output_rgba32f;
  size_t pixel_count;
  size_t parameter_count;
  const double *parameters;
} EditkinEffectProcessV1;

#if defined(_WIN32)
#define EDITKIN_EFFECT_EXPORT __declspec(dllexport)
#else
#define EDITKIN_EFFECT_EXPORT __attribute__((visibility("default")))
#endif

EDITKIN_EFFECT_EXPORT int32_t editkin_effect_plugin_v1(const EditkinEffectProcessV1 *request);

#endif
