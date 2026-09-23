#ifndef EDITKIN_SOFTWARE_VIDEO_BRIDGE_H
#define EDITKIN_SOFTWARE_VIDEO_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define EDITKIN_SOFTWARE_VIDEO_ABI_VERSION 1u

typedef struct EditkinSoftwareRuntimeProbe {
    uint32_t abi_version;
    uint32_t avutil_version;
    uint32_t avcodec_version;
    uint32_t avformat_version;
    char license[96];
    char configuration[4096];
    char error_code[64];
    char error_message[512];
} EditkinSoftwareRuntimeProbe;

typedef struct EditkinSoftwareFrame {
    uint32_t abi_version;
    uint32_t width;
    uint32_t height;
    uint32_t frame_rate_numerator;
    uint32_t frame_rate_denominator;
    int32_t codec_id;
    int32_t pixel_format;
    int32_t color_range;
    int32_t color_space;
    int32_t color_primaries;
    int32_t color_transfer;
    int32_t interlaced;
    int32_t key_frame;
    int64_t pts_100ns;
    int64_t duration_100ns;
    int64_t target_100ns;
    int64_t tolerance_100ns;
    uint64_t packets_read;
    uint64_t frames_decoded;
    uint64_t data_size;
    uint64_t y_offset;
    uint64_t u_offset;
    uint64_t v_offset;
    uint32_t y_stride_bytes;
    uint32_t u_stride_bytes;
    uint32_t v_stride_bytes;
    uint8_t *data;
    char codec_name[16];
    char pixel_format_name[32];
    char error_code[64];
    char error_message[512];
} EditkinSoftwareFrame;

int editkin_software_runtime_probe(
    const wchar_t *runtime_root,
    uint32_t timeout_milliseconds,
    EditkinSoftwareRuntimeProbe *out_probe);

int editkin_software_decode_frame(
    const wchar_t *runtime_root,
    const wchar_t *input_path,
    int64_t target_100ns,
    int64_t tolerance_100ns,
    uint32_t timeout_milliseconds,
    EditkinSoftwareFrame *out_frame);

void editkin_software_frame_free(EditkinSoftwareFrame *frame);

#ifdef __cplusplus
}
#endif

#endif
