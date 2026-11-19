/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * scenegrade exr-wasm: a thin C wrapper over the OpenEXRCore API, compiled
 * to WebAssembly with Emscripten.
 *
 * Exposed API (all functions are prefixed with `exrw_`):
 *
 *   exrw_open(data, size)        -> handle | NULL   (file bytes live in wasm memory)
 *   exrw_header_json(h)          -> const char*     (UTF-8 JSON, owned by handle)
 *   exrw_decode(h, part, r, g, b, a, out_float) -> 0 | exr_result_t error code
 *   exrw_result_ptr(h) / exrw_result_size(h) / exrw_result_failed_chunks(h)
 *   exrw_free_result(h)
 *   exrw_close(h)
 *   exrw_last_error()            -> const char*
 *
 * The decode output is an interleaved RGBA buffer (half or float32)
 * covering the part's data window, row 0 = data window yMin.
 */

#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "openexr.h"

#define EXPORT EMSCRIPTEN_KEEPALIVE

/* ------------------------------------------------------------------------ */
/* Error reporting                                                           */
/* ------------------------------------------------------------------------ */

static char g_last_error[1024];

static void set_error (const char* fmt, ...)
{
    va_list ap;
    va_start (ap, fmt);
    vsnprintf (g_last_error, sizeof (g_last_error), fmt, ap);
    va_end (ap);
}

static void
error_handler (exr_const_context_t ctxt, exr_result_t code, const char* msg)
{
    (void) ctxt;
    set_error ("%s: %s", exr_get_error_code_as_string (code), msg ? msg : "");
}

EXPORT const char* exrw_last_error (void) { return g_last_error; }

/* ------------------------------------------------------------------------ */
/* Memory stream                                                             */
/* ------------------------------------------------------------------------ */

typedef struct
{
    const uint8_t* data;
    uint64_t       size;
    exr_context_t  ctxt;
    char*          header_json;
    uint8_t*       result;
    size_t         result_size;
    int            failed_chunks;
} exrw_handle;

static int64_t mem_read (
    exr_const_context_t         ctxt,
    void*                       userdata,
    void*                       buffer,
    uint64_t                    sz,
    uint64_t                    offset,
    exr_stream_error_func_ptr_t error_cb)
{
    exrw_handle* h = (exrw_handle*) userdata;
    (void) ctxt;
    (void) error_cb;
    if (offset >= h->size) return 0;
    uint64_t n = h->size - offset;
    if (n > sz) n = sz;
    memcpy (buffer, h->data + offset, (size_t) n);
    return (int64_t) n;
}

static int64_t mem_size (exr_const_context_t ctxt, void* userdata)
{
    (void) ctxt;
    return (int64_t) ((exrw_handle*) userdata)->size;
}

EXPORT exrw_handle* exrw_open (const uint8_t* data, uint32_t size)
{
    g_last_error[0] = '\0';
    exrw_handle* h  = (exrw_handle*) calloc (1, sizeof (exrw_handle));
    if (!h)
    {
        set_error ("out of memory");
        return NULL;
    }
    h->data = data;
    h->size = size;

    exr_context_initializer_t init = EXR_DEFAULT_CONTEXT_INITIALIZER;
    init.error_handler_fn          = &error_handler;
    init.user_data                 = h;
    init.read_fn                   = &mem_read;
    init.size_fn                   = &mem_size;
    /* allow big plates; the defaults are generous already */
    init.max_image_width  = 0;
    init.max_image_height = 0;

    exr_result_t rv = exr_start_read (&h->ctxt, "memory", &init);
    if (rv != EXR_ERR_SUCCESS)
    {
        if (!g_last_error[0])
            set_error ("exr_start_read failed: %s", exr_get_error_code_as_string (rv));
        if (h->ctxt) exr_finish (&h->ctxt);
        free (h);
        return NULL;
    }
    return h;
}

EXPORT void exrw_free_result (exrw_handle* h)
{
    if (!h) return;
    free (h->result);
    h->result      = NULL;
    h->result_size = 0;
}

EXPORT void exrw_close (exrw_handle* h)
{
    if (!h) return;
    exrw_free_result (h);
    free (h->header_json);
    if (h->ctxt) exr_finish (&h->ctxt);
    free (h);
}

EXPORT uint8_t* exrw_result_ptr (exrw_handle* h) { return h ? h->result : NULL; }
EXPORT uint32_t exrw_result_size (exrw_handle* h)
{
    return h ? (uint32_t) h->result_size : 0;
}
EXPORT int exrw_result_failed_chunks (exrw_handle* h)
{
    return h ? h->failed_chunks : 0;
}

/* ------------------------------------------------------------------------ */
/* Tiny JSON string builder                                                  */
/* ------------------------------------------------------------------------ */

typedef struct
{
    char*  buf;
    size_t len;
    size_t cap;
    int    oom;
} sb_t;

static void sb_reserve (sb_t* sb, size_t extra)
{
    if (sb->oom) return;
    if (sb->len + extra + 1 <= sb->cap) return;
    size_t ncap = sb->cap ? sb->cap * 2 : 4096;
    while (ncap < sb->len + extra + 1)
        ncap *= 2;
    char* nb = (char*) realloc (sb->buf, ncap);
    if (!nb)
    {
        sb->oom = 1;
        return;
    }
    sb->buf = nb;
    sb->cap = ncap;
}

static void sb_putn (sb_t* sb, const char* s, size_t n)
{
    sb_reserve (sb, n);
    if (sb->oom) return;
    memcpy (sb->buf + sb->len, s, n);
    sb->len += n;
    sb->buf[sb->len] = '\0';
}

static void sb_puts (sb_t* sb, const char* s) { sb_putn (sb, s, strlen (s)); }

static void sb_printf (sb_t* sb, const char* fmt, ...)
{
    char    tmp[256];
    va_list ap;
    va_start (ap, fmt);
    int n = vsnprintf (tmp, sizeof (tmp), fmt, ap);
    va_end (ap);
    if (n < 0) return;
    if ((size_t) n < sizeof (tmp))
    {
        sb_putn (sb, tmp, (size_t) n);
        return;
    }
    sb_reserve (sb, (size_t) n);
    if (sb->oom) return;
    va_start (ap, fmt);
    vsnprintf (sb->buf + sb->len, (size_t) n + 1, fmt, ap);
    va_end (ap);
    sb->len += (size_t) n;
}

/* JSON string with escaping, `n` < 0 means NUL terminated. */
static void sb_str (sb_t* sb, const char* s, int n)
{
    if (!s)
    {
        sb_puts (sb, "null");
        return;
    }
    size_t len = n < 0 ? strlen (s) : (size_t) n;
    sb_putn (sb, "\"", 1);
    for (size_t i = 0; i < len; ++i)
    {
        unsigned char c = (unsigned char) s[i];
        switch (c)
        {
            case '"': sb_putn (sb, "\\\"", 2); break;
            case '\\': sb_putn (sb, "\\\\", 2); break;
            case '\n': sb_putn (sb, "\\n", 2); break;
            case '\r': sb_putn (sb, "\\r", 2); break;
            case '\t': sb_putn (sb, "\\t", 2); break;
            default:
                if (c < 0x20)
                    sb_printf (sb, "\\u%04x", (unsigned) c);
                else
                    sb_putn (sb, (const char*) &c, 1);
        }
    }
    sb_putn (sb, "\"", 1);
}

/* float32 value: shortest decimal that round-trips to the same float */
static void sb_num (sb_t* sb, double v)
{
    if (isnan (v) || isinf (v))
    {
        sb_puts (sb, "null");
        return;
    }
    float f = (float) v;
    char  tmp[48];
    for (int prec = 6; prec <= 9; ++prec)
    {
        snprintf (tmp, sizeof (tmp), "%.*g", prec, (double) f);
        if ((float) strtod (tmp, NULL) == f) break;
    }
    sb_puts (sb, tmp);
}

static void sb_numd (sb_t* sb, double v)
{
    if (isnan (v) || isinf (v))
        sb_puts (sb, "null");
    else
        sb_printf (sb, "%.17g", v);
}

static void sb_farr (sb_t* sb, const float* v, int n)
{
    sb_putn (sb, "[", 1);
    for (int i = 0; i < n; ++i)
    {
        if (i) sb_putn (sb, ",", 1);
        sb_num (sb, v[i]);
    }
    sb_putn (sb, "]", 1);
}

static void sb_darr (sb_t* sb, const double* v, int n)
{
    sb_putn (sb, "[", 1);
    for (int i = 0; i < n; ++i)
    {
        if (i) sb_putn (sb, ",", 1);
        sb_numd (sb, v[i]);
    }
    sb_putn (sb, "]", 1);
}

/* ------------------------------------------------------------------------ */
/* Header -> JSON                                                            */
/* ------------------------------------------------------------------------ */

static const char* compression_name (int c)
{
    switch (c)
    {
        case EXR_COMPRESSION_NONE: return "NONE";
        case EXR_COMPRESSION_RLE: return "RLE";
        case EXR_COMPRESSION_ZIPS: return "ZIPS";
        case EXR_COMPRESSION_ZIP: return "ZIP";
        case EXR_COMPRESSION_PIZ: return "PIZ";
        case EXR_COMPRESSION_PXR24: return "PXR24";
        case EXR_COMPRESSION_B44: return "B44";
        case EXR_COMPRESSION_B44A: return "B44A";
        case EXR_COMPRESSION_DWAA: return "DWAA";
        case EXR_COMPRESSION_DWAB: return "DWAB";
        case EXR_COMPRESSION_HTJ2K256: return "HTJ2K256";
        case EXR_COMPRESSION_HTJ2K32: return "HTJ2K32";
        default: return "UNKNOWN";
    }
}

static const char* pixel_type_name (int t)
{
    switch (t)
    {
        case EXR_PIXEL_UINT: return "uint";
        case EXR_PIXEL_HALF: return "half";
        case EXR_PIXEL_FLOAT: return "float";
        default: return "unknown";
    }
}

static const char* lineorder_name (int l)
{
    switch (l)
    {
        case EXR_LINEORDER_INCREASING_Y: return "INCREASING_Y";
        case EXR_LINEORDER_DECREASING_Y: return "DECREASING_Y";
        case EXR_LINEORDER_RANDOM_Y: return "RANDOM_Y";
        default: return "UNKNOWN";
    }
}

static const char* level_mode_name (int l)
{
    switch (l)
    {
        case EXR_TILE_ONE_LEVEL: return "ONE_LEVEL";
        case EXR_TILE_MIPMAP_LEVELS: return "MIPMAP_LEVELS";
        case EXR_TILE_RIPMAP_LEVELS: return "RIPMAP_LEVELS";
        default: return "UNKNOWN";
    }
}

static void sb_timecode (sb_t* sb, const exr_attr_timecode_t* tc)
{
    uint32_t t  = tc->time_and_flags;
    int      fr = (int) ((t & 0x0f) + ((t >> 4) & 0x03) * 10);
    int      df = (int) ((t >> 6) & 1);
    int      ss = (int) (((t >> 8) & 0x0f) + ((t >> 12) & 0x07) * 10);
    int      mm = (int) (((t >> 16) & 0x0f) + ((t >> 20) & 0x07) * 10);
    int      hh = (int) (((t >> 24) & 0x0f) + ((t >> 28) & 0x03) * 10);
    char     tmp[32];
    snprintf (tmp, sizeof (tmp), "%02d:%02d:%02d%c%02d", hh, mm, ss, df ? ';' : ':', fr);
    sb_str (sb, tmp, -1);
}

/* Writes the value of one attribute as JSON. */
static void sb_attr_value (sb_t* sb, const exr_attribute_t* a)
{
    char tmp[256];
    switch (a->type)
    {
        case EXR_ATTR_INT: sb_printf (sb, "%d", a->i); break;
        case EXR_ATTR_FLOAT: sb_num (sb, a->f); break;
        case EXR_ATTR_DOUBLE: sb_numd (sb, a->d); break;
        case EXR_ATTR_STRING:
            sb_str (sb, a->string->str, a->string->length);
            break;
        case EXR_ATTR_STRING_VECTOR: {
            /* exotic: a JSON-encoded array inside a string */
            sb_t inner = {0};
            sb_putn (&inner, "[", 1);
            for (int i = 0; i < a->stringvector->n_strings; ++i)
            {
                if (i) sb_putn (&inner, ",", 1);
                sb_str (
                    &inner,
                    a->stringvector->strings[i].str,
                    a->stringvector->strings[i].length);
            }
            sb_putn (&inner, "]", 1);
            sb_str (sb, inner.buf ? inner.buf : "[]", -1);
            free (inner.buf);
            break;
        }
        case EXR_ATTR_FLOAT_VECTOR:
            sb_farr (sb, a->floatvector->arr, a->floatvector->length);
            break;
        case EXR_ATTR_BOX2I:
            sb_printf (
                sb,
                "[%d,%d,%d,%d]",
                a->box2i->min.x,
                a->box2i->min.y,
                a->box2i->max.x,
                a->box2i->max.y);
            break;
        case EXR_ATTR_BOX2F: {
            float v[4] = {
                a->box2f->min.x, a->box2f->min.y, a->box2f->max.x, a->box2f->max.y};
            sb_farr (sb, v, 4);
            break;
        }
        case EXR_ATTR_V2I: sb_printf (sb, "[%d,%d]", a->v2i->x, a->v2i->y); break;
        case EXR_ATTR_V2F: {
            float v[2] = {a->v2f->x, a->v2f->y};
            sb_farr (sb, v, 2);
            break;
        }
        case EXR_ATTR_V2D: {
            double v[2] = {a->v2d->x, a->v2d->y};
            sb_darr (sb, v, 2);
            break;
        }
        case EXR_ATTR_V3I:
            sb_printf (sb, "[%d,%d,%d]", a->v3i->x, a->v3i->y, a->v3i->z);
            break;
        case EXR_ATTR_V3F: {
            float v[3] = {a->v3f->x, a->v3f->y, a->v3f->z};
            sb_farr (sb, v, 3);
            break;
        }
        case EXR_ATTR_V3D: {
            double v[3] = {a->v3d->x, a->v3d->y, a->v3d->z};
            sb_darr (sb, v, 3);
            break;
        }
        case EXR_ATTR_M33F: sb_farr (sb, a->m33f->m, 9); break;
        case EXR_ATTR_M33D: sb_darr (sb, a->m33d->m, 9); break;
        case EXR_ATTR_M44F: sb_farr (sb, a->m44f->m, 16); break;
        case EXR_ATTR_M44D: sb_darr (sb, a->m44d->m, 16); break;
        case EXR_ATTR_CHROMATICITIES: {
            const exr_attr_chromaticities_t* c = a->chromaticities;
            float v[8] = {
                c->red_x,
                c->red_y,
                c->green_x,
                c->green_y,
                c->blue_x,
                c->blue_y,
                c->white_x,
                c->white_y};
            sb_farr (sb, v, 8);
            break;
        }
        case EXR_ATTR_RATIONAL:
            sb_printf (sb, "[%d,%u]", a->rational->num, a->rational->denom);
            break;
        case EXR_ATTR_COMPRESSION:
            sb_str (sb, compression_name (a->uc), -1);
            break;
        case EXR_ATTR_LINEORDER: sb_str (sb, lineorder_name (a->uc), -1); break;
        case EXR_ATTR_ENVMAP:
            sb_str (
                sb,
                a->uc == EXR_ENVMAP_LATLONG ? "LATLONG"
                : a->uc == EXR_ENVMAP_CUBE  ? "CUBE"
                                            : "UNKNOWN",
                -1);
            break;
        case EXR_ATTR_DEEP_IMAGE_STATE: {
            static const char* names[] = {
                "MESSY", "SORTED", "NON_OVERLAPPING", "TIDY"};
            sb_str (sb, a->uc < 4 ? names[a->uc] : "UNKNOWN", -1);
            break;
        }
        case EXR_ATTR_TILEDESC:
            snprintf (
                tmp,
                sizeof (tmp),
                "%ux%u %s %s",
                a->tiledesc->x_size,
                a->tiledesc->y_size,
                level_mode_name (EXR_GET_TILE_LEVEL_MODE (*a->tiledesc)),
                EXR_GET_TILE_ROUND_MODE (*a->tiledesc) == EXR_TILE_ROUND_UP
                    ? "ROUND_UP"
                    : "ROUND_DOWN");
            sb_str (sb, tmp, -1);
            break;
        case EXR_ATTR_TIMECODE: sb_timecode (sb, a->timecode); break;
        case EXR_ATTR_KEYCODE:
            snprintf (
                tmp,
                sizeof (tmp),
                "mfc %d type %d prefix %d count %d perfOffset %d perfsPerFrame %d perfsPerCount %d",
                a->keycode->film_mfc_code,
                a->keycode->film_type,
                a->keycode->prefix,
                a->keycode->count,
                a->keycode->perf_offset,
                a->keycode->perfs_per_frame,
                a->keycode->perfs_per_count);
            sb_str (sb, tmp, -1);
            break;
        case EXR_ATTR_CHLIST: {
            sb_t inner = {0};
            for (int i = 0; i < a->chlist->num_channels; ++i)
            {
                const exr_attr_chlist_entry_t* e = a->chlist->entries + i;
                if (i) sb_puts (&inner, ", ");
                sb_putn (&inner, e->name.str, (size_t) e->name.length);
                sb_printf (&inner, " (%s", pixel_type_name (e->pixel_type));
                if (e->x_sampling != 1 || e->y_sampling != 1)
                    sb_printf (&inner, " %dx%d", e->x_sampling, e->y_sampling);
                sb_puts (&inner, ")");
            }
            sb_str (sb, inner.buf ? inner.buf : "", -1);
            free (inner.buf);
            break;
        }
        case EXR_ATTR_PREVIEW:
            snprintf (
                tmp,
                sizeof (tmp),
                "preview %ux%u",
                a->preview->width,
                a->preview->height);
            sb_str (sb, tmp, -1);
            break;
        case EXR_ATTR_BYTES:
            snprintf (tmp, sizeof (tmp), "<bytes, %zu bytes>", a->bytes->size);
            sb_str (sb, tmp, -1);
            break;
        case EXR_ATTR_OPAQUE:
        default:
            snprintf (
                tmp,
                sizeof (tmp),
                "<%s, %d bytes>",
                a->type_name ? a->type_name : "unknown",
                a->opaque ? a->opaque->size : 0);
            sb_str (sb, tmp, -1);
            break;
    }
}

static void sb_box (sb_t* sb, const exr_attr_box2i_t* b)
{
    sb_printf (
        sb,
        "{\"xMin\":%d,\"yMin\":%d,\"xMax\":%d,\"yMax\":%d}",
        b->min.x,
        b->min.y,
        b->max.x,
        b->max.y);
}

static int write_part_json (sb_t* sb, exr_context_t ctxt, int p)
{
    exr_result_t      rv;
    exr_storage_t     storage = EXR_STORAGE_SCANLINE;
    exr_compression_t comp    = EXR_COMPRESSION_NONE;
    exr_attr_box2i_t  dw = {{0, 0}, {-1, -1}}, disp = {{0, 0}, {-1, -1}};
    float             par  = 1.f;
    const char*       name = NULL;
    const exr_attr_chlist_t* chans = NULL;

    exr_get_storage (ctxt, p, &storage);
    exr_get_compression (ctxt, p, &comp);
    exr_get_data_window (ctxt, p, &dw);
    exr_get_display_window (ctxt, p, &disp);
    exr_get_pixel_aspect_ratio (ctxt, p, &par);
    if (exr_get_name (ctxt, p, &name) != EXR_ERR_SUCCESS) name = NULL;
    rv = exr_get_channels (ctxt, p, &chans);
    if (rv != EXR_ERR_SUCCESS) chans = NULL;

    const char* type = "scanline";
    if (storage == EXR_STORAGE_TILED)
        type = "tiled";
    else if (
        storage == EXR_STORAGE_DEEP_SCANLINE || storage == EXR_STORAGE_DEEP_TILED)
        type = "deep";

    sb_printf (sb, "{\"index\":%d,", p);
    if (name)
    {
        sb_puts (sb, "\"name\":");
        sb_str (sb, name, -1);
        sb_puts (sb, ",");
    }
    sb_printf (sb, "\"type\":\"%s\",", type);
    sb_printf (
        sb,
        "\"storage\":\"%s\",",
        storage == EXR_STORAGE_SCANLINE        ? "scanline"
        : storage == EXR_STORAGE_TILED         ? "tiled"
        : storage == EXR_STORAGE_DEEP_SCANLINE ? "deepscanline"
        : storage == EXR_STORAGE_DEEP_TILED    ? "deeptile"
                                               : "unknown");
    sb_printf (
        sb,
        "\"width\":%lld,\"height\":%lld,",
        (long long) dw.max.x - dw.min.x + 1,
        (long long) dw.max.y - dw.min.y + 1);
    sb_puts (sb, "\"dataWindow\":");
    sb_box (sb, &dw);
    sb_puts (sb, ",\"displayWindow\":");
    sb_box (sb, &disp);
    sb_puts (sb, ",\"pixelAspectRatio\":");
    sb_num (sb, par);
    sb_printf (sb, ",\"compression\":\"%s\"", compression_name (comp));

    if (storage == EXR_STORAGE_TILED || storage == EXR_STORAGE_DEEP_TILED)
    {
        uint32_t              tx = 0, ty = 0;
        exr_tile_level_mode_t lm = EXR_TILE_ONE_LEVEL;
        exr_tile_round_mode_t rm = EXR_TILE_ROUND_DOWN;
        int32_t               lx = 1, ly = 1;
        exr_get_tile_descriptor (ctxt, p, &tx, &ty, &lm, &rm);
        exr_get_tile_levels (ctxt, p, &lx, &ly);
        sb_printf (
            sb,
            ",\"tiles\":{\"xSize\":%u,\"ySize\":%u,\"levelMode\":\"%s\",\"roundingMode\":\"%s\",\"levelsX\":%d,\"levelsY\":%d}",
            tx,
            ty,
            level_mode_name (lm),
            rm == EXR_TILE_ROUND_UP ? "ROUND_UP" : "ROUND_DOWN",
            lx,
            ly);
    }

    sb_puts (sb, ",\"channels\":[");
    if (chans)
    {
        for (int c = 0; c < chans->num_channels; ++c)
        {
            const exr_attr_chlist_entry_t* e = chans->entries + c;
            if (c) sb_puts (sb, ",");
            sb_puts (sb, "{\"name\":");
            sb_str (sb, e->name.str, e->name.length);
            sb_printf (
                sb,
                ",\"type\":\"%s\",\"xSampling\":%d,\"ySampling\":%d,\"pLinear\":%s}",
                pixel_type_name (e->pixel_type),
                e->x_sampling,
                e->y_sampling,
                e->p_linear ? "true" : "false");
        }
    }
    sb_puts (sb, "],\"attributes\":{");

    int32_t count = 0;
    exr_get_attribute_count (ctxt, p, &count);
    for (int32_t i = 0; i < count; ++i)
    {
        const exr_attribute_t* a = NULL;
        if (exr_get_attribute_by_index (
                ctxt, p, EXR_ATTR_LIST_FILE_ORDER, i, &a) != EXR_ERR_SUCCESS ||
            !a)
            continue;
        if (i) sb_puts (sb, ",");
        sb_str (sb, a->name, -1);
        sb_puts (sb, ":");
        sb_attr_value (sb, a);
    }
    sb_puts (sb, "},\"attributeTypes\":{");
    for (int32_t i = 0; i < count; ++i)
    {
        const exr_attribute_t* a = NULL;
        if (exr_get_attribute_by_index (
                ctxt, p, EXR_ATTR_LIST_FILE_ORDER, i, &a) != EXR_ERR_SUCCESS ||
            !a)
            continue;
        if (i) sb_puts (sb, ",");
        sb_str (sb, a->name, -1);
        sb_puts (sb, ":");
        sb_str (sb, a->type_name, -1);
    }
    sb_puts (sb, "}}");
    return 0;
}

EXPORT const char* exrw_header_json (exrw_handle* h)
{
    if (!h) return NULL;
    if (h->header_json) return h->header_json;

    int count = 0;
    if (exr_get_count (h->ctxt, &count) != EXR_ERR_SUCCESS) return NULL;

    sb_t sb = {0};
    sb_puts (&sb, "{\"parts\":[");
    for (int p = 0; p < count; ++p)
    {
        if (p) sb_puts (&sb, ",");
        write_part_json (&sb, h->ctxt, p);
    }
    sb_puts (&sb, "]}");
    if (sb.oom)
    {
        free (sb.buf);
        set_error ("out of memory while building header JSON");
        return NULL;
    }
    h->header_json = sb.buf;
    return h->header_json;
}

/* ------------------------------------------------------------------------ */
/* Decoding                                                                  */
/* ------------------------------------------------------------------------ */

typedef struct
{
    int      chan_index; /* index into the part's channel list, -1 = none */
    int      dup_of;     /* output slot this one copies from, -1 = none */
    int      sampled;    /* channel uses x/y subsampling */
    int      xs, ys;
    int64_t  sw, sh;     /* sampled plane dims */
    uint8_t* plane;      /* temp plane for sampled channels */
} slot_t;

static int find_channel (const exr_attr_chlist_t* chans, const char* name)
{
    if (!name || !name[0]) return -1;
    for (int c = 0; c < chans->num_channels; ++c)
        if (strcmp (chans->entries[c].name.str, name) == 0) return c;
    return -1;
}

static int64_t floor_div (int64_t a, int64_t b)
{
    int64_t q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

/*
 * Points the decoder's channel outputs at the right place in the
 * interleaved output for the given chunk. Chunk origin is in absolute
 * pixel coords (x0, y0).
 */
static void setup_chunk_ptrs (
    exr_decode_pipeline_t* dec,
    slot_t*                slots,
    uint8_t*               out,
    int64_t                W,
    const exr_attr_box2i_t* dw,
    int64_t                x0,
    int64_t                y0,
    int                    bpe,
    int                    out_type)
{
    for (int c = 0; c < dec->channel_count; ++c)
    {
        exr_coding_channel_info_t* ci = dec->channels + c;
        ci->decode_to_ptr             = NULL;
    }
    for (int s = 0; s < 4; ++s)
    {
        slot_t* sl = slots + s;
        if (sl->chan_index < 0 || sl->dup_of >= 0) continue;
        exr_coding_channel_info_t* ci = dec->channels + sl->chan_index;
        ci->user_bytes_per_element    = (int16_t) bpe;
        ci->user_data_type            = (uint16_t) out_type;
        if (!sl->sampled)
        {
            ci->user_pixel_stride = 4 * bpe;
            ci->user_line_stride  = (int32_t) (W * 4 * bpe);
            ci->decode_to_ptr =
                out + (((y0 - dw->min.y) * W + (x0 - dw->min.x)) * 4 + s) * bpe;
        }
        else
        {
            int64_t sx0 = floor_div (dw->min.x, sl->xs);
            int64_t sy0 = floor_div (dw->min.y, sl->ys);
            int64_t cx  = floor_div (x0 + sl->xs - 1, sl->xs) - sx0;
            int64_t cy  = floor_div (y0 + sl->ys - 1, sl->ys) - sy0;
            ci->user_pixel_stride = bpe;
            ci->user_line_stride  = (int32_t) (sl->sw * bpe);
            ci->decode_to_ptr     = sl->plane + (cy * sl->sw + cx) * bpe;
        }
    }
}

static exr_result_t decode_chunk (
    exr_context_t          ctxt,
    int                    part,
    exr_chunk_info_t*      cinfo,
    exr_decode_pipeline_t* dec,
    int*                   initialized,
    slot_t*                slots,
    uint8_t*               out,
    int64_t                W,
    const exr_attr_box2i_t* dw,
    int64_t                x0,
    int64_t                y0,
    int                    bpe,
    int                    out_type)
{
    exr_result_t rv;
    if (!*initialized)
    {
        rv = exr_decoding_initialize (ctxt, part, cinfo, dec);
        if (rv != EXR_ERR_SUCCESS) return rv;
        *initialized = 1;
    }
    else
    {
        rv = exr_decoding_update (ctxt, part, cinfo, dec);
        if (rv != EXR_ERR_SUCCESS) return rv;
    }
    setup_chunk_ptrs (dec, slots, out, W, dw, x0, y0, bpe, out_type);
    rv = exr_decoding_choose_default_routines (ctxt, part, dec);
    if (rv != EXR_ERR_SUCCESS) return rv;
    return exr_decoding_run (ctxt, part, dec);
}

/*
 * Decode part `part`, mapping the named channels to R, G, B, A.
 * Empty / NULL names mean "not present" (RGB filled with 0, A with 1).
 * The same channel name may be used for several outputs (e.g. Z -> RGB).
 */
EXPORT int exrw_decode (
    exrw_handle* h,
    int          part,
    const char*  rname,
    const char*  gname,
    const char*  bname,
    const char*  aname,
    int          out_float)
{
    if (!h) return EXR_ERR_INVALID_ARGUMENT;
    g_last_error[0] = '\0';
    exrw_free_result (h);
    h->failed_chunks = 0;

    exr_context_t ctxt  = h->ctxt;
    int           count = 0;
    exr_result_t  rv    = exr_get_count (ctxt, &count);
    if (rv != EXR_ERR_SUCCESS) return rv;
    if (part < 0 || part >= count)
    {
        set_error ("part index %d out of range (file has %d parts)", part, count);
        return EXR_ERR_ARGUMENT_OUT_OF_RANGE;
    }

    exr_storage_t storage;
    rv = exr_get_storage (ctxt, part, &storage);
    if (rv != EXR_ERR_SUCCESS) return rv;
    if (storage == EXR_STORAGE_DEEP_SCANLINE || storage == EXR_STORAGE_DEEP_TILED)
    {
        set_error ("deep data is not supported (part %d)", part);
        return EXR_ERR_FEATURE_NOT_IMPLEMENTED;
    }

    exr_attr_box2i_t dw;
    rv = exr_get_data_window (ctxt, part, &dw);
    if (rv != EXR_ERR_SUCCESS) return rv;
    int64_t W = (int64_t) dw.max.x - dw.min.x + 1;
    int64_t H = (int64_t) dw.max.y - dw.min.y + 1;
    if (W <= 0 || H <= 0)
    {
        set_error ("empty data window");
        return EXR_ERR_INVALID_ATTR;
    }

    const exr_attr_chlist_t* chans = NULL;
    rv = exr_get_channels (ctxt, part, &chans);
    if (rv != EXR_ERR_SUCCESS) return rv;

    const int bpe      = out_float ? 4 : 2;
    const int out_type = out_float ? EXR_PIXEL_FLOAT : EXR_PIXEL_HALF;

    const char* names[4] = {rname, gname, bname, aname};
    slot_t      slots[4];
    memset (slots, 0, sizeof (slots));
    for (int s = 0; s < 4; ++s)
    {
        slots[s].chan_index = find_channel (chans, names[s]);
        slots[s].dup_of     = -1;
        if (names[s] && names[s][0] && slots[s].chan_index < 0)
        {
            set_error ("channel '%s' not found in part %d", names[s], part);
            return EXR_ERR_INVALID_ARGUMENT;
        }
        for (int t = 0; t < s; ++t)
            if (slots[s].chan_index >= 0 &&
                slots[t].chan_index == slots[s].chan_index && slots[t].dup_of < 0)
            {
                slots[s].dup_of = t;
                break;
            }
    }

    size_t npix = (size_t) W * (size_t) H;
    size_t total = npix * 4u * (size_t) bpe;
    if (total / 4u / (size_t) bpe != npix || total > 0xffffffffu)
    {
        set_error ("image too large (%lldx%lld)", (long long) W, (long long) H);
        return EXR_ERR_OUT_OF_MEMORY;
    }
    uint8_t* out = (uint8_t*) malloc (total);
    if (!out)
    {
        set_error ("out of memory allocating %zu bytes", total);
        return EXR_ERR_OUT_OF_MEMORY;
    }

    /* allocate temp planes for subsampled channels */
    for (int s = 0; s < 4; ++s)
    {
        slot_t* sl = slots + s;
        if (sl->chan_index < 0 || sl->dup_of >= 0) continue;
        const exr_attr_chlist_entry_t* e = chans->entries + sl->chan_index;
        sl->xs = e->x_sampling > 0 ? e->x_sampling : 1;
        sl->ys = e->y_sampling > 0 ? e->y_sampling : 1;
        if (sl->xs == 1 && sl->ys == 1) continue;
        sl->sampled = 1;
        sl->sw = floor_div (dw.max.x, sl->xs) - floor_div (dw.min.x + sl->xs - 1, sl->xs) + 1;
        sl->sh = floor_div (dw.max.y, sl->ys) - floor_div (dw.min.y + sl->ys - 1, sl->ys) + 1;
        if (sl->sw < 1) sl->sw = 1;
        if (sl->sh < 1) sl->sh = 1;
        sl->plane = (uint8_t*) calloc ((size_t) (sl->sw * sl->sh), (size_t) bpe);
        if (!sl->plane)
        {
            for (int t = 0; t < 4; ++t)
                free (slots[t].plane);
            free (out);
            set_error ("out of memory");
            return EXR_ERR_OUT_OF_MEMORY;
        }
    }

    /* pre-fill outputs without a source channel: RGB = 0, A = 1 */
    {
        const uint16_t one_h = 0x3c00u;
        const float    one_f = 1.0f;
        for (int s = 0; s < 4; ++s)
        {
            if (slots[s].chan_index >= 0) continue;
            if (out_float)
            {
                float  v = s == 3 ? one_f : 0.0f;
                float* o = (float*) out + s;
                for (size_t i = 0; i < npix; ++i)
                    o[i * 4] = v;
            }
            else
            {
                uint16_t  v = s == 3 ? one_h : 0;
                uint16_t* o = (uint16_t*) out + s;
                for (size_t i = 0; i < npix; ++i)
                    o[i * 4] = v;
            }
        }
    }

    int any_channel = 0;
    for (int s = 0; s < 4; ++s)
        if (slots[s].chan_index >= 0) any_channel = 1;

    exr_decode_pipeline_t dec         = EXR_DECODE_PIPELINE_INITIALIZER;
    int                   initialized = 0;
    exr_result_t          first_err   = EXR_ERR_SUCCESS;
    int                   ok_chunks   = 0;

    if (any_channel && storage == EXR_STORAGE_SCANLINE)
    {
        int32_t lpc = 1;
        rv          = exr_get_scanlines_per_chunk (ctxt, part, &lpc);
        if (rv == EXR_ERR_SUCCESS)
        {
            for (int64_t y = dw.min.y; y <= dw.max.y;)
            {
                exr_chunk_info_t cinfo;
                memset (&cinfo, 0, sizeof (cinfo));
                rv = exr_read_scanline_chunk_info (ctxt, part, (int) y, &cinfo);
                int64_t next;
                if (rv == EXR_ERR_SUCCESS)
                {
                    next = (int64_t) cinfo.start_y + cinfo.height;
                    rv   = decode_chunk (
                        ctxt, part, &cinfo, &dec, &initialized, slots, out, W,
                        &dw, dw.min.x, cinfo.start_y, bpe, out_type);
                }
                else
                {
                    /* chunk boundaries are aligned to the data window origin */
                    next = dw.min.y + (floor_div (y - dw.min.y, lpc) + 1) * lpc;
                }
                if (rv != EXR_ERR_SUCCESS)
                {
                    if (first_err == EXR_ERR_SUCCESS) first_err = rv;
                    h->failed_chunks++;
                }
                else
                    ok_chunks++;
                if (next <= y) next = y + 1;
                y = next;
            }
        }
        else
            first_err = rv;
    }
    else if (any_channel && storage == EXR_STORAGE_TILED)
    {
        uint32_t              tw = 0, th = 0;
        exr_tile_level_mode_t lm;
        exr_tile_round_mode_t rm;
        int32_t               nx = 0, ny = 0;
        rv = exr_get_tile_descriptor (ctxt, part, &tw, &th, &lm, &rm);
        if (rv == EXR_ERR_SUCCESS)
            rv = exr_get_tile_counts (ctxt, part, 0, 0, &nx, &ny);
        if (rv == EXR_ERR_SUCCESS)
        {
            for (int32_t ty = 0; ty < ny; ++ty)
            {
                for (int32_t tx = 0; tx < nx; ++tx)
                {
                    exr_chunk_info_t cinfo;
                    memset (&cinfo, 0, sizeof (cinfo));
                    rv = exr_read_tile_chunk_info (ctxt, part, tx, ty, 0, 0, &cinfo);
                    if (rv == EXR_ERR_SUCCESS)
                        rv = decode_chunk (
                            ctxt, part, &cinfo, &dec, &initialized, slots, out, W,
                            &dw, (int64_t) dw.min.x + (int64_t) tx * tw,
                            (int64_t) dw.min.y + (int64_t) ty * th, bpe, out_type);
                    if (rv != EXR_ERR_SUCCESS)
                    {
                        if (first_err == EXR_ERR_SUCCESS) first_err = rv;
                        h->failed_chunks++;
                    }
                    else
                        ok_chunks++;
                }
            }
        }
        else
            first_err = rv;
    }

    if (initialized) exr_decoding_destroy (ctxt, &dec);

    if (any_channel && ok_chunks == 0)
    {
        for (int t = 0; t < 4; ++t)
            free (slots[t].plane);
        free (out);
        if (!g_last_error[0])
            set_error ("decode failed: %s", exr_get_error_code_as_string (first_err));
        return first_err != EXR_ERR_SUCCESS ? first_err : EXR_ERR_CORRUPT_CHUNK;
    }

    /* upsample subsampled channels (nearest) into the interleaved output */
    for (int s = 0; s < 4; ++s)
    {
        slot_t* sl = slots + s;
        if (!sl->sampled) continue;
        int64_t sx0 = floor_div (dw.min.x + sl->xs - 1, sl->xs);
        int64_t sy0 = floor_div (dw.min.y + sl->ys - 1, sl->ys);
        for (int64_t y = 0; y < H; ++y)
        {
            int64_t py = floor_div (dw.min.y + y, sl->ys) - sy0;
            if (py < 0) py = 0;
            if (py >= sl->sh) py = sl->sh - 1;
            for (int64_t x = 0; x < W; ++x)
            {
                int64_t px = floor_div (dw.min.x + x, sl->xs) - sx0;
                if (px < 0) px = 0;
                if (px >= sl->sw) px = sl->sw - 1;
                memcpy (
                    out + ((y * W + x) * 4 + s) * bpe,
                    sl->plane + (py * sl->sw + px) * bpe,
                    (size_t) bpe);
            }
        }
        free (sl->plane);
        sl->plane = NULL;
    }

    /* duplicated outputs (e.g. single channel -> RGB) */
    for (int s = 0; s < 4; ++s)
    {
        int src = slots[s].dup_of;
        if (src < 0) continue;
        if (out_float)
        {
            float* o = (float*) out;
            for (size_t i = 0; i < npix; ++i)
                o[i * 4 + s] = o[i * 4 + src];
        }
        else
        {
            uint16_t* o = (uint16_t*) out;
            for (size_t i = 0; i < npix; ++i)
                o[i * 4 + s] = o[i * 4 + src];
        }
    }

    h->result      = out;
    h->result_size = total;
    if (first_err != EXR_ERR_SUCCESS && !g_last_error[0])
        set_error ("%d chunk(s) failed to decode", h->failed_chunks);
    return EXR_ERR_SUCCESS;
}
