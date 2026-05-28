import * as z from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TapflowClient } from './client.js'

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
      description: 'Type text into the focused input field.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        text: z.string().describe('Text to type'),
      },
    },
    async ({ sessionId, text }) => {
      try {
        client.typeText(sessionId, text)
        return ok(JSON.stringify({ typed: true, text }))
      } catch (e) {
        return err(`type_text failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    'press_key',
    {
      description: 'Press a keyboard key (e.g. "Return", "Delete", "Escape").',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        key: z.string().describe('Key name (e.g. "Return", "Delete", "Escape")'),
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
      description: 'Press a hardware button (e.g. "home", "lock").',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        button: z.string().describe('Button name (e.g. "home", "lock")'),
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
