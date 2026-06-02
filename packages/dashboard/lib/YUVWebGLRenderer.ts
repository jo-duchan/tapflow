// Vertex shader: maps NDC [-1,1] quad to UV [0,1], Y-flipped so row-0 (top of the
// decoded image) lands at the top of the canvas (matches WebGLVideoRenderer).
const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

// Fragment shader: samples the Y/U/V planes and converts BT.709 *limited* range to
// RGB. The iOS encoder signals BT.709 limited (Y∈[16,235], C∈[16,240]); matching it
// here keeps color fidelity (see project_android_color_fidelity — do not over-saturate).
// Texture .r returns byte/255, so the offsets/scales below fold the 255 factor in.
const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_texY;
uniform sampler2D u_texU;
uniform sampler2D u_texV;
out vec4 out_color;
void main() {
  float Y = (texture(u_texY, v_uv).r - 0.0627451) * 1.1643836; // (y-16/255)*255/219
  float U = (texture(u_texU, v_uv).r - 0.5019608) * 1.1383929; // (u-128/255)*255/224
  float V = (texture(u_texV, v_uv).r - 0.5019608) * 1.1383929;
  float r = Y + 1.5748 * V;
  float g = Y - 0.1873 * U - 0.4681 * V;
  float b = Y + 1.8556 * U;
  out_color = vec4(r, g, b, 1.0);
}`

interface GLState {
  gl: WebGL2RenderingContext
  program: WebGLProgram
  texY: WebGLTexture
  texU: WebGLTexture
  texV: WebGLTexture
  vao: WebGLVertexArrayObject
}

function makePlaneTexture(gl: WebGL2RenderingContext, unit: number, uniform: string, program: WebGLProgram): WebGLTexture {
  const tex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.uniform1i(gl.getUniformLocation(program, uniform), unit)
  return tex
}

function initGLState(canvas: HTMLCanvasElement): GLState | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true, // required for captureStream() recording
  })
  if (!gl) return null

  const mkShader = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }

  const prog = gl.createProgram()!
  const vs = mkShader(gl.VERTEX_SHADER, VERT)
  const fs = mkShader(gl.FRAGMENT_SHADER, FRAG)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  gl.useProgram(prog)

  // Fullscreen quad: two triangles covering NDC [-1, 1]
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1, -1,  1,
    -1,  1,  1, -1,  1,  1,
  ]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  // R8 single-channel textures, one per plane. UNPACK_ALIGNMENT=1 so rows whose
  // width isn't a multiple of 4 upload without padding skew.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  const texY = makePlaneTexture(gl, 0, 'u_texY', prog)
  const texU = makePlaneTexture(gl, 1, 'u_texU', prog)
  const texV = makePlaneTexture(gl, 2, 'u_texV', prog)

  return { gl, program: prog, texY, texU, texV, vao }
}

/**
 * Renders I420 (YUV420 planar) frames — as produced by the tinyh264 WASM decoder —
 * to a canvas via WebGL2. Software decoders can't make a WebCodecs VideoFrame
 * (secure-context only) and emit raw YUV, so this is the WASM tier's renderer,
 * separate from WebGLVideoRenderer (which uploads VideoFrames directly).
 *
 * Owns its render surface so the viewer stays decoder-agnostic.
 */
export class YUVWebGLRenderer {
  private state: GLState | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {}

  init(): boolean {
    this.state = initGLState(this.canvas)
    return this.state !== null
  }

  /**
   * Uploads one I420 frame (combined Y+U+V buffer) and renders it.
   * Returns the frame dimensions on success so callers can track size.
   */
  drawI420(data: Uint8Array, width: number, height: number): { width: number; height: number } | null {
    const s = this.state
    if (!s) return null

    const { gl } = s
    const cw = (width + 1) >> 1
    const ch = (height + 1) >> 1
    const ySize = width * height
    const cSize = cw * ch
    const yPlane = data.subarray(0, ySize)
    const uPlane = data.subarray(ySize, ySize + cSize)
    const vPlane = data.subarray(ySize + cSize, ySize + 2 * cSize)

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
      gl.viewport(0, 0, width, height)
    }

    const upload = (unit: number, tex: WebGLTexture, pw: number, ph: number, plane: Uint8Array) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, plane)
    }
    upload(0, s.texY, width, height, yPlane)
    upload(1, s.texU, cw, ch, uPlane)
    upload(2, s.texV, cw, ch, vPlane)

    gl.bindVertexArray(s.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)

    return { width, height }
  }

  dispose(): void {
    const s = this.state
    if (!s) return
    s.gl.deleteTexture(s.texY)
    s.gl.deleteTexture(s.texU)
    s.gl.deleteTexture(s.texV)
    s.gl.deleteVertexArray(s.vao)
    s.gl.deleteProgram(s.program)
    this.state = null
  }
}
