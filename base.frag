#version 300 es
precision highp float;

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2      uResolution;
uniform float     uThreshold;     // source-luminance threshold for shadow fill
uniform float     uRadius;
uniform float     uGooeyness;
uniform float     uPixelSize;
uniform float     uLineThickness; // raster dilation radius in pixels (0 = disabled)

uniform int       uPaper;      // 0 = white background, 1 = paper texture background
uniform int       uMode;       // 0 = trame background, 1 = 8-neighbor quadrant fill
uniform float     uAspect;     // W / H — used to make halftone dots square

/* ANGLES CMYK */
#define AK 0.78
#define AC 0.26
#define AM 1.3
#define AY 0.0

#define PI 3.14159265359

mat2 rotate2d(float _angle){
    return mat2(cos(_angle),-sin(_angle),
                sin(_angle),cos(_angle));
}

float smin( float a, float b, float k ) {
    float h = max(k-abs(a-b),0.0);
    return min(a, b) - h*h*0.25/k;
}

float luminance(vec3 _color){
    return (0.2126*_color.r + 0.7152*_color.g + 0.0722*_color.b);
}

/* TONER FUNCTION USED FOR EVERY COLOR
    Takes grid angle and channel as input 
    _chan: 
    0: black
    1: cyan
    2: yellow
    3: magenta
*/
float toner(vec2 _st, float _angle, int _chan) {
    /* PARAMETERS */
    float gooeyness = uGooeyness * 0.6;
    float minDist = 100.0;
    float maxCircle = 0.0;
    float smoothK = gooeyness * 1.5;
    int searchRadius = 1; 

    /* PIXEL GRID AND ROTATION CALC */
    vec2 pixelCoord = _st * uResolution;
    vec2 center = uResolution * 0.5;
    pixelCoord = rotate2d(_angle) * (pixelCoord - center) + center;
    vec2 baseCellIndex = floor(pixelCoord / uPixelSize);

    float lod = max(0.0, log2(uPixelSize) - 1.0);

    float aa = length(fwidth(pixelCoord));

    for (int dx = -searchRadius; dx <= searchRadius; dx++) {
        for (int dy = -searchRadius; dy <= searchRadius; dy++) {

            vec2 cellIndex = baseCellIndex + vec2(float(dx), float(dy));
            vec2 cellCenter = (cellIndex + 0.5) * uPixelSize;

            vec2 cellCenterUnrotated = rotate2d(-_angle) * (cellCenter - center) + center;
            vec2 uvSample = cellCenterUnrotated / uResolution;

            vec4 texColor = textureLod(uSource, uvSample, lod);
            
            float dist = length(pixelCoord - cellCenter);
            
            float lum = 0.0;
            if (_chan == 0){ 
                lum = luminance(texColor.rgb);
            } else if (_chan == 1){
                lum = texColor.r;
            } else if (_chan == 2){
                lum = texColor.b;
            } else if (_chan == 3){
                lum = texColor.g;
            }
            
            float radius = uPixelSize * uRadius * (1.0 - lum);

            float ghostSuppress = max(aa - radius, 0.0);
            float sdfDist       = dist - radius + ghostSuppress;

            minDist = smin(minDist, sdfDist, smoothK * uPixelSize);
            
            float circle = 1.0 - smoothstep(radius - aa, radius + aa, dist);

            maxCircle = max(maxCircle,circle);
        }
    }

    float finalShape;
    if (gooeyness > 0.01) {
        finalShape = 1.0 - smoothstep(-aa, aa, minDist);
    } else {
        finalShape = maxCircle;
    }
    return finalShape;
}


void main(){
    vec2 st = vUv;
    
    vec3 color = vec3(1.0);

    // uMode: 0 = Color CMYK halftone, 1 = Black-only halftone
    if (uMode == 0) {
        // Remove the complementary colors for each CYM channel
        color -= vec3(1.0, 0.0, 0.0) * toner(st, AC, 1);
        color -= vec3(0.0, 0.0, 1.0) * toner(st, AY, 2);
        color -= vec3(0.0, 1.0, 0.0) * toner(st, AM, 3);
    }

    // Black channel applies in both modes
    color *= 1. - toner(st, AK, 0);


    // Raster: pixel-accurate solid-black fill for pixels below threshold
    // Lod for raster, higher precision than Dots for fine line
    // Morphological dilation: sample a small neighborhood and keep the
    // darkest luminance — thickens thin lines so they read properly.
    float lod    = max(0.0, log2(uPixelSize/2.) - 1.0);
    vec2  px     = 1.0 / uResolution;
    float lumMin = 1.0;
    for (int dx = -1; dx <= 1; dx++) {
        for (int dy = -1; dy <= 1; dy++) {
            vec2 off = vec2(float(dx), float(dy)) * uLineThickness * px;
            vec4 t   = textureLod(uSource, st + off, lod);
            lumMin   = min(lumMin, luminance(clamp(t.rgb, 0.0, 1.0)));
        }
    }
    float black = step(uThreshold * 0.6, lumMin);
    color *= black;

    fragColor = vec4(color, 1.0);
}