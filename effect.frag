#version 300 es
precision highp float;

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBase;        // pixelized layer input
uniform vec2      uResolution;
uniform float     uTime;
uniform float     uIntensity;   // overall effect strength (0–1)

// ─── Hash / noise ─────────────────────────────────────────────────────────
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
    vec3  base    = texture(uBase, vUv).rgb;
    float lum     = dot(base, vec3(0.299, 0.587, 0.114));

    // ── Chromatic aberration ──────────────────────────────────────────────
    // Shifts RGB channels along a slightly angled axis.
    float shift = uIntensity * 0.008;
    vec2  dir   = normalize(vec2(1.0, 0.3));

    float r = texture(uBase, vUv + dir *  shift).r;
    float g = base.g;
    float b = texture(uBase, vUv + dir * -shift).b;

    vec3 result = vec3(r, g, b);

    // ── Scanlines ─────────────────────────────────────────────────────────
    // One dark line every 3 pixels at native resolution.
    float scanline = mod(floor(vUv.y * uResolution.y), 3.0);
    float scanMask = 1.0 - step(2.0, scanline) * 0.18 * uIntensity;
    result *= scanMask;

    // ── Film grain (animate with time) ───────────────────────────────────
    float grain = (hash(vUv * uResolution + vec2(uTime * 17.3, uTime * 31.7)) - 0.5)
                  * 0.05 * uIntensity;
    // Apply grain only where there is content
    result += grain * lum;

    // ── Vignette ──────────────────────────────────────────────────────────
    vec2  d    = vUv - 0.5;
    d.x       *= uResolution.x / uResolution.y;
    float vign = 1.0 - smoothstep(0.38, 0.85, length(d) * 1.3) * 0.5 * uIntensity;
    result    *= vign;

    fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
