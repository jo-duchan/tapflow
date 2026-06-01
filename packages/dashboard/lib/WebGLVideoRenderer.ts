import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'

// Vertex shader: maps NDC [-1,1] quad to UV [0,1], Y-flipped to match VideoFrame orientation.
// VideoFrame row-0 is top-of-image; WebGL textures store row-0 at bottom, so we flip v.
const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 out_color;
void main() {
  out_color = texture(u_tex, v_uv);
}`

interface GLState {
  gl: WebGL2RenderingContext
  program: WebGLProgram
  tex: WebGLTexture
  vao: WebGLVertexArrayObject
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

  const tex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0)

  return { gl, program: prog, tex, vao }
}

/**
 * Renders H.264 VideoFrames (from WebCodecs) to a canvas via WebGL2.
 *
 * Plain class so a decoder can own its render surface. The React hook
 * `useWebGLRenderer` below is a thin wrapper for components that hold a canvas ref.
 */
export class WebGLVideoRenderer {
  private state: GLState | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {}

  init(): boolean {
    this.state = initGLState(this.canvas)
    return this.state !== null
  }

  // Uploads VideoFrame directly to GPU texture (no CPU copy) and renders.
  // Returns the frame dimensions on success so callers can track videoSize.
  drawFrame(frame: VideoFrame): { width: number; height: number } | null {
    const s = this.state
    if (!s) { frame.close(); return null }

    const fw = frame.displayWidth
    const fh = frame.displayHeight
    try {
      if (this.canvas.width !== fw || this.canvas.height !== fh) {
        this.canvas.width = fw
        this.canvas.height = fh
        s.gl.viewport(0, 0, fw, fh)
      }

      s.gl.activeTexture(s.gl.TEXTURE0)
      s.gl.bindTexture(s.gl.TEXTURE_2D, s.tex)
      s.gl.texImage2D(s.gl.TEXTURE_2D, 0, s.gl.RGBA, s.gl.RGBA, s.gl.UNSIGNED_BYTE, frame)

      s.gl.bindVertexArray(s.vao)
      s.gl.drawArrays(s.gl.TRIANGLES, 0, 6)
      s.gl.bindVertexArray(null)
      s.gl.bindTexture(s.gl.TEXTURE_2D, null)

      return { width: fw, height: fh }
    } finally {
      frame.close() // always release the GPU frame, even if a GL call throws
    }
  }

  dispose(): void {
    const s = this.state
    if (!s) return
    s.gl.deleteTexture(s.tex)
    s.gl.deleteVertexArray(s.vao)
    s.gl.deleteProgram(s.program)
    this.state = null
  }
}

export function useWebGLRenderer(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const rendererRef = useRef<WebGLVideoRenderer | null>(null)

  const init = useCallback((): boolean => {
    const canvas = canvasRef.current
    if (!canvas) return false
    const r = new WebGLVideoRenderer(canvas)
    const ok = r.init()
    rendererRef.current = ok ? r : null
    return ok
  }, [canvasRef])

  const dispose = useCallback(() => {
    rendererRef.current?.dispose()
    rendererRef.current = null
  }, [])

  const drawFrame = useCallback((frame: VideoFrame): { width: number; height: number } | null => {
    const r = rendererRef.current
    if (!r) { frame.close(); return null }
    return r.drawFrame(frame)
  }, [])

  return { init, dispose, drawFrame }
}
