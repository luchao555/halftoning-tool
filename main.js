// ═══════════════════════════════════════════════════════════════════════════
// Compositor fragment shader — kept inline (not user-editable)
// ═══════════════════════════════════════════════════════════════════════════

const COMP_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;      // raw input
uniform sampler2D uBase;        // pixelized layer
uniform sampler2D uEffect;      // CRT effect layer

uniform float uBaseOpacity;     // 0 = raw source, 1 = full pixel
uniform int   uEnableEffect;
uniform float uEffectOpacity;

void main() {
    vec3 src    = texture(uSource, vUv).rgb;
    vec3 base   = texture(uBase,   vUv).rgb;
    vec3 effect = texture(uEffect, vUv).rgb;

    // Blend raw source with pixelization
    vec3 result = mix(src, base, uBaseOpacity);

    // Apply effect on top
    if (uEnableEffect == 1) {
        result = mix(result, effect, uEffectOpacity);
    }

    fragColor = vec4(result, 1.0);
}`;

// ═══════════════════════════════════════════════════════════════════════════
// WebGL utilities
// ═══════════════════════════════════════════════════════════════════════════

function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh));
    }
    return sh;
}

function createProgram(gl, vertSrc, fragSrc) {
    const vs   = compileShader(gl, gl.VERTEX_SHADER,   vertSrc);
    const fs   = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
}

function createFBO(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
}

function setU1i(gl, p, n, v) { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform1i(l, v); }
function setU1f(gl, p, n, v) { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform1f(l, v); }
function setU2f(gl, p, n, x, y) { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform2f(l, x, y); }

// ═══════════════════════════════════════════════════════════════════════════
// App
// ═══════════════════════════════════════════════════════════════════════════

async function fetchText(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Cannot load ${path} (HTTP ${r.status})`);
    return r.text();
}

async function boot() {

    // ── Load shaders ─────────────────────────────────────────────────────────

    const [vertSrc, baseSrc, effectSrc] = await Promise.all([
        fetchText('vert.glsl'),
        fetchText('base.frag'),
        fetchText('effect.frag'),
    ]);

    // ── Canvas + WebGL ───────────────────────────────────────────────────────

    const canvas = document.getElementById('c');
    const gl     = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is not supported in this browser.');

    let W = 1200, H = 1080;
    let paused     = false;
    let startTime  = Date.now();
    let frameCount = 0;
    let lastFpsTime = Date.now();
    let rafId       = null;

    // ── Programs ─────────────────────────────────────────────────────────────

    let progBase   = createProgram(gl, vertSrc, baseSrc);
    let progEffect = createProgram(gl, vertSrc, effectSrc);
    const progComp = createProgram(gl, vertSrc, COMP_FRAG);

    // ── Quad buffer ──────────────────────────────────────────────────────────

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
        gl.STATIC_DRAW
    );

    function drawQuad(prog) {
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── Source texture ───────────────────────────────────────────────────────

    const sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([30, 30, 30, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    let sourceElem = null;
    let isVideo    = false;
    let sourceNativeSize = [1, 1];

    function uploadSource(elem) {
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, elem);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // ── FBOs ─────────────────────────────────────────────────────────────────

    let fboBase, fboEffect;

    function rebuildFBOs() {
        canvas.width  = W;
        canvas.height = H;
        fboBase   = createFBO(gl, W, H);
        fboEffect = createFBO(gl, W, H);
        document.getElementById('meta-res').textContent = `${W} × ${H}`;
    }

    rebuildFBOs();

    // ── State ─────────────────────────────────────────────────────────────────

    const state = {
        pixelSize:       10,
        threshold:       0.2,   // source-luminance threshold for shadow fill
        radius:          0.7,   // radius of toner circles
        gooeyness:       0.15,   // gooeyness of circles
        lineThickness:   0.0,   // raster dilation radius in pixels (fine-line boost)
        mode:            0,     // 0 = trame, 1 = voisins (8-neighbor quadrant fill)
        baseOpacity:     1.0,   // fixed — compositor just passes through base
        effectOn:        false, // effect section hidden for now
        effectOpacity:   0.7,
        effectIntensity: 0.6,
    };

    // ── Render ────────────────────────────────────────────────────────────────

    function bindFBO(fbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fbo : null);
        gl.viewport(0, 0, fbo ? fbo.w : W, fbo ? fbo.h : H);
    }

    function bindTex(unit, tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    function render() {
        const time  = (Date.now() - startTime) / 1000;

        // Update video texture every frame
        if (isVideo && sourceElem?.readyState >= 2) {
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceElem);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        // ── Pass 1: Halftone base ─────────────────────────────────────────────
        bindFBO(fboBase);
        gl.useProgram(progBase);
        bindTex(0, sourceTex);
        setU1i(gl, progBase, 'uSource',     0);
        setU2f(gl, progBase, 'uResolution', W, H);
        setU1f(gl, progBase, 'uAspect',     W / H);
        setU1f(gl, progBase, 'uPixelSize',  state.pixelSize);
        setU1f(gl, progBase, 'uThreshold',  state.threshold);
        setU1f(gl, progBase, 'uRadius',     state.radius);
        setU1f(gl, progBase, 'uGooeyness',     state.gooeyness);
        setU1f(gl, progBase, 'uLineThickness', state.lineThickness);
        setU1i(gl, progBase, 'uMode',          state.mode);
        drawQuad(progBase);

        // ── Pass 2: CRT effect ────────────────────────────────────────────────
        if (state.effectOn) {
            bindFBO(fboEffect);
            gl.useProgram(progEffect);
            bindTex(0, fboBase.tex);
            setU1i(gl, progEffect, 'uBase',       0);
            setU2f(gl, progEffect, 'uResolution', W, H);
            setU1f(gl, progEffect, 'uTime',       time);
            setU1f(gl, progEffect, 'uIntensity',  state.effectIntensity);
            drawQuad(progEffect);
        }

        // ── Compositor → screen ───────────────────────────────────────────────
        bindFBO(null);
        gl.useProgram(progComp);
        bindTex(0, sourceTex);
        bindTex(1, fboBase.tex);
        bindTex(2, fboEffect.tex);
        setU1i(gl, progComp, 'uSource',        0);
        setU1i(gl, progComp, 'uBase',          1);
        setU1i(gl, progComp, 'uEffect',        2);
        setU1f(gl, progComp, 'uBaseOpacity',   state.baseOpacity);
        setU1i(gl, progComp, 'uEnableEffect',  state.effectOn ? 1 : 0);
        setU1f(gl, progComp, 'uEffectOpacity', state.effectOpacity);
        drawQuad(progComp);

        // FPS counter
        frameCount++;
        const now = Date.now();
        if (now - lastFpsTime >= 1000) {
            document.getElementById('meta-fps').textContent =
                Math.round(frameCount * 1000 / (now - lastFpsTime)) + ' fps';
            frameCount  = 0;
            lastFpsTime = now;
        }
    }

    // ── Loop ─────────────────────────────────────────────────────────────────

    function startLoop() {
        if (rafId) return;
        const loop = () => { render(); rafId = requestAnimationFrame(loop); };
        rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopLoop();
        else if (!paused)    startLoop();
    });

    // ── Shader hot-reload ─────────────────────────────────────────────────────

    async function reloadBase() {
        const btn = document.getElementById('btn-reload-base');
        btn.textContent = '…';
        try {
            const src = await fetchText('base.frag?t=' + Date.now());
            progBase  = createProgram(gl, vertSrc, src);
            document.getElementById('err-base').classList.add('hidden');
        } catch (e) {
            const box = document.getElementById('err-base');
            box.textContent = e.message;
            box.classList.remove('hidden');
        } finally {
            btn.textContent = '⟳';
        }
    }

    async function reloadEffect() {
        const btn  = document.getElementById('btn-reload-effect');
        btn.textContent = '…';
        try {
            const src  = await fetchText('effect.frag?t=' + Date.now());
            progEffect = createProgram(gl, vertSrc, src);
            document.getElementById('err-effect').classList.add('hidden');
        } catch (e) {
            const box = document.getElementById('err-effect');
            box.textContent = e.message;
            box.classList.remove('hidden');
        } finally {
            btn.textContent = '⟳';
        }
    }

    document.getElementById('btn-reload-base').addEventListener('click', reloadBase);
    document.getElementById('btn-reload-effect').addEventListener('click', reloadEffect);

    // ── File loading ─────────────────────────────────────────────────────────

    // Resize canvas to match source aspect ratio, capping the long side
    function fitCanvasToSource(w, h) {
        const maxSide = 1920;
        if (w >= h) {
            W = Math.min(w, maxSide);
            H = Math.round(W * h / w);
        } else {
            H = Math.min(h, maxSide);
            W = Math.round(H * w / h);
        }
        rebuildFBOs();
    }

    function loadFile(file) {
        document.getElementById('source-name').textContent = file.name;

        if (file.type.startsWith('video/')) {
            if (sourceElem instanceof HTMLVideoElement) sourceElem.pause();
            const video       = document.createElement('video');
            video.src         = URL.createObjectURL(file);
            video.loop        = true;
            video.muted       = true;
            video.autoplay    = true;
            video.playsInline = true;
            video.oncanplay   = () => {
                video.play();
                sourceElem = video;
                isVideo = true;
                sourceNativeSize = [video.videoWidth, video.videoHeight];
                fitCanvasToSource(video.videoWidth, video.videoHeight);
            };
        } else {
            const img = new Image();
            img.onload = () => {
                sourceElem = img;
                isVideo    = false;
                uploadSource(img);
                sourceNativeSize = [img.naturalWidth, img.naturalHeight];
                fitCanvasToSource(img.naturalWidth, img.naturalHeight);
            };
            img.src = URL.createObjectURL(file);
        }

        document.getElementById('drop-overlay').classList.add('has-media');
    }

    // ── Drop zone ─────────────────────────────────────────────────────────────

    const overlay   = document.getElementById('drop-overlay');
    const fileInput = document.getElementById('file-input');

    overlay.addEventListener('click',     () => fileInput.click());
    overlay.addEventListener('dragover',  e  => { e.preventDefault(); overlay.classList.add('drag-over'); });
    overlay.addEventListener('dragleave', ()  => overlay.classList.remove('drag-over'));
    overlay.addEventListener('drop', e => {
        e.preventDefault();
        overlay.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) loadFile(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('btn-change-source').addEventListener('click', () => fileInput.click());

    // ── Sliders ───────────────────────────────────────────────────────────────

    function wireSlider(id, valId, key, fmt) {
        const sl = document.getElementById(id);
        const vl = document.getElementById(valId);
        // Sync state + label with the slider's initial value so they never drift
        state[key]     = parseFloat(sl.value);
        vl.textContent = fmt(state[key]);
        sl.addEventListener('input', () => {
            state[key]     = parseFloat(sl.value);
            vl.textContent = fmt(state[key]);
        });
    }

    wireSlider('sl-pixel',     'val-pixel',     'pixelSize',     v => Math.round(v));
    wireSlider('sl-threshold', 'val-threshold', 'threshold',     v => v.toFixed(2));
    wireSlider('sl-radius',    'val-radius',    'radius',        v => v.toFixed(2));
    wireSlider('sl-gooeyness', 'val-gooeyness', 'gooeyness',     v => v.toFixed(2));
    wireSlider('sl-line',      'val-line',      'lineThickness', v => v.toFixed(1));

    // ── Shadow mode toggle ───────────────────────────────────────────────────

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.mode = parseInt(btn.dataset.mode);
        });
    });

    // ── Pause / Play ──────────────────────────────────────────────────────────

    const pauseBtn = document.getElementById('btn-pause-play');
    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        if (paused) {
            stopLoop();
            pauseBtn.querySelector('.btn-label').textContent = 'Resume';
            pauseBtn.querySelector('.btn-icon').textContent  = '▶';
            pauseBtn.classList.add('paused');
        } else {
            startLoop();
            pauseBtn.querySelector('.btn-label').textContent = 'Pause';
            pauseBtn.querySelector('.btn-icon').textContent  = '⏸';
            pauseBtn.classList.remove('paused');
        }
    });

    // ── Export PNG ────────────────────────────────────────────────────────────

    document.getElementById('btn-export-png').addEventListener('click', () => {
        render();
        const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const link = document.createElement('a');
        link.download = `halftone_${ts}.png`;
        link.href     = canvas.toDataURL('image/png');
        link.click();
    });

    // ── Export video ──────────────────────────────────────────────────────────

    let recorder  = null;
    let recChunks = [];

    const recBtn = document.getElementById('btn-record');
    const recInd = document.getElementById('rec-indicator');

    recBtn.addEventListener('click', () => {
        if (recorder?.state === 'recording') {
            recorder.stop();
        } else {
            recChunks  = [];
            const stream   = canvas.captureStream(60);
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
                ? 'video/webm;codecs=vp9' : 'video/webm';

            recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 50_000_000,
            });

            recorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
            recorder.onstop = async () => {
                const blob = new Blob(recChunks, { type: 'video/webm' });
                const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

                recInd.classList.remove('hidden');
                recInd.querySelector('span:last-child').textContent = 'Converting to MP4…';
                recBtn.querySelector('.btn-label').textContent = 'Converting…';
                recBtn.disabled = true;

                try {
                    const { createFFmpeg, fetchFile } = FFmpeg;
                    const ffmpeg = createFFmpeg({ log: false });
                    await ffmpeg.load();

                    ffmpeg.FS('writeFile', 'input.webm', await fetchFile(blob));
                    await ffmpeg.run(
                        '-i', 'input.webm',
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-crf', '18',
                        '-pix_fmt', 'yuv420p',   // required for compatibility
                        'output.mp4'
                    );
                    const data    = ffmpeg.FS('readFile', 'output.mp4');
                    const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });

                    const link    = document.createElement('a');
                    link.download = `halftone_${ts}.mp4`;
                    link.href     = URL.createObjectURL(mp4Blob);
                    link.click();

                } catch (err) {
                    console.error('MP4 conversion failed, falling back to WebM:', err);
                    const link    = document.createElement('a');
                    link.download = `halftone_${ts}.webm`;
                    link.href     = URL.createObjectURL(blob);
                    link.click();
                }

                recInd.classList.add('hidden');
                recInd.querySelector('span:last-child').textContent = 'Recording…';
                recBtn.querySelector('.btn-label').textContent = 'Record video';
                recBtn.querySelector('.btn-icon').textContent  = '⏺';
                recBtn.disabled = false;
            };

            recorder.start();
            recInd.classList.remove('hidden');
            recBtn.querySelector('.btn-label').textContent = 'Stop recording';
            recBtn.querySelector('.btn-icon').textContent  = '⏹';
        }
    });

    // ── Start ─────────────────────────────────────────────────────────────────

    startLoop();

}

// Boot with user-friendly error on failure (typically missing HTTP server)
boot().catch(err => {
    document.body.innerHTML = `
        <div style="
            color: #c05858;
            padding: 48px;
            font-family: 'DM Mono', monospace;
            font-size: 13px;
            line-height: 1.7;
            background: #080808;
            height: 100dvh;
        ">
            <b>Startup error:</b><br>
            ${err.message}<br><br>
            Run via a local server:<br>
            <code style="color:#9baa1f">python3 -m http.server 8080</code>
        </div>`;
});
