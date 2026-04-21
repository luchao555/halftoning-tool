#version 300 es
precision highp float;

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2      uResolution;
uniform float     uAspect;     // W / H — used to make halftone dots square
uniform float     uGrid;       // grid resolution (cells per unit)
uniform int       uMode;       // 0 = trame background, 1 = 8-neighbor quadrant fill
uniform float     uThreshold;  // source-luminance threshold for shadow fill
uniform int       uPaper;      // 0 = white background, 1 = paper texture background

/* ANGLES CMYK */
#define AK 0.78
#define AC 0.26
#define AM 1.3
#define AY 0.0

#define PI 3.14159265359

// ─── Noise utilities ─────────────────────────────────────────────────────────
float random(in vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(in vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);

    float a = random(i);
    float b = random(i + vec2(1.0, 0.0));
    float c = random(i + vec2(0.0, 1.0));
    float d = random(i + vec2(1.0, 1.0));

    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(a, b, u.x) +
            (c - a) * u.y * (1.0 - u.x) +
            (d - b) * u.x * u.y;
}

// ─── Simplex noise 3D (Gustavson / McEwan) ───────────────────────────────────
vec4 taylorInvSqrt(in vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec3 mod289(const in vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(const in vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(const in vec4 v) { return mod289(((v * 34.0) + 1.0) * v); }

float snoise(in vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g  = step(x0.yzx, x0.xyz);
    vec3 l  = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ─── Halftone blotches (perturbed disc) ──────────────────────────────────────
float blotches(vec2 st, vec2 center, float radius, float seed) {
    float d = length(fract(st) - 0.5);
    float n = snoise(vec3(7.0 * st, 0.0))
            + 0.5 * snoise(vec3(10.0 * st, seed));
    float blotch = step(radius * 0.9, d + 0.05 * n);
    return blotch + step(0.4, ((1.0 - blotch) * n * 0.4));
}

// ─── Utils ───────────────────────────────────────────────────────────────────
float luminance(vec3 c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

vec3 unmultiply(vec4 texel) {
    return texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
}

vec4 premultiply(vec3 color, float alpha) {
    return vec4(color * alpha, alpha);
}

mat2 rotate2d(float a) {
    return mat2(cos(a), -sin(a),
                sin(a),  cos(a));
}

vec2 rotcan(vec2 st, float angle) {
    st -= vec2(0.5);
    st *= rotate2d(angle);
    st += vec2(0.5);
    return st;
}

vec2 snapcan(vec2 st, float grid, float angle) {
    vec2 snapped = floor(st * grid) / grid;
    return transpose(rotate2d(-angle)) * (snapped - vec2(0.5)) + vec2(0.5);
}

// Convert from aspect-scaled space back to [0,1] image UV
vec2 toImageUV(vec2 p) {
    return vec2(p.x / uAspect, p.y);
}



vec3 halftoning(vec2 st_k, vec2 st_c, vec2 st_y, vec2 st_m,
                vec3 img_k, vec3 img_c, vec3 img_y, vec3 img_m) {
    vec3 color = vec3(0.0);
    vec3 color_circle = vec3(0.0);

    // Negative image
    img_k = vec3(1.0) - img_k;
    img_c = vec3(1.0) - img_c;
    img_y = vec3(1.0) - img_y;
    img_m = vec3(1.0) - img_m;

    // Black channel radius (shaped via mean)
    float lum = luminance(img_k);

    float slope = 1.0 - pow(abs(sin(PI * (lum + 1.0) / 2.0)), 3.0);
    //slope = 1.0 - pow(abs(lum - 1.0), 5.5);

    float radius = (lum / 1.5) * slope;

    float circle_res = 1.0 - blotches(st_k, vec2(0.5), radius, st_k.x * st_k.y);
    color = vec3(1.0 - circle_res);

    //color = vec3(1.0);
    color_circle.r = blotches(st_y, vec2(0.5), img_y.r / 1.5, st_y.x * st_y.y);
    color_circle.g = blotches(st_c, vec2(0.5), img_c.g / 1.5, st_c.x * st_c.y);
    color_circle.b = blotches(st_m, vec2(0.5), img_m.b / 1.5, st_m.x * st_m.y);

    color *= color_circle;
    return color;
}


float fbm(vec2 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 5; i++) {
        val += amp * snoise(vec3(p * freq,0.0));
        amp  *= 0.5;
        freq *= 2.1;
    }
    return val;
}

// ─── Paper texture ───────────────────────────────────────────────────────────
// Box SDF used for the paper micro-grid.
float squareSdf(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Grey-scale mask describing the paper surface (fibres, folds, grid, grain).
// Returns a float that can drive ink absorption / print irregularities.
// Higher values = more "substance" (fibre bump, fold crest), lower = hollow.
float paperMask(vec2 st) {
    vec2 st_paper       = st * 15.0;
    vec2 st_micro_grain = st_paper;
    st_micro_grain.y   *= 3.0;

    // Warp domain with low-freq fbm to break straight grid lines
    vec2 warpedUV = st_paper + 0.08 * vec2(
        fbm(st_paper * 3.0 + vec2(1.7, 9.2)),
        fbm(st_paper * 3.0 + vec2(8.3, 2.8))
    );

    // Micro grid rotated 45° — imitates Canson embossing
    vec2  st_rot = rotate2d(PI / 4.0) * warpedUV;
    vec2  st_sq  = fract(st_rot);
    float sq     = squareSdf(st_sq - vec2(0.5), vec2(0.01));
    float square = smoothstep(0.3, 0.9, sq) * 0.4;

    // Macro folds / uneven lighting
    vec2  st_macro = st * 1.2;
    float macroVar = smoothstep(0.2, 0.5, fbm(st_macro) * 5.0);

    // Long fibres running through the sheet
    float fiber = smoothstep(0.2, 0.85, 1.0 - fbm(warpedUV * 6.0));

    // High-freq grain
    float microGrain = fbm(st_micro_grain * 5.0);

    return microGrain * 0.7 + square + fiber + macroVar * 0.4;
}

// Paper background colour built from paperMask().
vec3 paperColor(vec2 st) {
    const vec3 paperLight = vec3(0.96,  0.93,   0.88);
    const vec3 paperMid   = vec3(0.898, 0.8549, 0.7922);
    float m = paperMask(st);
    return mix(paperMid, paperLight, m);
}

void main() {
    // Stretch x so that a cell of size 1/grid is square in screen pixels.
    // Works for any aspect ratio since the canvas matches the source ratio.
    vec2 uv = vUv;
    uv.x *= uAspect;

    vec2 st = uv;
    float grid = uGrid;
    float lod = log2(uResolution.x / grid);
    int paper = uPaper;
    paper = 0;
    // Paper vs. plain white background
    vec3 bg        = (paper == 1) ? paperColor(st) : vec3(1.0);
    vec3 color     = vec3(1.0);
    vec3 bright_bg = vec3(1.0);

    // Rotated coordinate frames for each CMYK channel (pre-scaled, kept for
    // neighbor sampling in voisins mode)
    vec2 st_k_pre = rotcan(st, AK);
    vec2 st_c_pre = rotcan(st, AC);
    vec2 st_y_pre = rotcan(st, AY);
    vec2 st_m_pre = rotcan(st, AM);

    // Sample source at snapped grid positions (remap to image UV)
    vec2 st_sn_k = snapcan(st_k_pre, grid, AK);
    vec4 img_bg  = textureLod(uSource, toImageUV(st_sn_k), lod);
    vec3 norm_img_bg = clamp(unmultiply(img_bg) * bright_bg, 0.0, 1.0);

    vec2 st_sn_c = snapcan(st_c_pre, grid, AC);
    vec4 img_c   = textureLod(uSource, toImageUV(st_sn_c), lod);
    vec3 norm_img_c = clamp(unmultiply(img_c) * bright_bg, 0.0, 1.0);

    vec2 st_sn_y = snapcan(st_y_pre, grid, AY);
    vec4 img_y   = textureLod(uSource, toImageUV(st_sn_y), lod);
    vec3 norm_img_y = clamp(unmultiply(img_y) * bright_bg, 0.0, 1.0);

    vec2 st_sn_m = snapcan(st_m_pre, grid, AM);
    vec4 img_m   = textureLod(uSource, toImageUV(st_sn_m), lod);
    vec3 norm_img_m = clamp(unmultiply(img_m) * bright_bg, 0.0, 1.0);

    // Scaled to cell units (1 unit = 1 cell) for halftoning
    vec2 st_k = st_k_pre * grid;
    vec2 st_c = st_c_pre * grid;
    vec2 st_y = st_y_pre * grid;
    vec2 st_m = st_m_pre * grid;

    color *= halftoning(st_k, st_c, st_y, st_m,
                        norm_img_bg, norm_img_c, norm_img_y, norm_img_m);


    // Trame: pixel-accurate solid-black fill for pixels below threshold
    vec4  img_pix = textureLod(uSource, toImageUV(st), lod);
    float lumPix  = luminance(clamp(unmultiply(img_pix), 0.0, 1.0));
    float black   = step(uThreshold, lumPix);
    color *= black;

    vec3 b_col = vec3(0.102, 0.102, 0.102);
    vec3 b_col_dark = vec3(0.0, 0.0, 0.0);

    if (luminance(color) < 0.1) {
        color = mix(b_col,b_col_dark,bg/2.);
    }


    color *= bg;

    fragColor = premultiply(color, img_bg.a);
}
