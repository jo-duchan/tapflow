import * as z from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { parseFlow, runFlow, type FlowDriver } from '@tapflowio/flow-runner'
import type { TapflowClient } from './client.js'

// Adapts TapflowClient (this process's single relay connection) to the
// flow-runner engine surface, so run_flow shares the session the agent
// already joined via connect_device instead of opening a second one.
function makeFlowDriver(client: TapflowClient, sessionId: string, buildId?: number): FlowDriver {
  return {
    queryUITree: () => client.queryUITree(sessionId),
    tap: async (x, y) => client.tap(sessionId, x, y),
    swipe: (from, to, durationMs) => client.swipe(sessionId, from[0], from[1], to[0], to[1], durationMs),
    inputText: async (text) => client.typeText(sessionId, text),
    pressKey: async (code) => client.pressKey(sessionId, code),
    openUrl: (url) => client.openUrl(sessionId, url),
    launchApp: async () => {
      if (buildId === undefined) throw new Error('this flow uses launchApp — pass buildId (see list_builds)')
      await client.launchApp(sessionId, buildId)
    },
    clearState: (appId) => client.clearState(sessionId, appId),
    screenshot: () => client.screenshot(sessionId),
  }
}

function getImageDimensions(buf: Buffer, format: string): { width: number; height: number } | null {
  if (format === 'png' && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (format === 'jpeg') {
    for (let i = 2; i < buf.length - 8; i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xc0) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
    }
  }
  return null
}

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean }

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export function registerTools(server: McpServer, client: TapflowClient): void {
  server.registerTool(
    'list_builds',
    { description: 'List all apps and their builds available on the relay. Use this to find buildId before calling install_app or launch_app.' },
    async () => {
      try {
        const apps = await client.listBuilds()
        return ok(JSON.stringify(apps, null, 2))
      } catch (e) {
        return err(`list_builds failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'list_devices',
    { description: 'List all available simulators and emulators registered on the tapflow relay.' },
    async () => {
      try {
        const sessions = await client.listDevices()
        return ok(JSON.stringify(sessions, null, 2))
      } catch (e) {
        return err(`list_devices failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'connect_device',
    {
      description: 'Join a device session so you can control it. Required before boot_device, install_app, and launch_app.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
      },
    },
    async ({ sessionId }) => {
      try {
        await client.connectDevice(sessionId)
        return ok(JSON.stringify({ connected: true, sessionId }))
      } catch (e) {
        return err(`connect_device failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'disconnect_device',
    {
      description: 'End a device session and release the connection.',
      inputSchema: {
        sessionId: z.string().describe('Session ID to disconnect'),
      },
    },
    async ({ sessionId }) => {
      try {
        client.disconnectDevice(sessionId)
        return ok(JSON.stringify({ disconnected: true, sessionId }))
      } catch (e) {
        return err(`disconnect_device failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'boot_device',
    {
      description: 'Boot a simulator/emulator. Requires connect_device first. Waits up to 30 seconds for the device to be ready.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        deviceId: z.string().describe('Device ID from list_devices'),
      },
    },
    async ({ sessionId, deviceId }) => {
      try {
        await client.bootDevice(sessionId, deviceId)
        return ok(JSON.stringify({ booted: true, sessionId, deviceId }))
      } catch (e) {
        return err(`boot_device failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'shutdown_device',
    {
      description:
        'Shut the session\'s booted simulator/emulator down — powers the device off to free resources or force a ' +
        'cold boot next time. Unlike disconnect_device (which only leaves the session, leaving the device running), ' +
        'this actually stops the device. Requires connect_device first. Waits up to 30 seconds.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        deviceId: z.string().describe('Device ID from list_devices'),
      },
    },
    async ({ sessionId, deviceId }) => {
      try {
        await client.shutdownDevice(sessionId, deviceId)
        return ok(JSON.stringify({ shutdown: true, sessionId, deviceId }))
      } catch (e) {
        return err(`shutdown_device failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'query_ui_tree',
    {
      description:
        'Query the accessibility tree of the current screen: interactive and text-bearing elements as ' +
        '{ role, label, identifier, frame, enabled, rawRole }. Frames are normalized 0-1 relative to the screen. ' +
        'Prefer this over guessing coordinates from a screenshot: to tap an element, multiply the frame center by the ' +
        'screenshot pixel size — x = (frame.x + frame.width / 2) * screenshotWidth, y = (frame.y + frame.height / 2) * screenshotHeight — ' +
        'and pass those pixel coordinates to the tap tool.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
      },
    },
    async ({ sessionId }) => {
      try {
        const elements = await client.queryUITree(sessionId)
        return ok(JSON.stringify({ count: elements.length, elements }, null, 2))
      } catch (e) {
        return err(`query_ui_tree failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'run_flow',
    {
      description:
        'Replay a tapflow flow (YAML) deterministically — no LLM in the loop. Use this for verified scenarios instead of ' +
        'tapping step by step: author the flow once, then replay it idempotently. Pass the YAML inline via "flow", or a ' +
        'file path via "path" (resolved from the MCP server process cwd). Steps: clearState / launchApp / tapOn / ' +
        'inputText / pressKey / swipe / scroll / openUrl / assertVisible / assertNotVisible. launchApp launches the ' +
        'buildId argument. Returns per-step results; on failure a screenshot is saved to a temp file.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices (connect_device first)'),
        flow: z.string().optional().describe('Flow YAML content (inline)'),
        path: z.string().optional().describe('Path to a flow YAML file (alternative to "flow")'),
        buildId: z.number().optional().describe('Build under test for the launchApp step (from list_builds)'),
      },
    },
    async ({ sessionId, flow, path: flowPath, buildId }) => {
      try {
        if ((flow === undefined) === (flowPath === undefined)) {
          return err('run_flow needs exactly one of "flow" (inline YAML) or "path"')
        }
        let yamlText: string
        if (flow !== undefined) {
          yamlText = flow
        } else {
          // Constrain file reads to the server cwd subtree — this tool loads
          // flow YAML, not arbitrary files. Anything else goes through "flow".
          const resolved = path.resolve(flowPath!)
          if (!resolved.startsWith(process.cwd() + path.sep)) {
            return err(`run_flow "path" must stay inside the MCP server working directory (${process.cwd()}) — pass the YAML inline via "flow" instead`)
          }
          yamlText = fs.readFileSync(resolved, 'utf-8')
        }
        const parsed = parseFlow(yamlText, flowPath ?? 'inline-flow.yaml')
        const driver = makeFlowDriver(client, sessionId, buildId)
        const result = await runFlow(parsed, driver)

        let screenshotPath: string | undefined
        if (result.failureScreenshot) {
          screenshotPath = path.join(os.tmpdir(), `tapflow-flow-failure-${Date.now()}.png`)
          fs.writeFileSync(screenshotPath, result.failureScreenshot)
        }
        return ok(JSON.stringify({
          name: result.name,
          status: result.status,
          durationMs: result.durationMs,
          steps: result.steps,
          ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
          ...(screenshotPath ? { failureScreenshotPath: screenshotPath } : {}),
        }, null, 2))
      } catch (e) {
        return err(`run_flow failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'screenshot',
    {
      description: 'Capture the current screen of a device. Returns the image so you can analyze it.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
      },
    },
    async ({ sessionId, format }) => {
      try {
        const fmt = format ?? 'png'
        const buf = await client.screenshot(sessionId, fmt)
        const mimeType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png'
        const ext = fmt === 'jpeg' ? 'jpg' : 'png'
        const filename = `tapflow-${sessionId.slice(0, 8)}-${Date.now()}.${ext}`
        const filePath = path.join(os.tmpdir(), filename)
        fs.writeFileSync(filePath, buf)
        const dims = getImageDimensions(buf, fmt)
        const dimText = dims ? ` (${dims.width}×${dims.height}px)` : ''
        return {
          content: [
            { type: 'image' as const, data: buf.toString('base64'), mimeType },
            { type: 'text' as const, text: `Screenshot saved: ${filePath}${dimText}` },
          ],
        }
      } catch (e) {
        return err(`screenshot failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tap',
    {
      description: 'Tap at a pixel coordinate matching the screenshot. Use the width and height from the screenshot tool response.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        x: z.number().describe('X pixel coordinate (from screenshot)'),
        y: z.number().describe('Y pixel coordinate (from screenshot, 0 = top)'),
        screenshotWidth: z.number().int().describe('Screenshot width in pixels (from screenshot tool)'),
        screenshotHeight: z.number().int().describe('Screenshot height in pixels (from screenshot tool)'),
      },
    },
    async ({ sessionId, x, y, screenshotWidth, screenshotHeight }) => {
      try {
        client.tap(sessionId, x / screenshotWidth, y / screenshotHeight)
        return ok(JSON.stringify({ tapped: true, x, y }))
      } catch (e) {
        return err(`tap failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'swipe',
    {
      description: 'Swipe from one pixel coordinate to another. Use the width and height from the screenshot tool response.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        startX: z.number().describe('Start X pixel coordinate (from screenshot)'),
        startY: z.number().describe('Start Y pixel coordinate (from screenshot, 0 = top)'),
        endX: z.number().describe('End X pixel coordinate (from screenshot)'),
        endY: z.number().describe('End Y pixel coordinate (from screenshot)'),
        screenshotWidth: z.number().int().describe('Screenshot width in pixels (from screenshot tool)'),
        screenshotHeight: z.number().int().describe('Screenshot height in pixels (from screenshot tool)'),
        durationMs: z.number().optional().describe('Swipe duration in milliseconds (default: 300)'),
      },
    },
    async ({ sessionId, startX, startY, endX, endY, screenshotWidth, screenshotHeight, durationMs }) => {
      try {
        await client.swipe(
          sessionId,
          startX / screenshotWidth,
          startY / screenshotHeight,
          endX / screenshotWidth,
          endY / screenshotHeight,
          durationMs,
        )
        return ok(JSON.stringify({ swiped: true, from: { x: startX, y: startY }, to: { x: endX, y: endY } }))
      } catch (e) {
        return err(`swipe failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'type_text',
    {
      description:
        'Type text into the currently focused input field (tap the field first). ' +
        'iOS supports arbitrary Unicode (pasted); Android supports ASCII only.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        text: z.string().describe('Text to type into the focused field'),
      },
    },
    async ({ sessionId, text }) => {
      try {
        await client.typeText(sessionId, text)
        return ok(JSON.stringify({ typed: true, text }))
      } catch (e) {
        return err(`type_text failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'press_key',
    {
      description:
        'Press a keyboard key by its KeyboardEvent.code name: "Enter", "Backspace", "Escape", "Tab", ' +
        '"ArrowUp"/"ArrowDown"/"ArrowLeft"/"ArrowRight", letters as "KeyA".."KeyZ", digits as "Digit0".."Digit9". ' +
        '"Return" is accepted as an alias for "Enter". Use type_text for entering text.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        key: z.string().describe('KeyboardEvent.code name (e.g. "Enter", "Backspace", "Escape")'),
      },
    },
    async ({ sessionId, key }) => {
      try {
        client.pressKey(sessionId, key)
        return ok(JSON.stringify({ pressed: true, key }))
      } catch (e) {
        return err(`press_key failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'press_button',
    {
      description:
        'Press a hardware button by a cross-platform name: "home", "lock", "volume_up", "volume_down" work on both ' +
        'platforms. Android also has "back" and "recent_apps" (no-ops on iOS). Other names map to a device button ' +
        'only if that device exposes one.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        button: z.string().describe('Button name (e.g. "home", "lock", "back")'),
      },
    },
    async ({ sessionId, button }) => {
      try {
        client.pressButton(sessionId, button)
        return ok(JSON.stringify({ pressed: true, button }))
      } catch (e) {
        return err(`press_button failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'install_app',
    {
      description: 'Install an app on the device. Requires connect_device first. Waits up to 60 seconds.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        buildId: z.number().int().describe('Build ID from the tapflow relay builds API'),
      },
    },
    async ({ sessionId, buildId }) => {
      try {
        await client.installApp(sessionId, buildId)
        return ok(JSON.stringify({ installed: true, buildId }))
      } catch (e) {
        return err(`install_app failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'launch_app',
    {
      description: 'Launch an installed app on the device. Requires connect_device first. Waits up to 15 seconds.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        buildId: z.number().int().describe('Build ID from the tapflow relay builds API'),
      },
    },
    async ({ sessionId, buildId }) => {
      try {
        await client.launchApp(sessionId, buildId)
        return ok(JSON.stringify({ launched: true, buildId }))
      } catch (e) {
        return err(`launch_app failed: ${(e as Error).message}`)
      }
    },
  )
}
