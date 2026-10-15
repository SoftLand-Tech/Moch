/** expo-image stub — images render through the desktop media path. */
import type { FC } from 'react'

export type ImageContentFit = 'cover' | 'contain' | 'fill' | 'none' | 'scale-down'

export interface ImageProps {
  source: unknown
  style?: unknown
  contentFit?: ImageContentFit
  onLoad?: () => void
  onError?: () => void
}

export const Image: FC<ImageProps> = () => {
  throw new Error('expo-image is not available on desktop — use the desktop media path')
}
