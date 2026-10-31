// What a person may set on a build (#1084): its label, and a version and build number that override the values read
// from the build file. Reads go through the `builds_effective` view (migration 022), which is the one place the value
// in use is made; this file holds the write rules, so the upload and the edit cannot store the same input differently.

/** Long enough for any version string, branch name or note a person types; short enough for a row. */
export const MAX_BUILD_TEXT = 100

/** A text field as a person sent it: trimmed, with an empty value meaning "none". `false` for a value that is not
 *  text or is too long. */
export function cleanBuildText(input: unknown): string | null | false {
  if (input === null || input === undefined) return null
  if (typeof input !== 'string') return false
  const value = input.trim()
  if (value.length > MAX_BUILD_TEXT) return false
  return value || null
}

/** A label sent with an upload: like `cleanBuildText`, but cut to the bound rather than refused. Labels had no bound
 *  before #1084, and a CI job sending a commit subject would otherwise lose a whole upload to a 400 after it arrived. */
export function clampLabel(input: unknown): string | null {
  if (typeof input !== 'string') return null
  return input.trim().slice(0, MAX_BUILD_TEXT).trim() || null
}

/** The override to store: none when it says what the build file already says, so a build is marked overridden only
 *  when it shows something the file does not. */
export function overrideOf(value: string | null, fromFile: string | null): string | null {
  return value === null || value === fromFile ? null : value
}

/** A `builds_effective` row as the API returns it: the file's values gathered under `binary`. */
export function withBinary<T extends { binary_version_name: string | null; binary_build_number: string | null }>(
  row: T,
): Omit<T, 'binary_version_name' | 'binary_build_number'> & { binary: { version_name: string | null; build_number: string | null } } {
  const { binary_version_name, binary_build_number, ...rest } = row
  return { ...rest, binary: { version_name: binary_version_name, build_number: binary_build_number } }
}
