#ifndef EDITKIN_EFFECT_PLUGIN_V2_H
#define EDITKIN_EFFECT_PLUGIN_V2_H

#include <stddef.h>
#include <stdint.h>

#define EDITKIN_EFFECT_ABI_VERSION_V2 2u
#define EDITKIN_EFFECT_ENTRY_SYMBOL_V2 "editkin_effect_plugin_v2"

/* Buffers contain premultiplied, scene-linear RGBA32F pixels. The host owns all
   memory. struct_size allows future hosts to append fields without silently
   changing this ABI. time_numerator/time_denominator is exact project time. */
typedef struct EditkinEffectProcessV2 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t width;
  uint32_t height;
  const float *input_rgba32f;
  float *output_rgba32f;
  size_t pixel_count;
  size_t parameter_count;
  const double *parameters;
  int64_t frame_index;
  int64_t time_numerator;
  int64_t time_denominator;
  uint32_t flags;
  uint32_t reserved;
} EditkinEffectProcessV2;

#if defined(_WIN32)
#define EDITKIN_EFFECT_EXPORT __declspec(dllexport)
#else
#define EDITKIN_EFFECT_EXPORT __attribute__((visibility("default")))
#endif

EDITKIN_EFFECT_EXPORT int32_t editkin_effect_plugin_v2(const EditkinEffectProcessV2 *request);

#endif
