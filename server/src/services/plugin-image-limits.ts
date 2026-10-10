/**
 * Caps on the images a plugin hands a model, through `ctx.ai.complete` or
 * `ctx.chat.turn`. Measured in base64, the form a model's API receives an
 * image in; a file is three quarters of its base64 size.
 */

/**
 * One image: 10 MB of base64, about 7.5 MB of file. Claude's API refuses a
 * larger image, and a provider that resends the conversation would then fail
 * every later turn too.
 */
export const PLUGIN_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
/** All of one request's images together: 24 MB of base64, about 18 MB of files. */
export const PLUGIN_MAX_IMAGES_BASE64_BYTES = 24 * 1024 * 1024;

/** How long `bytes` bytes are once base64-encoded. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** The largest file that fits a base64 cap. */
export function fileBytesForBase64(base64Bytes: number): number {
  return Math.floor(base64Bytes / 4) * 3;
}
