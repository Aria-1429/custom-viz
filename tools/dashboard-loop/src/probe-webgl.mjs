// ヘッドレス Chromium で WebGL2 が実際に描けるかを確かめる（Splunk 不要）。
import { chromium } from 'playwright';

const HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#111">
<canvas id="c" width="600" height="300"></canvas>
<div id="info" style="color:#eee;font:14px monospace;padding:8px"></div>
<script>
const gl = document.getElementById('c').getContext('webgl2');
const info = document.getElementById('info');
if (!gl) { info.textContent = 'WEBGL2_UNAVAILABLE'; }
else {
  const vs = \`#version 300 es
  in vec2 p; out vec2 uv;
  void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }\`;
  const fs = \`#version 300 es
  precision highp float; in vec2 uv; out vec4 o;
  void main(){
    // フレネル風のグラデーション + 円（SDF）
    float d = length(uv-vec2(0.5))*2.0;
    vec3 col = mix(vec3(0.1,0.7,1.0), vec3(1.0,0.3,0.6), uv.x);
    col *= smoothstep(1.0, 0.2, d);
    o = vec4(col, 1.0);
  }\`;
  const mk=(t,s)=>{const sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh;};
  const pr=gl.createProgram();
  gl.attachShader(pr,mk(gl.VERTEX_SHADER,vs)); gl.attachShader(pr,mk(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(pr); gl.useProgram(pr);
  const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const loc=gl.getAttribLocation(pr,'p'); gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  gl.drawArrays(gl.TRIANGLES,0,3);
  const px=new Uint8Array(4); gl.readPixels(300,150,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const dbg=gl.getExtension('WEBGL_debug_renderer_info');
  info.textContent = 'OK center_px=' + [...px].join(',') +
    ' | GLSL=' + gl.getParameter(gl.SHADING_LANGUAGE_VERSION) +
    ' | renderer=' + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}
</script>`;

const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 620, height: 380 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
await page.setContent(HTML, { waitUntil: 'load' });
await page.waitForTimeout(1500);
console.log(await page.locator('#info').textContent());
await page.screenshot({ path: process.argv[2] });
await browser.close();
