// Wire payload types come from `@tapflowio/protocol`, which owns them — this file used to declare
// its own copies and they drifted (`session:chrome` here lacked three fields `DeviceViewer` reads).
// `AgentDevice` and `DeviceInfo` were this package's names for shapes protocol calls `DeviceSummary`
// and `DeviceDetails`; the old `DeviceInfo` also collided with the relay's own `DeviceInfo`, which is
// the *other* shape. Re-exported so this module stays the one import site for view code.
import type { VideoSummary } from './runVideo'
import type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, BrowserInbound, ChromePayload, DeviceDetails, DevicePosture, DeviceSummary,
  PosturesPayload, RunResetReport, ServiceTier, SessionInfo,
} from '@tapflowio/protocol'

export type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, BrowserInbound, ChromePayload, DeviceDetails, DeviceSummary, SessionInfo,
  DevicePosture, PosturesPayload, ServiceTier,
}

export interface Comment {
  id: number
  author: string
  authorAvatarUrl: string | null
  body: string
  created_at: string
  attachments: CommentAttachment[]
}

export interface CommentAttachment {
  id: number
  file_path: string
  mime: string
}

export interface Recording {
  id: number
  url: string
  sessionId: string | null
  fileSize: number
  mime: string
  createdAt: string
  expiresAt: string
}

export interface App {
  id: number
  name: string
  /** Null for an app a merge left with builds but no ID (#1086). */
  bundle_id_key: string | null
  /** The app's bundle ID on each platform, null where it has none (#1086). */
  bundle_ids: { ios: string | null; android: string | null }
  /** The platforms the app has builds on — a platform can have builds and no ID. */
  build_platforms: Array<'ios' | 'android'>
  platform: 'ios' | 'android' | 'both'
  latest_build_id: number | null
  version_name: string | null
  build_number: string | null
  status_label: string | null
  latest_uploaded_at: string | null
}

export interface Build {
  id: number
  app_id: number
  name: string
  version_name: string | null
  build_number: string | null
  version_label: string | null
  /** What the build file says (#1084). `version_name` and `build_number` above are the values in use, which a person
   *  may have set; where they differ from these, the build is marked overridden. */
  binary: { version_name: string | null; build_number: string | null }
  status_label: 'Backlog' | 'In Progress' | 'Done' | 'Rejected' | null
  platform: 'ios' | 'android'
  bundle_id: string | null
  uploaded_at: string
  completed_at: string | null
  delete_after: string | null
  uploader: string | null
}

export interface ReleaseGroup {
  versionName: string
  builds: Build[]
}


/** A row of `GET /api/v1/tokens`. */
export interface ApiToken {
  id: number
  name: string
  scope: string
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

/** A row of `GET /api/v1/team/members`. */
export interface TeamMember {
  id: number
  email: string
  display_name: string
  role: string
  joined_at: string
}

/** `GET /api/v1/settings`: the workspace the sidebar and settings both show. */
export interface WorkspaceSettings {
  team_name: string
  logo_url: string | null
  /** Flow run videos (A4). Absent from a relay older than them. */
  video_pass_retention_days?: number
  video_storage_cap_mb?: number
  video_usage_bytes?: number
  /** The smaller of the cap and what the disk can give while keeping its floor free. */
  video_effective_cap_bytes?: number
}

/** A row of `GET /api/v1/agents/:name/resources`. */
export interface ResourcePoint {
  cpu_percent: number
  mem_percent: number
  recorded_at: string
}

/** What `tapflow flow run` recorded about one run (`/api/v1/runs`). */
export type RunStatus = 'running' | 'passed' | 'failed' | 'aborted'

export interface RunBuild {
  id: number
  appName: string | null
  versionName: string | null
  buildNumber: string | null
  platform: string | null
}

export interface RunSummary {
  id: string
  status: RunStatus
  /** `relay` when the relay closed it because the runner went away without finishing. */
  finishedBy: 'client' | 'relay' | null
  failureKind: string | null
  errorMessage: string | null
  exitCode: number | null
  isCi: boolean
  ci: { provider: string | null; branch: string | null; commit: string | null; jobUrl: string | null } | null
  /** The services the run asked its device to boot with; null when it asked for none (the agent's own setting). */
  serviceTier: ServiceTier | null
  /** What the run's device was reset of before it ran; null for a run from a runner that predates resets. A
   *  requested reset with no report is one nobody confirmed; without `booted` the run never reached a device. `cold: false` means the device was already up. */
  deviceReset: { requested: boolean; booted?: true; cold?: boolean; report?: RunResetReport; devices?: RunDevice[] } | null
  build: RunBuild | null
  createdBy: string | null
  flowsTotal: number
  createdAt: string
  finishedAt: string | null
}

/** A device the run booted, from a runner that names its sessions. The fields beside `devices` are the first one's. */
export interface RunDevice {
  sessionId: string
  deviceId?: string
  deviceName?: string
  cold?: boolean
  report?: RunResetReport
}

/** A row of `GET /api/v1/runs`. */
export interface RunListItem extends RunSummary {
  flowsPassed: number
  flowsFailed: number
  /** Flows the runner chose not to replay. */
  flowsSkipped: number
}

export interface RunStep {
  index: number
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  message?: string
  /** A failed `tapOn`'s lines to try instead, each tapping one element on the screen it failed on (B2). */
  suggestions?: { yaml: string; element: { role: string; label: string; identifier?: string } }[]
}

/**
 * A flow of a run: reported, or still to come (`running` / `pending`), or never reached (`not-run`), or one the runner
 * chose not to replay (`skipped`): another app's flow, or one the tag filters left out.
 */
export type RunFlow =
  | {
      idx: number
      name: string
      file: string | null
      status: 'running' | 'pending' | 'not-run'
      /** The device a running flow is on, when the runner said so as it started it. */
      device?: { id: string | null; name: string | null; sessionId: string }
      video?: VideoSummary | null
    }
  | {
      idx: number
      name: string
      file: string | null
      status: 'skipped'
      skipReason: 'app-mismatch' | 'tag-filter'
      /** Why, in words: "flow is for com.a, build 7 is com.b", "not tagged smoke". */
      failureMessage: string | null
      video?: VideoSummary | null
    }
  | {
      idx: number
      name: string
      file: string | null
      status: 'passed' | 'failed'
      device: { id: string; name: string | null; platform: string | null } | null
      failureKind: string | null
      failureMessage: string | null
      durationMs: number
      steps: RunStep[]
      hasScreenshot: boolean
      /** Absent from a relay older than flow videos; null when this flow has none. */
      video?: VideoSummary | null
    }

/** `GET /api/v1/runs/:id`. `watchSessionId` is the session the runner holds now, while it runs; `watchSessionIds`
 *  is every one it holds, one per device of a parallel run, and absent from a relay older than those. */
export interface RunDetail extends RunSummary {
  flows: RunFlow[]
  watchSessionId: string | null
  watchSessionIds?: string[]
}
