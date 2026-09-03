/* ==========================================================================
   seros-gl.js — the hero, as an actual sheet of paper in three dimensions

   Not a filter on an <img>: a perspective camera, a subdivided plane of real
   geometry, and a printed sheet lying on the page. The engraving is pressed
   into the fibre — the ink is displaced geometry, not a dark pixel — so the
   raking light catches the edge of every line as the sheet turns under your
   pointer. The guilloche is printed onto the same sheet, so the ornament
   turns with it.

   Contract with the page:
   - Mounts into [data-sheet], which must contain the <img> it prints from.
     The <img> stays in the markup for its alt text and for every reader who
     never gets this far.
   - No WebGL, no vertex texture fetch, a shader that will not compile, a
     reader who asked for less motion, or this file failing to load: the
     page is the flat image it has always been.
   ========================================================================== */
(function () {
  'use strict';

  var host = document.querySelector('[data-sheet]');
  if (!host) return;
  var img = host.querySelector('img');
  if (!img) return;

  var reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');

  var gl = null;
  try {
    var opts = { alpha: true, antialias: true, depth: true, stencil: false,
                 premultipliedAlpha: false, powerPreference: 'high-performance' };
    gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts) ||
         canvas.getContext('experimental-webgl', opts);
  } catch (e) { gl = null; }
  if (!gl) return;

  // The ink is displaced in the vertex shader, which needs the plate texture
  // readable from a vertex. Every GPU made this decade can; some cannot.
  if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 1) return;

  /* ---------------------------------------------------------------- maths */
  function mat4() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }

  function perspective(out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out[0]=f/aspect; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=f; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=(far+near)*nf; out[11]=-1;
    out[12]=0; out[13]=0; out[14]=2*far*near*nf; out[15]=0;
    return out;
  }

  function lookAt(out, eye, at, up) {
    var z0=eye[0]-at[0], z1=eye[1]-at[1], z2=eye[2]-at[2];
    var l=1/Math.hypot(z0,z1,z2); z0*=l; z1*=l; z2*=l;
    var x0=up[1]*z2-up[2]*z1, x1=up[2]*z0-up[0]*z2, x2=up[0]*z1-up[1]*z0;
    l=Math.hypot(x0,x1,x2); l = l ? 1/l : 0; x0*=l; x1*=l; x2*=l;
    var y0=z1*x2-z2*x1, y1=z2*x0-z0*x2, y2=z0*x1-z1*x0;
    out[0]=x0; out[1]=y0; out[2]=z0; out[3]=0;
    out[4]=x1; out[5]=y1; out[6]=z1; out[7]=0;
    out[8]=x2; out[9]=y2; out[10]=z2; out[11]=0;
    out[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]);
    out[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]);
    out[14]=-(z0*eye[0]+z1*eye[1]+z2*eye[2]);
    out[15]=1;
    return out;
  }

  // Model matrix for the sheet: yaw, pitch, and a translation. Column-major,
  // written out rather than multiplied, because it is the only one we need.
  function compose(out, tx, ty, tz, ry, rx, s) {
    var cy=Math.cos(ry), sy=Math.sin(ry), cx=Math.cos(rx), sx=Math.sin(rx);
    out[0]=cy*s;      out[1]=0;      out[2]=-sy*s;     out[3]=0;
    out[4]=sy*sx*s;   out[5]=cx*s;   out[6]=cy*sx*s;   out[7]=0;
    out[8]=sy*cx*s;   out[9]=-sx*s;  out[10]=cy*cx*s;  out[11]=0;
    out[12]=tx;       out[13]=ty;    out[14]=tz;       out[15]=1;
    return out;
  }

  function normalMat3(out, m) {
    // Rotation and uniform scale only, so the upper 3x3 needs no inverse.
    out[0]=m[0]; out[1]=m[1]; out[2]=m[2];
    out[3]=m[4]; out[4]=m[5]; out[5]=m[6];
    out[6]=m[8]; out[7]=m[9]; out[8]=m[10];
    return out;
  }

  /* -------------------------------------------------------------- shaders */
  var COMMON = [
    'float plateHeight(sampler2D plate, vec2 uv) {',
    '  vec4 c = texture2D(plate, uv);',
    '  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));',
    '  return (1.0 - lum) * c.a;',      // 1 where the engraving is solid ink
    '}',
    // A sheet does not lie perfectly flat. A shallow cylindrical bend plus a
    // lift towards the top and bottom edges, so the silhouette is a curve.
    'float sheetCurl(vec2 xy, float amount) {',
    '  return (1.0 - cos(xy.x * 1.25)) * amount + xy.y * xy.y * amount * 0.42;',
    '}'
  ].join('\n');

  var VS = [
    'precision highp float;',
    'attribute vec2 aXY;',
    'uniform mat4 uProj, uView, uModel;',
    'uniform mat3 uNormalMat;',
    'uniform sampler2D uPlate;',
    'uniform float uEmboss, uCurl;',
    'varying vec2 vUV;',
    'varying vec3 vWorld;',
    COMMON,
    'void main() {',
    '  vec2 uv = aXY * 0.5 + 0.5;',
    '  vUV = uv;',
    '  float h = plateHeight(uPlate, uv);',
    // Ink is pressed into the sheet, so it sits below the surface.
    '  float z = -h * uEmboss + sheetCurl(aXY, uCurl);',
    '  vec4 world = uModel * vec4(aXY, z, 1.0);',
    '  vWorld = world.xyz;',
    '  gl_Position = uProj * uView * world;',
    '}'
  ].join('\n');

  var FS = [
    'precision highp float;',
    'varying vec2 vUV;',
    'varying vec3 vWorld;',
    'uniform sampler2D uPlate;',
    'uniform mat3 uNormalMat;',
    'uniform vec3 uEye, uInk, uSteel, uSky, uPaper, uSheet;',
    'uniform vec2 uTexel;',
    'uniform float uTime, uEmboss, uCurl, uRelief, uOrnament, uPixel;',
    'uniform vec2 uLight;',
    COMMON,

    'float hash(vec2 p) {',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',

    // The guilloche, printed on the sheet rather than floating behind it.
    'float rosette(vec2 p, float petals, float pitch, float depth, float phase, float px) {',
    '  float r = max(length(p), 0.04);',
    '  float a = atan(p.y, p.x);',
    '  float bulge = 0.35 + 0.65 * r;',
    '  float rr = r + depth * sin(a * petals + phase) * bulge;',
    '  float w = pitch * px * (1.0 + depth * petals * bulge / r) * 0.9 + 0.0008;',
    '  float line = 1.0 - smoothstep(0.0, w, abs(sin(rr * pitch + phase * 0.5)) - 0.02);',
    '  return line * (1.0 - smoothstep(0.45, 1.10, w));',
    '}',

    'void main() {',
    '  vec2 uv = vUV;',
    '  float h = plateHeight(uPlate, uv);',

    // Surface normal from the engraving itself: the walls of every pressed
    // line are what the raking light actually catches.
    '  float hl = plateHeight(uPlate, uv - vec2(uTexel.x, 0.0));',
    '  float hr = plateHeight(uPlate, uv + vec2(uTexel.x, 0.0));',
    '  float hd = plateHeight(uPlate, uv - vec2(0.0, uTexel.y));',
    '  float hu = plateHeight(uPlate, uv + vec2(0.0, uTexel.y));',
    '  vec3 N = vec3((hl - hr) * uRelief, (hd - hu) * uRelief, 1.0);',
    // Plus the slope of the curl, and the tooth of the paper itself.
    '  vec2 xy = uv * 2.0 - 1.0;',
    '  N.x += sin(xy.x * 1.25) * 1.25 * uCurl * 1.4;',
    '  N.y += -xy.y * 2.0 * uCurl * 0.42 * 1.4;',
    '  float fibre = hash(floor(uv / uTexel * 0.6));',
    '  N.xy += (vec2(hash(floor(uv / uTexel * 0.6) + 3.1), fibre) - 0.5) * 0.055;',
    '  N = normalize(uNormalMat * normalize(N));',

    '  vec3 V = normalize(uEye - vWorld);',
    '  vec3 L = normalize(vec3(uLight.x, uLight.y, 0.82));',
    '  float diff = max(dot(N, L), 0.0);',
    '  vec3 H = normalize(L + V);',
    '  float spec = pow(max(dot(N, H), 0.0), 26.0);',
    '  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.2);',

    // Ink lies in the trough, so it is occluded by its own walls.
    '  float ao = 1.0 - h * 0.16;',

    // What is printed here: sheet white, then the ornament, then the ink.
    '  float px = uPixel;',
    '  vec2 g = (uv - vec2(0.5, 0.46)) * 2.0;',
    '  float o1 = rosette(g * 1.00, 9.0, 26.0, 0.024,  uTime * 0.045, px);',
    '  float o2 = rosette((g - vec2(0.05, 0.04)) * 1.35, 6.0, 17.0, 0.020, -uTime * 0.032, px * 1.35);',
    '  float o3 = rosette((g + vec2(0.03, 0.03)) * 0.62, 14.0, 39.0, 0.012,  uTime * 0.021, px * 0.62);',
    '  float orn = (o1 * 0.46 + o2 * 0.34 + o3 * 0.38) * uOrnament;',
    '  orn *= smoothstep(1.15, 0.15, length(g * vec2(0.80, 0.95)));',
    '  orn *= 1.0 - smoothstep(0.05, 0.35, h);',       // the figure wins

    '  vec3 albedo = mix(uSheet, uPaper, 0.30 + 0.14 * (1.0 - uv.y));',
    '  albedo = mix(albedo, mix(uSteel, uSky, 0.30), clamp(orn * 0.85, 0.0, 1.0));',
    '  albedo = mix(albedo, uInk, smoothstep(0.03, 0.62, h));',

    // Paper is matte and slightly translucent; ink is matte and flat.
    '  float ink = smoothstep(0.10, 0.70, h);',
    '  vec3 col = albedo * (0.74 + 0.40 * diff) * ao;',
    '  col += vec3(1.0, 0.99, 0.96) * spec * (1.0 - ink * 0.72) * 0.30;',
    '  col += uSky * fres * 0.10 * (1.0 - ink);',
    '  col += (hash(gl_FragCoord.xy + floor(uTime * 6.0)) - 0.5) * 0.022;',

    // The deckle: the last millimetre of a sheet is thinner and catches more
    // light, and beyond it there is no sheet at all.
    '  vec2 e = abs(xy);',
    '  float edge = max(e.x, e.y);',
    '  col += vec3(0.035) * smoothstep(0.90, 1.0, edge);',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  // The shadow the sheet casts on the page: the same plane, pushed back and
  // down, drawn flat and soft. Cheap, and it is what sells "lying on top of".
  var SHADOW_VS = [
    'precision highp float;',
    'attribute vec2 aXY;',
    'uniform mat4 uProj, uView, uModel;',
    'varying vec2 vXY;',
    'void main() {',
    '  vXY = aXY;',
    '  gl_Position = uProj * uView * uModel * vec4(aXY, 0.0, 1.0);',
    '}'
  ].join('\n');

  var SHADOW_FS = [
    'precision highp float;',
    'varying vec2 vXY;',
    'uniform vec3 uInk;',
    'uniform float uAmount;',
    'void main() {',
    '  float d = max(abs(vXY.x), abs(vXY.y));',
    '  float a = (1.0 - smoothstep(0.05, 1.0, d)) * uAmount;',
    '  if (a < 0.003) discard;',
    '  gl_FragColor = vec4(uInk, a);',
    '}'
  ].join('\n');

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'compile failed');
    }
    return s;
  }

  function program(vsSrc, fsSrc) {
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, 'aXY');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    }
    return p;
  }

  var progSheet, progShadow;
  try {
    progSheet = program(VS, FS);
    progShadow = program(SHADOW_VS, SHADOW_FS);
  } catch (err) { return; }

  /* ------------------------------------------------------------- geometry */
  // A subdivided plane. The ink is real displacement, so the mesh has to be
  // fine enough to carry it; 160 squares a side is 51k triangles, which is
  // nothing for a GPU and everything for the silhouette.
  var N = 160;
  var verts = new Float32Array((N + 1) * (N + 1) * 2);
  var k = 0;
  for (var y = 0; y <= N; y++) {
    for (var x = 0; x <= N; x++) {
      verts[k++] = (x / N) * 2 - 1;
      verts[k++] = (y / N) * 2 - 1;
    }
  }
  var quads = N * N;
  var idx = quads * 6 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  var useUint32 = quads * 6 > 65535;
  if (useUint32 && !(gl.getExtension('OES_element_index_uint') ||
                     (typeof WebGL2RenderingContext !== 'undefined' &&
                      gl instanceof WebGL2RenderingContext))) {
    return;                                   // cannot index a mesh this fine
  }
  k = 0;
  for (var j = 0; j < N; j++) {
    for (var i = 0; i < N; i++) {
      var a = j * (N + 1) + i, b = a + 1, c2 = a + N + 1, d = c2 + 1;
      idx[k++] = a; idx[k++] = c2; idx[k++] = b;
      idx[k++] = b; idx[k++] = c2; idx[k++] = d;
    }
  }
  var vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  var ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  var indexType = useUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

  // The shadow is a single flat quad; it needs none of the mesh's detail.
  var quadVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  /* -------------------------------------------------------------- texture */
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  var texSize = 1024, ready = false;

  function brand(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var m = /^#([0-9a-f]{6})$/i.exec(v);
    if (!m) return fallback;
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  var C = {
    ink: brand('--seros-ink', [0.157, 0.188, 0.325]),
    steel: brand('--seros-steel', [0.376, 0.541, 0.804]),
    sky: brand('--seros-sky', [0.722, 0.855, 1.0]),
    paper: brand('--seros-paper', [0.929, 0.906, 0.871]),
    sheet: brand('--seros-white', [0.984, 0.980, 0.969])
  };

  /* --------------------------------------------------------------- state */
  var proj = mat4(), view = mat4(), model = mat4(), nrm = new Float32Array(9);
  var eye = [0, 0, 3.35];
  var aim = { x: 0, y: 0 }, look = { x: 0, y: 0 };
  var scroll = 0, t0 = performance.now(), visible = true, running = false;
  var uS = {}, uH = {};
  ['uProj','uView','uModel','uNormalMat','uPlate','uEmboss','uCurl','uRelief','uOrnament',
   'uEye','uInk','uSteel','uSky','uPaper','uSheet','uTexel','uTime','uLight','uPixel']
    .forEach(function (n) { uS[n] = gl.getUniformLocation(progSheet, n); });
  ['uProj','uView','uModel','uInk','uAmount']
    .forEach(function (n) { uH[n] = gl.getUniformLocation(progShadow, n); });

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
  }

  function draw() {
    if (!ready) return;
    resize();
    var aspect = canvas.width / Math.max(1, canvas.height);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    var t = reduced ? 8.0 : (performance.now() - t0) * 0.001;
    // Idle drift, so the sheet is alive before anyone touches it.
    var idleY = reduced ? 0 : Math.sin(t * 0.31) * 0.045;
    var idleX = reduced ? 0 : Math.cos(t * 0.24) * 0.030;

    perspective(proj, 30 * Math.PI / 180, aspect, 0.1, 40);
    lookAt(view, eye, [0, 0, 0], [0, 1, 0]);

    var ry = -0.20 + look.x * 0.34 + idleY;
    var rx = 0.13 - look.y * 0.26 + idleX + scroll * 0.20;
    // Fit the sheet to whatever box the layout gives it.
    var fit = 0.66 * Math.min(1.0, aspect * 1.05);

    // Shadow first, on the page under the sheet.
    gl.useProgram(progShadow);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    compose(model, ry * 0.14, -0.10 - rx * 0.08, -0.22, ry * 0.8, rx * 0.8, fit * 1.25);
    gl.uniformMatrix4fv(uH.uProj, false, proj);
    gl.uniformMatrix4fv(uH.uView, false, view);
    gl.uniformMatrix4fv(uH.uModel, false, model);
    gl.uniform3f(uH.uInk, C.ink[0], C.ink[1], C.ink[2]);
    gl.uniform1f(uH.uAmount, 0.26);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);

    // The sheet.
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.useProgram(progSheet);
    compose(model, 0, 0, 0, ry, rx, fit);
    normalMat3(nrm, model);
    gl.uniformMatrix4fv(uS.uProj, false, proj);
    gl.uniformMatrix4fv(uS.uView, false, view);
    gl.uniformMatrix4fv(uS.uModel, false, model);
    gl.uniformMatrix3fv(uS.uNormalMat, false, nrm);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uS.uPlate, 0);
    gl.uniform1f(uS.uEmboss, 0.018);
    gl.uniform1f(uS.uCurl, 0.055);
    gl.uniform1f(uS.uRelief, 5.0);
    gl.uniform1f(uS.uOrnament, 1.0);
    gl.uniform1f(uS.uTime, t);
    gl.uniform2f(uS.uTexel, 1 / texSize, 1 / texSize);
    // One screen pixel, measured in the sheet's own units, so the engraved
    // ornament keeps one-pixel lines at any size or device ratio.
    var halfView = Math.tan(15 * Math.PI / 180) * eye[2];
    gl.uniform1f(uS.uPixel, 1 / ((canvas.height * 0.5) * (fit / halfView)));
    gl.uniform2f(uS.uLight, -0.34 + look.x * 0.55, 0.42 + look.y * 0.45);
    gl.uniform3f(uS.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(uS.uInk, C.ink[0], C.ink[1], C.ink[2]);
    gl.uniform3f(uS.uSteel, C.steel[0], C.steel[1], C.steel[2]);
    gl.uniform3f(uS.uSky, C.sky[0], C.sky[1], C.sky[2]);
    gl.uniform3f(uS.uPaper, C.paper[0], C.paper[1], C.paper[2]);
    gl.uniform3f(uS.uSheet, C.sheet[0], C.sheet[1], C.sheet[2]);
    gl.drawElements(gl.TRIANGLES, quads * 6, indexType, 0);
  }

  function frame() {
    if (!running) return;
    look.x += (aim.x - look.x) * 0.06;
    look.y += (aim.y - look.y) * 0.06;
    draw();
    if (reduced || !visible) { running = false; return; }
    window.requestAnimationFrame(frame);
  }
  function wake() {
    if (running || !visible) return;
    running = true;
    window.requestAnimationFrame(frame);
  }

  /* --------------------------------------------------------- the page fit */
  // The sheet turns, so it needs more room than the flat image occupied.
  canvas.style.cssText = 'position:absolute;left:-14%;top:-14%;width:128%;height:128%;' +
    'display:block;pointer-events:none;opacity:0;';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(canvas);

  function upload() {
    if (!img.naturalWidth) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } catch (e) { return; }
    // Without mipmaps a 1100px plate resampled to ~380 screen pixels crawls
    // with aliasing. WebGL2 can mip a non-power-of-two texture; WebGL1 cannot,
    // and gets the honest, slightly harder edges.
    var isGL2 = typeof WebGL2RenderingContext !== 'undefined' &&
                gl instanceof WebGL2RenderingContext;
    if (isGL2) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    texSize = img.naturalWidth;
    ready = true;
    host.classList.add('sheet-live');
    img.style.visibility = 'hidden';
    window.requestAnimationFrame(function () {
      canvas.style.transition = 'opacity 1s ease';
      canvas.style.opacity = '1';
    });
    resize();
    wake();
  }
  if (img.complete) { upload(); } else { img.addEventListener('load', upload); }

  window.addEventListener('pointermove', function (e) {
    var r = host.getBoundingClientRect();
    aim.x = Math.max(-1.6, Math.min(1.6, (e.clientX - (r.left + r.width / 2)) / Math.max(1, r.width)));
    aim.y = Math.max(-1.6, Math.min(1.6, (e.clientY - (r.top + r.height / 2)) / Math.max(1, r.height)));
    wake();
  }, { passive: true });

  window.addEventListener('scroll', function () {
    var r = host.getBoundingClientRect();
    scroll = Math.max(-1, Math.min(1, -r.top / Math.max(1, r.height)));
    wake();
  }, { passive: true });

  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); wake(); }).observe(host);
  } else {
    window.addEventListener('resize', function () { resize(); wake(); }, { passive: true });
  }
  if (window.IntersectionObserver) {
    visible = false;
    new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
      if (visible) wake();
    }, { threshold: 0 }).observe(host);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });
}());
