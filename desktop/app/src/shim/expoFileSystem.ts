/**
 * expo-file-system shim (both the new object API and the legacy
 * function API) plus the expo-image-manipulator surface. The shared
 * media modules import these at module scope; on desktop their CALLS are
 * replaced by fetch/blob implementations in the desktop media unit and
 * these stubs only need the module surface to exist so the real modules
 * typecheck and load. Any accidental call throws loudly.
 */
function notAvailable(name: string): never {
  throw new Error(`expo module is not available on desktop: ${name} — use the desktop media path`)
}

export class Directory {
  get uri(): string {
    return notAvailable('expo-file-system Directory.uri')
  }
  constructor(_parent: unknown, _name?: string) {}
  create(): void {
    notAvailable('Directory.create')
  }
  delete(): void {
    notAvailable('Directory.delete')
  }
  exists(): boolean {
    return false
  }
  list(): string[] {
    return notAvailable('Directory.list')
  }
}

export class File {
  get uri(): string {
    return notAvailable('expo-file-system File.uri')
  }
  constructor(_parent: unknown, _name?: string) {}
  static createDownloadTask(): { start(): void; addListener(): { remove(): void } } {
    notAvailable('File.createDownloadTask')
  }
  create(_overwrite?: boolean): void {
    notAvailable('File.create')
  }
  delete(): void {
    notAvailable('File.delete')
  }
  exists(): boolean {
    return false
  }
  text(): string {
    return notAvailable('File.text')
  }
  bytes(): Uint8Array {
    return notAvailable('File.bytes')
  }
  write(_data: string | Uint8Array): void {
    notAvailable('File.write')
  }
}

export const Paths = {
  cache: new Directory(null as unknown as string),
  document: new Directory(null as unknown as string),
}

export const EncodingType = { Base64: 'base64', UTF8: 'utf8' } as const
export const FileSystemUploadType = { MULTIPART: 1, BINARY_CONTENT: 2 } as const
export const FileSystemStoredURI = { URI: 'uri', CONTENT_URI: 'contentUri' } as const

export async function getInfoAsync(): Promise<{ exists: boolean; size: number; uri: string }> {
  return notAvailable('getInfoAsync')
}

export async function readAsStringAsync(): Promise<string> {
  return notAvailable('readAsStringAsync')
}

export async function uploadAsync(): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return notAvailable('uploadAsync')
}

export async function deleteAsync(): Promise<void> {
  return notAvailable('deleteAsync')
}

export async function moveAsync(): Promise<void> {
  return notAvailable('moveAsync')
}

export async function makeDirectoryAsync(): Promise<void> {
  return notAvailable('makeDirectoryAsync')
}

export async function readDirectoryAsync(): Promise<string[]> {
  return notAvailable('readDirectoryAsync')
}

export async function downloadAsync(): Promise<{ uri: string; status: number }> {
  return notAvailable('downloadAsync')
}

export class ImageManipulator {
  static manipulate(): ImageManipulator {
    return new ImageManipulator()
  }
  resize(): ImageManipulator {
    return this
  }
  rotate(): ImageManipulator {
    return this
  }
  async saveAsync(): Promise<{ uri: string; width: number; height: number; base64?: string }> {
    return notAvailable('ImageManipulator.saveAsync')
  }
}

export const SaveFormat = { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' } as const
