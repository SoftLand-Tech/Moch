/**
 * TypeScript resolution target for the platform-split MochiSurface.
 * Metro/expo NEVER bundles this file: on native it resolves
 * MochiSurface.native.tsx (react-native-webview) and on web
 * MochiSurface.web.tsx (iframe) ahead of the extension-less path. This shim
 * only makes `import { MochiSurface } from './MochiSurface'` typecheck —
 * calling it renders nothing, by design.
 */
import type { MochiSurfaceComponent } from './MochiSurfaceCommon'

export const MochiSurface = (() => null) as unknown as MochiSurfaceComponent

export type { MochiSurfaceProps, MochiSurfaceHandle } from './MochiSurfaceCommon'
